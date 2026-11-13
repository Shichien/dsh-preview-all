import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as zlib from 'node:zlib'
import { ArchiveError, DEFAULT_ENTRY_COUNT, listArchive, readArchiveEntry, readZipMember } from '../lib/formats/archive/zip.js'

const ITEMS = [['first.txt', 'first member\n'], ['nested/second.txt', 'second member differs\n']]

function makeTar() {
  const parts = ITEMS.flatMap(([name, text]) => {
    const header = Buffer.alloc(512)
    const body = Buffer.from(text)
    header.write(name)
    header.write('0000644\0', 100)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.fill(0x20, 148, 156)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
    body.copy(padded)
    return [header, padded]
  })
  return Buffer.concat([...parts, Buffer.alloc(1024)])
}

// Standard-library Python tarfile USTAR output compressed with bz2/lzma.
// Both fixtures contain ITEMS, so extraction must distinguish two member offsets.
const COMPRESSED_TARS = {
  bz2: 'QlpoOTFBWSZTWSfcsUsAAJbfgMrQQAH/gAAAgIB/I55ASAggAJSEqZTJpNpMjDImJkyYJJRMajaCDAADUhwTkTDOYAG8JIQ83Kxwe/jz0OEIYBn/lFqzET0TgxwgMJSmGE0a1stRK2kVGrKgegeTY1NxLLRzjU2em/WkWkCBwdcnI5lJnDhT+SQPqOyBYWiQfxdyRThQkCfcsUs=',
  xz: '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AJVdADMaSqwMcyl56jsEt7/m5qYFDPyIuxe6qq+8fuSuqej46/myVy5YIxcZZoJZ/fpp0JjNDbRsept4u7mOkjD8W8tSnUPY3xIQBs+X8z7umvw1FI57fCvUH4UqnD+YNf6lWsCj3LRXiGvn85d27t0yG+5ZfJ+SoyzO6I9DJO23v0EiDomiTFpkYzXYVSXAULhWrAsyBeoAAAAAAGa1Y+DY7lyIAAGxAYBQAAA2pUauscRn+wIAAAAABFla',
}

function assertMembers(bytes, filename, format) {
  const listed = listArchive(bytes, filename)
  assert.equal(listed.format, format)
  assert.deepEqual(listed.entries.map((entry) => entry.name), ITEMS.map(([name]) => name))
  for (const [index, entry] of listed.entries.entries()) {
    assert.equal(Buffer.from(readArchiveEntry(bytes, filename, entry)).toString(), ITEMS[index][1])
  }
  assert.throws(() => readArchiveEntry(bytes, filename, listed.entries[1], { maxBytes: 1 }),
    (error) => error instanceof ArchiveError && error.code === 'too-large')
}

for (const filename of ['sample.tar', 'sample.bin', 'sample.zip', 'sample.gz', 'sample.tar.gz']) {
  test(`magic-detected TAR lists and extracts consistently as ${filename}`, () => {
    assertMembers(makeTar(), filename, 'tar')
  })
}

for (const filename of ['sample.gz', 'sample.tar.gz', 'sample.tgz']) {
  test(`gzip TAR extracts member bodies as ${filename}`, () => {
    assertMembers(zlib.gzipSync(makeTar()), filename, 'tar.gzip')
  })
}

for (const [suffix, base64] of Object.entries(COMPRESSED_TARS)) {
  for (const filename of [`sample.${suffix}`, `sample.tar.${suffix}`]) {
    test(`compressed TAR extracts member bodies as ${filename}`, () => {
      assertMembers(Buffer.from(base64, 'base64'), filename, `tar.${suffix === 'bz2' ? 'bzip2' : 'xz'}`)
    })
  }
}

test('bare gzip remains a single stream and enforces decompression limits', () => {
  const payload = Buffer.from('a plain compressed document')
  const bytes = zlib.gzipSync(payload)
  const listed = listArchive(bytes, 'document.txt.gz')
  assert.equal(listed.format, 'gzip')
  assert.equal(listed.entries[0].name, 'document.txt')
  assert.deepEqual(Buffer.from(readArchiveEntry(bytes, 'document.txt.gz', listed.entries[0])), payload)
  assert.throws(() => listArchive(bytes, 'document.txt.gz', { maxOutputBytes: 5 }), { code: 'too-large' })
  const tar = zlib.gzipSync(makeTar())
  const entry = listArchive(tar, 'sample.gz').entries[1]
  assert.throws(() => readArchiveEntry(tar, 'sample.gz', entry, { maxOutputBytes: 512 }), { code: 'too-large' })
})

/** A stored ZIP with empty members; an optional prefix exercises suffix dispatch. */
function makeZip(count, prefix = Buffer.alloc(0)) {
  const locals = [prefix]
  const central = []
  let offset = prefix.length
  for (let index = 0; index < count; index++) {
    const name = Buffer.from(`entry-${index}.txt`)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(name.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    locals.push(local, name)
    central.push(record, name)
    offset += local.length + name.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

for (const prefix of [Buffer.alloc(0), Buffer.from('self-extracting prefix')]) {
  test(`ZIP maxEntries bounds listing via ${prefix.length ? 'suffix' : 'magic'} dispatch`, () => {
    const bytes = makeZip(3, prefix)
    const filename = prefix.length ? 'sample.zip' : 'sample.bin'
    for (const maxEntries of [0, 1, 2]) {
      const listed = listArchive(bytes, filename, { maxEntries })
      assert.equal(listed.entries.length, maxEntries)
      assert.equal(listed.note, `listing truncated at ${maxEntries} entries`)
      assert.deepEqual(listed.entries.map((entry) => entry.name), Array.from({ length: maxEntries }, (_, index) => `entry-${index}.txt`))
    }
    for (const maxEntries of [3, 4]) {
      const listed = listArchive(bytes, filename, { maxEntries })
      assert.equal(listed.entries.length, 3)
      assert.equal(listed.note, undefined)
      assert.equal(readArchiveEntry(bytes, filename, listed.entries[2]).length, 0)
    }
    assert.equal(listArchive(makeZip(0), 'empty.zip', { maxEntries: 0 }).note, undefined)
  })
}

test('ZIP default count limit does not restrict direct member lookup', () => {
  const bytes = makeZip(DEFAULT_ENTRY_COUNT + 1)
  const listed = listArchive(bytes, 'many.zip')
  assert.equal(listed.entries.length, DEFAULT_ENTRY_COUNT)
  assert.equal(listed.note, `listing truncated at ${DEFAULT_ENTRY_COUNT} entries`)
  assert.equal(readZipMember(bytes, `ENTRY-${DEFAULT_ENTRY_COUNT}.TXT`).length, 0)
})

test('zstd TAR and bare streams work when the runtime supports zstd', {
  skip: typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function',
}, () => {
  assertMembers(zlib.zstdCompressSync(makeTar()), 'sample.zst', 'tar.zstd')
  const bytes = zlib.zstdCompressSync(Buffer.from('zstd text'))
  const entry = listArchive(bytes, 'sample.zst').entries[0]
  assert.equal(Buffer.from(readArchiveEntry(bytes, 'sample.zst', entry)).toString(), 'zstd text')
})

test('missing zstd export does not prevent imports or other archive formats', () => {
  // Model Node 20's actual ESM export surface, rather than setting an existing
  // export to undefined: a static named zstd import must fail this regression.
  const replacement = `
    import { createRequire } from 'node:module';
    const zlib = createRequire(${JSON.stringify(import.meta.url)})('node:zlib');
    export const inflateRawSync = zlib.inflateRawSync;
    export const gunzipSync = zlib.gunzipSync;
  `
  const loader = `
    export async function load(url, context, nextLoad) {
      if (url === 'node:zlib') return { format: 'module', source: ${JSON.stringify(replacement)}, shortCircuit: true };
      return nextLoad(url, context);
    }
  `
  const script = `
    import assert from 'node:assert/strict';
    const { listArchive, readArchiveEntry, ArchiveError } = await import(${JSON.stringify(new URL('../lib/formats/archive/zip.js', import.meta.url).href)});
    const bytes = Buffer.from(${JSON.stringify(zlib.gzipSync(Buffer.from('still works')).toString('base64'))}, 'base64');
    const entry = listArchive(bytes, 'sample.gz').entries[0];
    assert.equal(Buffer.from(readArchiveEntry(bytes, 'sample.gz', entry)).toString(), 'still works');
    for (const filename of ['sample.zst', 'sample.tar.zst']) {
      assert.throws(() => listArchive(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), filename),
        error => error instanceof ArchiveError && error.code === 'unsupported' && /zstd/.test(error.message));
    }
    assert.throws(() => readArchiveEntry(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 'sample.zst', { size: 1 }), { code: 'unsupported' });
  `
  const result = spawnSync(process.execPath, ['--experimental-loader', `data:text/javascript,${encodeURIComponent(loader)}`, '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 20000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
})
