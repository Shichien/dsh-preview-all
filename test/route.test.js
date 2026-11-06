// Drives the host routes over a real HTTP server with stub services: the
// filesystem stub reads through node:fs the way the local backend does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { apply, ROUTE } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'preview-all-in-one-'))
const media = Buffer.alloc(3 * 1024 * 1024 + 123)
for (let i = 0; i < media.length; i++) media[i] = i % 251
writeFileSync(join(dir, 'clip.mp4'), media)
writeFileSync(join(dir, 'secret.txt'), 'no')
writeFileSync(join(dir, 'notes.rtf'), '{\\rtf1\\ansi Hello \\b bold\\b0 world.}')

/** A stored+deflated ZIP holding one text file and one PNG. */
function buildZip() {
  const members = [
    { name: 'readme.txt', data: Buffer.from('inside the archive\n') },
    { name: 'pixel.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  ]
  const locals = []
  const centrals = []
  let offset = 0
  for (const member of members) {
    const packed = deflateRawSync(member.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(member.data.length, 22)
    local.writeUInt16LE(Buffer.byteLength(member.name), 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(member.data.length, 24)
    central.writeUInt16LE(Buffer.byteLength(member.name), 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, Buffer.from(member.name), packed)
    centrals.push(central, Buffer.from(member.name))
    offset += local.length + Buffer.byteLength(member.name) + packed.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(members.length, 8)
  eocd.writeUInt16LE(members.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}
writeFileSync(join(dir, 'bundle.zip'), buildZip())
/** A minimal but real PE32 header: MZ stub, `e_lfanew` at 0x3c, COFF + optional header. */
function buildPe() {
  const buf = Buffer.alloc(0x200)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write('PE\0\0', 0x80, 'latin1')
  const coff = 0x84
  buf.writeUInt16LE(0x014c, coff) // machine: x86
  buf.writeUInt16LE(0, coff + 2) // no sections
  buf.writeUInt16LE(0xe0, coff + 16) // optional header size
  buf.writeUInt16LE(0x0102, coff + 18) // executable image, 32-bit
  const optional = coff + 20
  buf.writeUInt16LE(0x10b, optional) // PE32
  buf.writeUInt32LE(0x1000, optional + 16) // entry point
  buf.writeUInt32LE(0x400000, optional + 28) // image base
  buf.writeUInt32LE(0x4000, optional + 56) // size of image
  buf.writeUInt16LE(3, optional + 68) // console subsystem
  return buf
}
writeFileSync(join(dir, 'tool.exe'), buildPe())
// A HEIC container is handed to the browser untouched, so the bytes need no
// validity here — only the content type does.
writeFileSync(join(dir, 'photo.heic'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1')]))

let route
let authorized = true
let failRead = false
const warnings = []
const fs = {
  async resolve(path, { cwd }) {
    const abs = isAbsolute(path) ? path : resolve(cwd, path)
    return { targetKey: abs, displayPath: abs }
  },
  async stat(target) {
    if (failRead) throw new Error('disk unavailable')
    try {
      const s = await stat(target.targetKey)
      return { type: s.isFile() ? 'file' : 'directory', size: s.size, version: String(s.mtimeMs) }
    } catch {
      return undefined
    }
  },
  async readByteRange(target, { offset, length }) {
    const handle = await open(target.targetKey, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, offset)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    } finally {
      await handle.close()
    }
  },
  async readBytes(target, _signal, maxBytes) {
    const handle = await open(target.targetKey, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    } finally {
      await handle.close()
    }
  },
}
const ctx = {
  effect: (fn) => fn(),
  get: () => undefined,
  // Same shape as the host's logger: an object with level methods.
  logger: { warn: (value) => warnings.push(value), info() {} },
  webServer: { register: (r) => { route = r; return () => {} } },
  connection: { requestRejection: () => (authorized ? undefined : 401) },
  fs,
  sessions: { get: (id) => (id === 's1' ? { header: { cwd: dir } } : undefined) },
  sandboxPolicy: { workspaceRoot: dir },
}
apply(ctx)

const server = createServer((req, res) => route.handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const url = (action, path, session = 's1', extra = '') =>
  `${origin}${ROUTE}/${action}?sessionId=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}${extra}`

test.after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

test('registers one prefix route', () => {
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE)
})

test('full GET streams every byte across windows', async () => {
  const res = await fetch(url('stream', 'clip.mp4'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.equal(res.headers.get('content-length'), String(media.length))
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(media))
})

test('Range GET answers 206 with the exact slice', async () => {
  const start = 1024 * 1024 - 7
  const end = 2 * 1024 * 1024 + 9
  const res = await fetch(url('stream', 'clip.mp4'), { headers: { range: `bytes=${start}-${end}` } })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${media.length}`)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(media.subarray(start, end + 1)))
})

test('absolute paths and HEAD', async () => {
  const res = await fetch(url('stream', join(dir, 'clip.mp4')), { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), String(media.length))
})

test('unsatisfiable range answers 416', async () => {
  const res = await fetch(url('stream', 'clip.mp4'), { headers: { range: `bytes=${media.length}-` } })
  assert.equal(res.status, 416)
  assert.equal(res.headers.get('content-range'), `bytes */${media.length}`)
})

test('download=1 adds an attachment disposition', async () => {
  const res = await fetch(url('stream', 'clip.mp4', 's1', '&download=1'), { method: 'HEAD' })
  assert.match(res.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''clip\.mp4$/)
})

test('info describes a media file', async () => {
  const res = await fetch(url('info', 'clip.mp4'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.kind, 'media')
  assert.equal(body.media.kind, 'video')
  assert.equal(body.media.type, 'video/mp4')
  assert.equal(body.media.playable, true)
  assert.equal(body.size, media.length)
  assert.equal(body.name, 'clip.mp4')
})

test('info lists archive entries', async () => {
  const body = await (await fetch(url('info', 'bundle.zip'))).json()
  assert.equal(body.kind, 'archive')
  assert.equal(body.archive.format, 'zip')
  assert.deepEqual(body.archive.entries.map((entry) => entry.name), ['readme.txt', 'pixel.png'])
  assert.equal(body.archive.entries[0].previewable, true)
  assert.equal(body.archive.entries[1].image, true)
})

test('entry extracts one archive member', async () => {
  const res = await fetch(url('entry', 'bundle.zip', 's1', '&entry=readme.txt'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(await res.text(), 'inside the archive\n')
  assert.equal((await fetch(url('entry', 'bundle.zip', 's1', '&entry=nope.txt'))).status, 404)
  assert.equal((await fetch(url('entry', 'bundle.zip'))).status, 400)
})

test('info renders a document to HTML', async () => {
  const body = await (await fetch(url('info', 'notes.rtf'))).json()
  assert.equal(body.kind, 'document')
  assert.match(body.document.html, /Hello/)
  assert.match(body.document.html, /<strong>bold<\/strong>/)
})

test('info sniffs an opaque binary and dumps its head', async () => {
  const body = await (await fetch(url('info', 'tool.exe'))).json()
  assert.equal(body.kind, 'binary')
  assert.match(body.binary.summary, /Windows PE executable \(x86, console\)/)
  assert.match(body.hex, /^00000000 {2}4d 5a 00 00/)
})

test('info answers every claimed kind', async () => {
  const kinds = {}
  for (const name of ['clip.mp4', 'bundle.zip', 'notes.rtf', 'tool.exe', 'photo.heic']) {
    kinds[name] = (await (await fetch(url('info', name))).json()).kind
  }
  assert.deepEqual(kinds, {
    'clip.mp4': 'media',
    'bundle.zip': 'archive',
    'notes.rtf': 'document',
    'tool.exe': 'binary',
    'photo.heic': 'picture',
  })
})

test('picture serves the container with its own content type', async () => {
  const res = await fetch(url('picture', 'photo.heic'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/heic')
  assert.equal(res.headers.get('content-length'), String(12))
})

test('download hands back the original bytes as an attachment', async () => {
  const res = await fetch(url('download', 'bundle.zip'))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''bundle\.zip$/)
  const body = Buffer.from(await res.arrayBuffer())
  assert.equal(body.length, (await stat(join(dir, 'bundle.zip'))).size)
  // A document panel shows HTML; the download must still be the RTF itself.
  const rtf = await fetch(url('download', 'notes.rtf'))
  assert.equal(rtf.headers.get('content-type'), 'application/octet-stream')
  assert.match(await rtf.text(), /^\{\\rtf1/)
})

test('an unexpected filesystem failure answers 500 and is logged', async () => {
  failRead = true
  try {
    const res = await fetch(url('stream', 'clip.mp4'), { signal: AbortSignal.timeout(3000) })
    assert.equal(res.status, 500)
  } finally {
    failRead = false
  }
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0]), /disk unavailable/)
})

test('refusals', async () => {
  assert.equal((await fetch(url('stream', 'secret.txt'))).status, 415)
  assert.equal((await fetch(url('stream', 'missing.mp4'))).status, 404)
  assert.equal((await fetch(`${origin}${ROUTE}/stream?path=clip.mp4`)).status, 400)
  assert.equal((await fetch(`${origin}${ROUTE}/nope?sessionId=s1&path=clip.mp4`)).status, 404)
  assert.equal((await fetch(`${origin}${ROUTE}?sessionId=s1&path=clip.mp4`)).status, 404)
  assert.equal((await fetch(url('stream', 'clip.mp4'), { method: 'POST' })).status, 405)
  authorized = false
  try {
    assert.equal((await fetch(url('stream', 'clip.mp4'))).status, 401)
  } finally {
    authorized = true
  }
})
