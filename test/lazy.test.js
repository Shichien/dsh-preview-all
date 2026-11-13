// On-demand loading and bounded memory on the Host.
//
// This file runs in its own process, so it can observe which format modules
// have been imported. The filesystem stub is virtual: a file is a size plus a
// few real byte segments with zeros in between, which lets a 1 GiB archive
// exist without a 1 GiB buffer and makes every byte read countable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { apply, ROUTE, loadedKinds } from '../lib/index.js'
import { createGate } from '../lib/shared/gate.js'
import { readCapped } from '../lib/shared/fs.js'
import { stopWorker } from '../lib/shared/offload.js'
import { listArchive, readArchiveEntry } from '../lib/formats/archive/zip.js'
import { listZipRanged, readZipEntryRanged } from '../lib/formats/archive/zip.js'

const GIB = 1024 * 1024 * 1024

/**
 * Lay out a ZIP. A member is `{ name, data }`, or `{ name, virtualSize }` for a
 * stored member whose bytes are zeros that are never materialised.
 * @returns {{ size: number, segments: { offset: number, bytes: Buffer }[] }}
 */
function layoutZip(members, { comment = Buffer.alloc(0) } = {}) {
  const segments = []
  const centrals = []
  let offset = 0
  for (const member of members) {
    const name = Buffer.from(member.name)
    const virtual = member.virtualSize !== undefined
    const packed = virtual ? undefined : deflateRawSync(member.data)
    const packedSize = virtual ? member.virtualSize : packed.length
    const size = virtual ? member.virtualSize : member.data.length
    const method = virtual ? 0 : 8
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(packedSize, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(packedSize, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    segments.push({ offset, bytes: virtual ? Buffer.concat([local, name]) : Buffer.concat([local, name, packed]) })
    centrals.push(central, name)
    offset += local.length + name.length + packedSize
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(members.length, 8)
  eocd.writeUInt16LE(members.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(comment.length, 20)
  const tail = Buffer.concat([directory, eocd, comment])
  segments.push({ offset, bytes: tail })
  return { size: offset + tail.length, segments }
}

/** Copy `[offset, offset + length)` of a virtual file into a fresh buffer. */
function sliceOf(file, offset, length) {
  const out = Buffer.alloc(Math.max(0, Math.min(length, file.size - offset)))
  for (const segment of file.segments) {
    const from = Math.max(offset, segment.offset)
    const to = Math.min(offset + out.length, segment.offset + segment.bytes.length)
    if (from < to) segment.bytes.copy(out, from - offset, from - segment.offset, to - segment.offset)
  }
  return out
}

const wholeOf = (file) => sliceOf(file, 0, file.size)
const plain = (bytes) => ({ size: bytes.length, segments: [{ offset: 0, bytes }] })

/** A minimal ustar archive with one member. */
function makeTar(name, body) {
  const header = Buffer.alloc(512)
  header.write(name, 0)
  header.write('0000644\0', 100)
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return Buffer.concat([header, padded, Buffer.alloc(1024)])
}

const readme = Buffer.from('inside a very large archive\n')
const packed = randomBytes(64 * 1024)
const files = new Map([
  ['/v/clip.mp4', plain(Buffer.alloc(4096, 7))],
  ['/v/notes.txt', plain(Buffer.from('plain text, claimed by no format'))],
  ['/v/huge.zip', layoutZip([
    { name: 'big.bin', virtualSize: GIB },
    { name: 'docs/readme.txt', data: readme },
  ])],
  ['/v/one.tar', plain(makeTar('a.txt', Buffer.from('first')))],
  ['/v/two.tar', plain(makeTar('b.txt', Buffer.from('second')))],
  // Random bytes do not compress, so these stay well above the 512-byte head probe.
  ['/v/pack.tar.gz', plain(gzipSync(makeTar('c.bin', packed)))],
  ['/v/log.txt.gz', plain(gzipSync(Buffer.concat([Buffer.from('a log line\n'), packed])))],
])
/** Bumped when a test rewrites a file, as the real service's version token would change. */
const revisions = new Map()

// `busyPeak`: the most files that were being read at the same moment.
const reads = { rangedBytes: 0, busy: new Map(), busyPeak: 0 }
const fs = {
  async resolve(path) {
    return { targetKey: path, displayPath: path }
  },
  async stat(target) {
    const file = files.get(target.targetKey)
    return file === undefined ? undefined : { type: 'file', size: file.size, version: `${revisions.get(target.targetKey) ?? 1}:${file.size}` }
  },
  async readByteRange(target, { offset, length }) {
    const key = target.targetKey
    reads.busy.set(key, (reads.busy.get(key) ?? 0) + 1)
    reads.busyPeak = Math.max(reads.busyPeak, reads.busy.size)
    try {
      // A buffered archive reads slowly, so a second request has the chance to overlap.
      if (key.endsWith('.tar')) await new Promise((resolve) => setTimeout(resolve, 25))
      const bytes = sliceOf(files.get(key), offset, length)
      reads.rangedBytes += bytes.length
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)
    } finally {
      if (reads.busy.get(key) === 1) reads.busy.delete(key)
      else reads.busy.set(key, reads.busy.get(key) - 1)
    }
  },
  // Nothing may read a file whole through the service: it would hold the file twice.
  async readBytes() {
    throw new Error('readBytes must not be used')
  },
}

let route
apply({
  effect: (fn) => fn(),
  get: () => undefined,
  logger: { warn() {}, info() {} },
  webServer: { register: (registration) => { route = registration; return () => {} } },
  connection: { requestRejection: () => undefined },
  fs,
  sessions: { get: () => undefined },
  sandboxPolicy: { workspaceRoot: '/v' },
})

const server = createServer((req, res) => route.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = (action, path, extra = '') =>
  `http://127.0.0.1:${server.address().port}${ROUTE}/${action}?path=${encodeURIComponent(path)}${extra}`
test.after(() => { server.close(); stopWorker() })

test('format modules load on first use, not when the plugin starts', async () => {
  assert.deepEqual(loadedKinds(), [], 'registering the routes must not import a parser')

  const info = await (await fetch(url('info', '/v/clip.mp4'))).json()
  assert.equal(info.kind, 'media')
  assert.deepEqual(loadedKinds(), ['media'], 'a video loads the media module and nothing else')

  // Downloading a file no format claims is answered from the light tables.
  const download = await fetch(url('download', '/v/notes.txt'))
  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'plain text, claimed by no format')
  assert.deepEqual(loadedKinds(), ['media'])

  // Hitting a format route directly loads its owner.
  assert.equal((await fetch(url('entry', '/v/one.tar', '&entry=a.txt'))).status, 200)
  assert.deepEqual(loadedKinds(), ['media', 'archive'])
})

test('a 1 GiB ZIP is listed and extracted through byte ranges', async () => {
  const before = { ...reads }
  const info = await (await fetch(url('info', '/v/huge.zip'))).json()
  assert.equal(info.kind, 'archive')
  assert.equal(info.archive.format, 'zip')
  assert.deepEqual(info.archive.entries.map((entry) => [entry.name, entry.size, entry.previewable]), [
    ['big.bin', GIB, false],
    ['docs/readme.txt', readme.length, true],
  ])
  assert.ok(reads.rangedBytes - before.rangedBytes < 256 * 1024, `listing read ${reads.rangedBytes - before.rangedBytes} bytes`)

  const mark = reads.rangedBytes
  const member = await fetch(url('entry', '/v/huge.zip', '&entry=docs%2Freadme.txt'))
  assert.equal(member.status, 200)
  assert.equal(await member.text(), readme.toString())
  assert.ok(reads.rangedBytes - mark < 256 * 1024, `extraction read ${reads.rangedBytes - mark} bytes`)

  // The oversized member is refused before any of its bytes are read.
  const refused = reads.rangedBytes
  assert.equal((await fetch(url('entry', '/v/huge.zip', '&entry=big.bin'))).status, 413)
  assert.ok(reads.rangedBytes - refused < 256 * 1024)
  assert.equal((await fetch(url('entry', '/v/huge.zip', '&entry=missing.txt'))).status, 404)
})

test('archives that must be buffered are parsed one at a time', async () => {
  reads.busyPeak = 0
  const [one, two] = await Promise.all([
    fetch(url('info', '/v/one.tar')).then((res) => res.json()),
    fetch(url('info', '/v/two.tar')).then((res) => res.json()),
  ])
  assert.deepEqual(one.archive.entries.map((entry) => entry.name), ['a.txt'])
  assert.deepEqual(two.archive.entries.map((entry) => entry.name), ['b.txt'])
  assert.equal(reads.busyPeak, 1, 'two archives were being read at once')
})

test('ranged ZIP access agrees with the in-memory parser', async () => {
  const members = [
    { name: 'a.txt', data: Buffer.from('alpha') },
    { name: 'dir/b.json', data: Buffer.from('{"b":true}'.repeat(200)) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]
  // A long comment pushes the directory out of the first tail read's reach only
  // when the tail is small, so exercise both a commented and a plain archive.
  for (const comment of [Buffer.alloc(0), Buffer.alloc(40000, 0x2e)]) {
    const file = layoutZip(members, { comment })
    const bytes = wholeOf(file)
    const read = async (offset, length) => new Uint8Array(sliceOf(file, offset, length))
    const whole = listArchive(bytes, 'sample.zip')
    const ranged = await listZipRanged(read, file.size)
    assert.deepEqual(ranged, whole)
    for (const entry of ranged.entries) {
      assert.deepEqual(
        Buffer.from(await readZipEntryRanged(read, entry)),
        Buffer.from(readArchiveEntry(bytes, 'sample.zip', entry)),
      )
    }
    const capped = await listZipRanged(read, file.size, { maxEntries: 2 })
    assert.equal(capped.entries.length, 2)
    assert.equal(capped.note, 'listing truncated at 2 entries')
  }
  await assert.rejects(listZipRanged(async () => new Uint8Array(8), 8), { code: 'invalid' })
  const file = layoutZip(members)
  const read = async (offset, length) => new Uint8Array(sliceOf(file, offset, length))
  const [entry] = (await listZipRanged(read, file.size)).entries
  await assert.rejects(readZipEntryRanged(read, { ...entry, size: 10 }, { maxBytes: 4 }), { code: 'too-large' })
  await assert.rejects(readZipEntryRanged(read, { ...entry, offset: 3 }), { code: 'invalid' })
})

test('the gate runs tasks in order, bounded, and survives failures and aborts', async () => {
  const gate = createGate(1)
  const log = []
  let release
  const first = gate(undefined, () => new Promise((resolve) => { log.push('first in'); release = resolve }))
  const second = gate(undefined, async () => { log.push('second in') })
  const aborter = new AbortController()
  const third = gate(aborter.signal, async () => { log.push('third in') })
  const fourth = gate(undefined, async () => { throw new Error('boom') })
  const fifth = gate(undefined, async () => { log.push('fifth in'); return 5 })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(log, ['first in'], 'only one task may hold the gate')
  aborter.abort(new Error('gone'))
  await assert.rejects(third, /gone/)
  release()
  await first
  await second
  await assert.rejects(fourth, /boom/)
  assert.equal(await fifth, 5)
  assert.deepEqual(log, ['first in', 'second in', 'fifth in'], 'the aborted task never ran; a failure released the gate')

  const already = new AbortController()
  already.abort(new Error('early'))
  await assert.rejects(gate(already.signal, async () => log.push('never')), /early/)
  assert.ok(!log.includes('never'))
})

test('a small compressed archive is read once; its members then come from the worker', async () => {
  const path = '/v/pack.tar.gz'
  const info = await (await fetch(url('info', path))).json()
  assert.deepEqual(info.archive.entries.map((entry) => entry.name), ['c.bin'])

  // Two members opened after the listing: only the 512-byte head probe is read each time.
  const mark = reads.rangedBytes
  for (let round = 0; round < 2; round++) {
    const member = await fetch(url('entry', path, '&entry=c.bin'))
    assert.equal(member.status, 200)
    assert.ok(Buffer.from(await member.arrayBuffer()).equals(packed), 'the kept archive must stay intact between reads')
  }
  assert.equal(reads.rangedBytes - mark, 2 * 512, 'the archive was read again')
  assert.equal((await fetch(url('entry', path, '&entry=missing'))).status, 404)

  // The file changes on disk: its version changes, and the kept copy is not used.
  const rewritten = randomBytes(64 * 1024)
  files.set(path, plain(gzipSync(makeTar('c.bin', rewritten))))
  revisions.set(path, 2)
  const before = reads.rangedBytes
  const fresh = await fetch(url('entry', path, '&entry=c.bin'))
  assert.ok(Buffer.from(await fresh.arrayBuffer()).equals(rewritten), 'the answer must come from the file as it is now')
  assert.ok(reads.rangedBytes - before >= files.get(path).size, 'a changed archive must be read again')
})

test('a bare compressed stream answers the same bytes every time', async () => {
  // Its one member is the whole expanded buffer, the case where handing the
  // answer over without a copy would empty what the worker kept.
  const path = '/v/log.txt.gz'
  const info = await (await fetch(url('info', path))).json()
  assert.equal(info.kind, 'archive')
  const [entry] = info.archive.entries
  const expected = Buffer.concat([Buffer.from('a log line\n'), packed])
  for (let round = 0; round < 3; round++) {
    const member = await fetch(url('entry', path, `&entry=${encodeURIComponent(entry.name)}`))
    assert.equal(member.status, 200)
    assert.ok(Buffer.from(await member.arrayBuffer()).equals(expected), `round ${round}: the stream's bytes changed`)
  }
})

test('a whole file is read window by window into a buffer of its own', async () => {
  const MIB = 1024 * 1024
  const data = randomBytes(9 * MIB + 123)
  const windows = []
  const from = (source) => ({
    fs: {
      async readByteRange(_target, { offset, length }) {
        windows.push(length)
        return source.subarray(offset, offset + length)
      },
    },
  })
  const bytes = await readCapped(from(data), {}, data.length, 16 * MIB, undefined, 'file')
  assert.ok(Buffer.from(bytes.buffer).equals(data), 'the buffer holds exactly the file')
  assert.equal(bytes.byteOffset, 0)
  assert.deepEqual(windows, [4 * MIB, 4 * MIB, MIB + 123], 'no window larger than 4 MiB')

  // Over the cap: refused before anything is read.
  windows.length = 0
  await assert.rejects(readCapped(from(data), {}, data.length, MIB, undefined, 'file'), { status: 413 })
  assert.deepEqual(windows, [])

  // The file shrank after it was measured: what is there comes back, nothing invented.
  const shrunk = await readCapped(from(data.subarray(0, 5 * MIB)), {}, data.length, 16 * MIB, undefined, 'file')
  assert.ok(Buffer.from(shrunk).equals(data.subarray(0, 5 * MIB)))

  // A closed tab stops the read at the next window.
  windows.length = 0
  const closing = new AbortController()
  const slow = from(data)
  const read = slow.fs.readByteRange
  slow.fs.readByteRange = async (...args) => { const piece = await read(...args); closing.abort(new Error('tab closed')); return piece }
  await assert.rejects(readCapped(slow, {}, data.length, 16 * MIB, closing.signal, 'file'), /tab closed/)
  assert.equal(windows.length, 1)
})
