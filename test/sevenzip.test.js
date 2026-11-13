import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { list7zRar, SevenZipError } from '../lib/formats/archive/sevenzip.js'

// Real 7z archives built with py7zr at authoring time, embedded as base64 so the
// suite needs no fixture files. All of them hold the same five entries:
//   docs/readme.txt (14 bytes), 文档.txt (13), empty.txt (0), data.bin (1500),
//   and the folder docs. Every entry carries an mtime of 2021-03-03T21:06:08Z.

/** py7zr's default output: LZMA2 entry data, LZMA2-compressed next header. */
const LZMA2_HEADER = 'N3q8ryccAATrCzW4uwEAAAAAAAAXAAAAAAAAAHuO9VLgBfYBF10ANBlJ7o3pEYjG1Iedra76Wkh9f0IjQnkRpld5ZG651rIHVk6VegWDkbyshLRqGdNVjzW9hWwVowQQSbn9MgFUI4I/BbMLw6F4JQwsgRJ6CsiXWFeeP7rYhxtQttlhh2TQHxvOpvozlPGBXNoMfv4RF2QmmpkERZqZN5c7mnnZRqwxuDXoroJ7zzS8sLSNvl1E9e4fq+zHkCq0HVJzLZP6fMMjsPlkg9mUN4fuqU8Gpi7R2myrbgtQd1F2Nf2USKgUcA/nYpJBbJYezcNScfR3upR7GmV3dUWI4utuw6ZjAB3uGaoDB/G6VhChoWARFxSe3+hE57psZZ7UdMn/fKHLZh18kNG4z9poiDEvHfJ16deHiSqLn8cAAOAA4gCUXQAAgTMHrg/VOIGs+cZm2o3z7dDuG8bC075Vyry0VHyERKy2PgIZXScPi0IhbXcQjPSC6Xuo4/32CUD/r/Jnbi0x3R6T5qH74/Qi0bPb59zxE+pAaD8qLj6fXxf8IbgISLcMgB+OyK9c32RHM2p0KVFAsO9ansoyU2iw/5Nebdo2po0Zr+H/JbVrJs+xsnXqpW2vAAAAABcGgR8BCYCcAAcLAQABISEBGAyA4wAA'
/** A next header left uncompressed (Copy coder), so it starts with 0x01. */
const STORED_HEADER = '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'
/** A next header compressed with real liblzma LZMA1 (coder 030101). */
const LZMA_HEADER = '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'
/** Same container as LZMA_HEADER but the coder id is Deflate, which is bogus. */
const BAD_CODER = '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'

/**
 * Two empty folders and two empty files, interleaved. `kEmptyFile` is indexed
 * by the position among empty streams rather than by file index, so this
 * fixture only lists correctly if that indexing is right.
 */
const EMPTIES = 'N3q8ryccAAQqVwCgdgAAAAAAAAAVAAAAAAAAAMSS7+gA4ACwAG1dAACBMweuD81+iOcyzNtePaSPcAtYCndLmwkp+2HV7cqv8nWRCfcMVzc4Be5z+6v0vNRTZ3+/hPbwTWyX/R7n1OTORPxmPW2u5p4AnJT7ZpK1kSZdGeokDAFkCZTXXMp7Wv6YuCC+zhuvJh9HAAAAFwYBAQl1AAcLAQABISEBGAyAsQAA'

/** An archive with no entries at all, as py7zr writes it. */
const EMPTY_ARCHIVE = 'N3q8ryccAASEhya9BgAAAAAAAAAUAAAAAAAAAELRML8BAAEBAAAXBgABCQYABwsBAAEhIQEYDAIAAA=='
/** Entry data encrypted with a password, header left readable. */
const ENCRYPTED_DATA = 'N3q8ryccAAQgAluSlAAAAAAAAAAUAAAAAAAAADxaowwmljV7Te0BJpPb+4kFZNbMZeK1FEu4xbtIEthPVfshVeAAbgBsXQAAgTMHrg/QDv4UqMPSyEk/D5+yjWCZtB7Nz+fP2hTeRunK9aCyvih6TkIyhL0RwLSDa1XQOi2+o755eN8ZNhFsCEw8G/1zUJet2LW32rlOaVXKgTqQ7l98QUQ+ktO0o4eEvUsYB7fZmLAAAAAAFwYgAQl0AAcLAQABISEBGAxvAAA='

const EXPECTED_NAMES = ['docs/readme.txt', '文档.txt', 'empty.txt', 'data.bin', 'docs']
const EXPECTED_MTIME = '2021-03-03T21:06:08.000Z'

/**
 * @param {string} base64
 * @returns {Uint8Array}
 */
function fromBase64(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function crc32(bytes, start, end) {
  let crc = 0xffffffff
  for (let i = start; i < end; i += 1) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * @param {number} value
 * @returns {number[]}
 */
function le16(value) {
  return [value & 0xff, (value >>> 8) & 0xff]
}

/**
 * @param {number} value
 * @returns {number[]}
 */
function le32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function concat(parts) {
  let total = 0
  for (const part of parts) total += part.length
  const merged = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.length
  }
  return merged
}

/**
 * Turn a RAR4 header (leading two bytes reserved for the CRC) into bytes.
 * @param {number[]} header
 * @returns {Uint8Array}
 */
function finishRar4(header) {
  const bytes = Uint8Array.from(header)
  const crc = crc32(bytes, 2, bytes.length) & 0xffff
  bytes[0] = crc & 0xff
  bytes[1] = (crc >>> 8) & 0xff
  return bytes
}

/**
 * Encode a RAR5 variable-length integer.
 * @param {number} value
 * @returns {number[]}
 */
function rar5Vint(value) {
  const out = []
  let rest = value
  for (;;) {
    const byte = rest % 128
    rest = Math.floor(rest / 128)
    if (rest === 0) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

/**
 * Turn a RAR5 header body (everything after the size vint) into a block.
 * @param {number[]} body
 * @returns {Uint8Array}
 */
function finishRar5(body) {
  const bytes = Uint8Array.from([0, 0, 0, 0, ...rar5Vint(body.length), ...body])
  const crc = crc32(bytes, 4, bytes.length)
  bytes[0] = crc & 0xff
  bytes[1] = (crc >>> 8) & 0xff
  bytes[2] = (crc >>> 16) & 0xff
  bytes[3] = (crc >>> 24) & 0xff
  return bytes
}

/**
 * Encode a timestamp the way a RAR4 header stores it: an MS-DOS date/time.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @returns {number}
 */
function dosTime(year, month, day, hour, minute, second) {
  const date = ((year - 1980) << 9) | (month << 5) | day
  const time = (hour << 11) | (minute << 5) | (second >>> 1)
  return ((date << 16) | time) >>> 0
}

/**
 * Build a RAR4 archive. No RAR tool is available on the build machine, so the
 * container is written here byte by byte from the format description.
 * @param {{ name: string, data?: Uint8Array, dir?: boolean, encrypted?: boolean, dosTime?: number }[]} items
 * @param {{ encryptedHeaders?: boolean, volume?: boolean }} [options]
 * @returns {Uint8Array}
 */
function buildRar4(items, options = {}) {
  const parts = [Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])]
  let mainFlags = 0x8000
  if (options.encryptedHeaders === true) mainFlags |= 0x0080
  if (options.volume === true) mainFlags |= 0x0001
  parts.push(finishRar4([0, 0, 0x73, ...le16(mainFlags), ...le16(13), 0, 0, 0, 0, 0, 0]))

  for (const item of items) {
    const data = item.data === undefined ? new Uint8Array(0) : item.data
    const nameBytes = [...Buffer.from(item.name, 'utf8')]
    let flags = 0x8000
    if (item.dir === true) flags |= 0x00e0
    if (item.encrypted === true) flags |= 0x0004
    const header = [
      0, 0,
      0x74,
      ...le16(flags),
      ...le16(7 + 25 + nameBytes.length),
      ...le32(data.length),
      ...le32(data.length),
      0,
      ...le32(item.encrypted === true ? 0 : crc32(data, 0, data.length)),
      ...le32(item.dosTime === undefined ? dosTime(2021, 3, 4, 5, 6, 8) : item.dosTime),
      20,
      item.encrypted === true ? 0x31 : 0x30,
      ...le16(nameBytes.length),
      ...le32(item.dir === true ? 0x10 : 0x20),
      ...nameBytes,
    ]
    parts.push(finishRar4(header))
    parts.push(data)
  }

  parts.push(finishRar4([0, 0, 0x7a, ...le16(0), ...le16(7)]))
  return concat(parts)
}

/**
 * Build a RAR5 archive, again byte by byte.
 * @param {{ name: string, data?: Uint8Array, dir?: boolean, mtime?: number, encrypted?: boolean }[]} items
 * @param {{ encryptedHeaders?: boolean, volume?: boolean }} [options]
 * @returns {Uint8Array}
 */
function buildRar5(items, options = {}) {
  const parts = [Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])]
  const archiveFlags = options.volume === true ? 0x0001 : 0
  parts.push(finishRar5([1, 0, ...rar5Vint(archiveFlags)]))
  if (options.encryptedHeaders === true) {
    parts.push(finishRar5([4, 0, 0, 0]))
    return concat(parts)
  }

  for (const item of items) {
    const data = item.data === undefined ? new Uint8Array(0) : item.data
    const nameBytes = [...Buffer.from(item.name, 'utf8')]
    const mtime = item.mtime === undefined ? 1614805568 : item.mtime
    let fileFlags = 0x02 | 0x04
    if (item.dir === true) fileFlags |= 0x01
    const fileCrc = item.encrypted === true ? 0 : crc32(data, 0, data.length)
    const body = [
      2,
      ...rar5Vint(0x02),
      ...rar5Vint(data.length),
      ...rar5Vint(fileFlags),
      ...rar5Vint(data.length),
      ...rar5Vint(item.dir === true ? 0x10 : 0x20),
      ...le32(mtime),
      ...le32(fileCrc),
      ...rar5Vint(item.dir === true ? 0 : 0x8000),
      ...rar5Vint(0),
      ...rar5Vint(nameBytes.length),
      ...nameBytes,
    ]
    parts.push(finishRar5(body))
    parts.push(data)
  }

  parts.push(finishRar5([5, 0, 0]))
  return concat(parts)
}

/**
 * Assert a call throws a SevenZipError with the given code.
 * @param {() => unknown} run
 * @param {string} code
 * @param {string} [message]
 */
function throwsCode(run, code, message) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof SevenZipError, `expected a SevenZipError, got ${error && error.name}`)
    assert.equal(error.code, code)
    assert.equal(typeof error.message, 'string')
    assert.ok(error.message.length > 0)
    return true
  }, message)
}

/**
 * @param {{ entries: { name: string }[] }} listing
 * @returns {Map<string, any>}
 */
function byName(listing) {
  const map = new Map()
  for (const entry of listing.entries) map.set(entry.name, entry)
  return map
}

/**
 * The four 7z fixtures hold the same content, so one check covers them all.
 * @param {string} label
 * @param {Uint8Array} bytes
 */
function assertStandard7zListing(label, bytes) {
  const listing = list7zRar(bytes)
  assert.equal(listing.format, '7z', label)
  assert.equal(listing.entries.length, EXPECTED_NAMES.length, label)
  assert.deepEqual(listing.entries.map((entry) => entry.name), EXPECTED_NAMES, label)

  const entries = byName(listing)
  assert.equal(entries.get('docs/readme.txt').size, 14, label)
  assert.equal(entries.get('文档.txt').size, 13, label)
  assert.equal(entries.get('empty.txt').size, 0, label)
  assert.equal(entries.get('data.bin').size, 1500, label)
  assert.equal(entries.get('docs').size, 0, label)

  assert.equal(entries.get('docs').dir, true, label)
  assert.equal(entries.get('data.bin').dir, undefined, label)
  assert.equal(entries.get('empty.txt').dir, undefined, label)

  for (const name of EXPECTED_NAMES) {
    assert.equal(entries.get(name).modified, EXPECTED_MTIME, `${label}: ${name} mtime`)
  }
  assert.equal(listing.encrypted, undefined, label)
}

test('lists a 7z whose next header is LZMA2-compressed', () => {
  assertStandard7zListing('lzma2 header', fromBase64(LZMA2_HEADER))
})

test('lists a 7z whose next header is stored uncompressed', () => {
  const bytes = fromBase64(STORED_HEADER)
  // The Copy coder leaves the header readable in place, starting with kHeader.
  assertStandard7zListing('stored header', bytes)
})

test('lists a 7z whose next header is LZMA1-compressed', () => {
  const bytes = fromBase64(LZMA_HEADER)
  assertStandard7zListing('lzma1 header', bytes)
})

test('tells empty folders from empty files by their empty-stream index', () => {
  const listing = list7zRar(fromBase64(EMPTIES))
  assert.equal(listing.format, '7z')
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['adir', 'afile.txt', 'zdir', 'zfile.txt'])
  // Both folders and both files are empty streams; only the folder bit differs.
  assert.deepEqual(listing.entries.map((entry) => entry.dir === true), [true, false, true, false])
  for (const entry of listing.entries) assert.equal(entry.size, 0)
})

test('lists an empty 7z archive as having no entries', () => {
  const listing = list7zRar(fromBase64(EMPTY_ARCHIVE))
  assert.equal(listing.format, '7z')
  assert.deepEqual(listing.entries, [])
})

test('lists a 7z whose entry data is encrypted, flagging it', () => {
  const listing = list7zRar(fromBase64(ENCRYPTED_DATA))
  assert.equal(listing.format, '7z')
  assert.equal(listing.entries.length, 1)
  assert.equal(listing.entries[0].name, 'secret.txt')
  assert.equal(listing.entries[0].size, 20)
  assert.equal(listing.entries[0].encrypted, true)
  assert.equal(listing.encrypted, true)
  assert.match(listing.note, /encrypted/)
})

test('rejects a 7z header that uses an unknown coder', () => {
  throwsCode(() => list7zRar(fromBase64(BAD_CODER)), 'unsupported', 'bogus header coder')
})

test('rejects a 7z whose start header CRC does not match', () => {
  const bytes = fromBase64(LZMA2_HEADER).slice()
  bytes[13] ^= 0xff
  throwsCode(() => list7zRar(bytes), 'invalid')
})

test('rejects a 7z whose next header CRC does not match', () => {
  const bytes = fromBase64(STORED_HEADER).slice()
  const offset = 32 + (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16) | (bytes[15] << 24))
  bytes[offset] ^= 0xff
  throwsCode(() => list7zRar(bytes), 'invalid')
})

test('rejects data that is not an archive', () => {
  throwsCode(() => list7zRar(new Uint8Array(0)), 'invalid')
  throwsCode(() => list7zRar(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])), 'invalid')
  throwsCode(() => list7zRar(new Uint8Array(200).fill(0x41)), 'invalid')
})

test('never lets a non-SevenZipError escape on a truncated 7z', () => {
  for (const base64 of [LZMA2_HEADER, STORED_HEADER, LZMA_HEADER, BAD_CODER]) {
    const bytes = fromBase64(base64)
    for (let length = 0; length < bytes.length; length += 1) {
      const prefix = bytes.subarray(0, length)
      try {
        const listing = list7zRar(prefix)
        assert.ok(Array.isArray(listing.entries))
      } catch (error) {
        assert.ok(
          error instanceof SevenZipError,
          `prefix of ${length}/${bytes.length} bytes threw ${error && error.constructor && error.constructor.name}: ${error && error.message}`,
        )
        assert.ok(['invalid', 'unsupported', 'encrypted', 'too-large'].includes(error.code))
      }
    }
  }
})

test('lists a hand-built RAR4 archive', () => {
  const text = new TextEncoder().encode('hello rar\n')
  const bytes = buildRar4([
    { name: 'notes.txt', data: text },
    { name: '文档.txt', data: new TextEncoder().encode('中文内容\n') },
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'docs', dir: true },
  ])
  const listing = list7zRar(bytes)
  assert.equal(listing.format, 'rar4')
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['notes.txt', '文档.txt', 'empty.txt', 'docs'])

  const entries = byName(listing)
  assert.equal(entries.get('notes.txt').size, text.length)
  assert.equal(entries.get('notes.txt').packed, text.length)
  assert.equal(entries.get('文档.txt').size, 13)
  assert.equal(entries.get('empty.txt').size, 0)
  assert.equal(entries.get('docs').dir, true)
  assert.equal(entries.get('notes.txt').dir, undefined)
  assert.equal(entries.get('notes.txt').modified, '2021-03-04T05:06:08.000Z')
  assert.equal(entries.get('notes.txt').method, 'store')
  assert.equal(listing.encrypted, undefined)
})

test('lists a hand-built RAR4 archive with a non-ASCII directory tree', () => {
  const bytes = buildRar4([
    { name: 'a/b/c.txt', data: new Uint8Array([1, 2, 3]) },
    { name: 'a/b', dir: true },
    { name: 'a', dir: true },
  ])
  const listing = list7zRar(bytes)
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['a/b/c.txt', 'a/b', 'a'])
  assert.deepEqual(listing.entries.map((entry) => entry.dir === true), [false, true, true])
})

test('reports RAR4 encrypted entries and encrypted headers', () => {
  const encryptedEntry = buildRar4([{ name: 'secret.txt', data: new Uint8Array(16), encrypted: true }])
  const listing = list7zRar(encryptedEntry)
  assert.equal(listing.encrypted, true)
  assert.equal(byName(listing).get('secret.txt').encrypted, true)
  assert.equal(byName(listing).get('secret.txt').name, 'secret.txt')

  throwsCode(() => list7zRar(buildRar4([{ name: 'a.txt', data: new Uint8Array(4) }], { encryptedHeaders: true })), 'encrypted')
})

test('notes that a RAR4 archive is only one volume', () => {
  const listing = list7zRar(buildRar4([{ name: 'a.txt', data: new Uint8Array(4) }], { volume: true }))
  assert.equal(typeof listing.note, 'string')
  assert.match(listing.note, /multi-volume/)
})

test('lists a hand-built RAR5 archive', () => {
  const text = new TextEncoder().encode('hello rar5\n')
  const bytes = buildRar5([
    { name: 'notes.txt', data: text },
    { name: '文档.txt', data: new TextEncoder().encode('中文内容\n') },
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'docs', dir: true },
  ])
  const listing = list7zRar(bytes)
  assert.equal(listing.format, 'rar5')
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['notes.txt', '文档.txt', 'empty.txt', 'docs'])

  const entries = byName(listing)
  assert.equal(entries.get('notes.txt').size, text.length)
  assert.equal(entries.get('notes.txt').packed, text.length)
  assert.equal(entries.get('文档.txt').size, 13)
  assert.equal(entries.get('empty.txt').size, 0)
  assert.equal(entries.get('docs').dir, true)
  assert.equal(entries.get('notes.txt').dir, undefined)
  assert.equal(entries.get('notes.txt').modified, new Date(1614805568 * 1000).toISOString())
  assert.equal(entries.get('notes.txt').method, 'store')
  assert.equal(listing.encrypted, undefined)
})

test('reports RAR5 encrypted headers and encrypted entries', () => {
  throwsCode(() => list7zRar(buildRar5([{ name: 'a.txt', data: new Uint8Array(4) }], { encryptedHeaders: true })), 'encrypted')

  const bytes = buildRar5([{ name: 'a.txt', data: new Uint8Array(4) }])
  // Flip the archive flag block's CRC so the RAR5 integrity check has to fire.
  bytes[8 + 4] ^= 0xff
  throwsCode(() => list7zRar(bytes), 'invalid')
})

test('never lets a non-SevenZipError escape on a truncated RAR', () => {
  const archives = [
    buildRar4([{ name: 'a.txt', data: new Uint8Array([1, 2, 3]) }, { name: 'd', dir: true }]),
    buildRar5([{ name: 'a.txt', data: new Uint8Array([1, 2, 3]) }, { name: 'd', dir: true }]),
  ]
  for (const bytes of archives) {
    for (let length = 0; length <= bytes.length; length += 1) {
      const prefix = bytes.subarray(0, length)
      try {
        const listing = list7zRar(prefix)
        assert.ok(Array.isArray(listing.entries))
      } catch (error) {
        assert.ok(
          error instanceof SevenZipError,
          `prefix of ${length}/${bytes.length} bytes threw ${error && error.constructor && error.constructor.name}: ${error && error.message}`,
        )
      }
    }
  }
})

test('lists a real .rar found on this machine, when there is one', (t) => {
  const candidates = [process.cwd(), join(homedir(), 'Downloads'), join(homedir(), 'Desktop')]
  let found
  for (const directory of candidates) {
    if (found !== undefined) break
    if (!existsSync(directory)) continue
    let names
    try {
      names = readdirSync(directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.rar')) continue
      found = join(directory, name)
      break
    }
  }
  if (found === undefined) {
    t.skip('no .rar file on this machine to cross-check against')
    return
  }
  const listing = list7zRar(new Uint8Array(readFileSync(found)))
  assert.ok(listing.format === 'rar4' || listing.format === 'rar5')
  assert.ok(Array.isArray(listing.entries))
  for (const entry of listing.entries) {
    assert.equal(typeof entry.name, 'string')
    assert.equal(typeof entry.size, 'number')
  }
})
