/**
 * Archive listing and entry extraction.
 *
 * The Sidebar tab shows what is inside a `.zip`, `.tar`, `.tar.gz`, `.tgz`,
 * `.tar.bz2`, `.tar.xz`, `.tar.zst`, `.jar`, `.whl` and friends, and previews
 * text and image entries in place. Nothing is written to disk: the archive is
 * read into memory once (the route caps the size) and entries are inflated
 * from that buffer.
 *
 * ZIP is parsed from its central directory, TAR from its 512-byte headers
 * (including GNU long names and PAX `path=` records), and the single-stream
 * compressors are handed to `node:zlib` / `./decompress.js`.
 */
import { inflateRawSync, gunzipSync } from 'node:zlib'
import * as zlib from 'node:zlib'
import { decompressAll, sniffCompression } from './decompress.js'
import { suffixOf } from '../../kinds.js'
import { SevenZipError, list7zRar } from './sevenzip.js'

export class ArchiveError extends Error {
  /** @param {'invalid' | 'unsupported' | 'too-large'} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

/** Default ceiling for one extracted entry. */
export const DEFAULT_ENTRY_LIMIT = 32 * 1024 * 1024
/** How many entries a listing may contain before it is truncated. */
export const DEFAULT_ENTRY_COUNT = 20000

const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8)
const u32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
const u64 = (bytes, at) => u32(bytes, at) + u32(bytes, at + 4) * 0x100000000

/** Decode UTF-8, falling back to latin-1 for legacy ZIP names. */
function decodeName(bytes, start, length, utf8) {
  const slice = bytes.subarray(start, start + length)
  try {
    return new TextDecoder(utf8 ? 'utf-8' : 'utf-8', { fatal: utf8 }).decode(slice)
  } catch {
    return new TextDecoder('latin1').decode(slice)
  }
}

/** MS-DOS date/time → ISO string, or `undefined` for the zero value. */
function dosTime(date, time) {
  if (date === 0 && time === 0) return undefined
  const year = 1980 + ((date >> 9) & 0x7f)
  const month = (date >> 5) & 0x0f
  const day = date & 0x1f
  if (month < 1 || month > 12 || day < 1) return undefined
  const hours = (time >> 11) & 0x1f
  const minutes = (time >> 5) & 0x3f
  const seconds = (time & 0x1f) * 2
  const pad = (value) => String(value).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

// ---- ZIP ------------------------------------------------------------------

const ZIP_EOCD = 0x06054b50
const ZIP_EOCD64 = 0x06064b50
const ZIP_EOCD64_LOCATOR = 0x07064b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_LOCAL = 0x04034b50

/** Locate the end-of-central-directory record, tolerating a trailing comment. */
function findEocd(bytes) {
  const floor = Math.max(0, bytes.length - 66000)
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (u32(bytes, at) === ZIP_EOCD) return at
  }
  return -1
}

/**
 * Find the central directory from the end of the file.
 *
 * `bytes` is the file's tail and starts at absolute offset `base` (0 when it
 * is the whole file), so the same code serves a buffered archive and one read
 * through byte ranges. `end` is the absolute offset the directory stops
 * before; `zip64At` is set when the ZIP64 record lies outside `bytes`.
 * @returns {{ count: number, offset: number, end: number, note?: string, zip64At?: number }}
 */
function locateZipDirectory(bytes, base = 0) {
  const eocd = findEocd(bytes)
  if (eocd < 0) throw new ArchiveError('invalid', 'no end-of-central-directory record')
  const where = { count: u16(bytes, eocd + 10), offset: u32(bytes, eocd + 16), end: base + eocd }
  // ZIP64: the classic fields saturate and a ZIP64 record carries the truth.
  if (where.count === 0xffff || where.offset === 0xffffffff) {
    const locator = eocd - 20
    if (locator >= 0 && u32(bytes, locator) === ZIP_EOCD64_LOCATOR) {
      const absolute = u64(bytes, locator + 8)
      const at = absolute - base
      if (at < 0) {
        where.zip64At = absolute
      } else if (at + 56 <= bytes.length && u32(bytes, at) === ZIP_EOCD64) {
        where.count = u64(bytes, at + 32)
        where.offset = u64(bytes, at + 48)
      }
    } else {
      where.note = 'ZIP64 locator missing; entry count may be wrong'
    }
  }
  return where
}

/**
 * Parse central directory records. `bytes` covers the directory and starts at
 * absolute offset `base`.
 * @param {Uint8Array} bytes
 * @param {number} base
 * @param {{ count: number, offset: number, note?: string }} where
 * @param {number} limit
 * @returns {{ format: string, entries: any[], note?: string }}
 */
function parseZipDirectory(bytes, base, where, limit) {
  const { count } = where
  let { note } = where
  const entries = []
  let at = where.offset - base
  for (let index = 0; index < count && at >= 0 && at + 46 <= bytes.length; index++) {
    if (entries.length >= limit) {
      note = `listing truncated at ${limit} entries`
      break
    }
    if (u32(bytes, at) !== ZIP_CENTRAL) {
      note = `central directory ended early at entry ${index}`
      break
    }
    const madeBy = u16(bytes, at + 4)
    const flags = u16(bytes, at + 8)
    const method = u16(bytes, at + 10)
    const time = u16(bytes, at + 12)
    const date = u16(bytes, at + 14)
    const crc = u32(bytes, at + 16)
    let packed = u32(bytes, at + 20)
    let size = u32(bytes, at + 24)
    const nameLength = u16(bytes, at + 28)
    const extraLength = u16(bytes, at + 30)
    const commentLength = u16(bytes, at + 32)
    let localOffset = u32(bytes, at + 42)
    const name = decodeName(bytes, at + 46, nameLength, (flags & 0x0800) !== 0 || madeBy >> 8 === 3)
    const extraStart = at + 46 + nameLength
    // ZIP64 extended information (0x0001) fills whichever fields saturated.
    for (let extra = extraStart; extra + 4 <= extraStart + extraLength;) {
      const id = u16(bytes, extra)
      const length = u16(bytes, extra + 2)
      if (id === 0x0001) {
        let cursor = extra + 4
        const take = () => {
          const value = u64(bytes, cursor)
          cursor += 8
          return value
        }
        if (size === 0xffffffff) size = take()
        if (packed === 0xffffffff) packed = take()
        if (localOffset === 0xffffffff) localOffset = take()
      }
      extra += 4 + length
    }
    if (extraStart + extraLength + commentLength > bytes.length) {
      // The record runs past what was read: a truncated file or a capped directory.
      note = `central directory is cut short at entry ${index}`
      break
    }
    const dir = name.endsWith('/') || (madeBy >> 8 === 0 && (u32(bytes, at + 38) & 0x10) !== 0)
    entries.push({
      name,
      size,
      packed,
      crc,
      method,
      dir,
      encrypted: (flags & 0x0001) !== 0,
      modified: dosTime(date, time),
      offset: localOffset,
    })
    at = extraStart + extraLength + commentLength
  }
  return { format: 'zip', entries, note }
}

/**
 * List a ZIP archive that is already in memory.
 * @param {Uint8Array} bytes
 * @param {number} [limit]
 * @returns {{ format: string, entries: any[], note?: string }}
 */
function listZip(bytes, limit = Infinity) {
  return parseZipDirectory(bytes, 0, locateZipDirectory(bytes), limit)
}

/** The end record plus the longest comment a ZIP may carry. */
const ZIP_TAIL_BYTES = 22 + 0xffff + 20

/**
 * List a ZIP through byte ranges: the tail, then the central directory. The
 * member data is never read, so a multi-gigabyte archive costs kilobytes.
 * @param {(offset: number, length: number) => Promise<Uint8Array>} read
 * @param {number} size file size
 * @param {{ maxEntries?: number, maxDirectoryBytes?: number }} [options]
 * @returns {Promise<{ format: string, entries: any[], note?: string }>}
 */
export async function listZipRanged(read, size, options) {
  const limit = options?.maxEntries ?? DEFAULT_ENTRY_COUNT
  const maxDirectoryBytes = options?.maxDirectoryBytes ?? 64 * 1024 * 1024
  const tailStart = Math.max(0, size - ZIP_TAIL_BYTES)
  const tail = await read(tailStart, size - tailStart)
  const where = locateZipDirectory(tail, tailStart)
  if (where.zip64At !== undefined) {
    const record = await read(where.zip64At, 56)
    if (record.length >= 56 && u32(record, 0) === ZIP_EOCD64) {
      where.count = u64(record, 32)
      where.offset = u64(record, 48)
    }
  }
  const span = where.end - where.offset
  if (span < 0 || where.offset > size) throw new ArchiveError('invalid', 'central directory lies outside the file')
  const length = Math.min(span, maxDirectoryBytes)
  const directory = where.offset >= tailStart
    ? tail.subarray(where.offset - tailStart, where.offset - tailStart + length)
    : await read(where.offset, length)
  return parseZipDirectory(directory, where.offset, where, limit)
}

/** Reject an entry the preview cannot or should not expand. */
function assertZipEntryReadable(entry, limit) {
  if (entry.encrypted) throw new ArchiveError('unsupported', 'entry is encrypted')
  if (entry.size > limit) throw new ArchiveError('too-large', 'entry exceeds the preview limit')
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ArchiveError('unsupported', `compression method ${entry.method} is not supported`)
  }
}

/** Expand the packed bytes of one entry. `method` 0 is stored, 8 is deflate. */
function expandZipData(data, entry, limit) {
  if (entry.method === 0) return data
  try {
    return new Uint8Array(inflateRawSync(data, { maxOutputLength: limit }))
  } catch (cause) {
    throw new ArchiveError('invalid', `could not inflate entry: ${cause?.message ?? 'unknown error'}`)
  }
}

/** Inflate one ZIP entry from an archive that is already in memory. */
function readZipEntry(bytes, entry, limit) {
  assertZipEntryReadable(entry, limit)
  const at = entry.offset
  if (u32(bytes, at) !== ZIP_LOCAL) throw new ArchiveError('invalid', 'local header is missing')
  const start = at + 30 + u16(bytes, at + 26) + u16(bytes, at + 28)
  return expandZipData(bytes.subarray(start, start + entry.packed), entry, limit)
}

/**
 * Read one entry of a {@link listZipRanged} listing: its local header, then
 * only its own packed bytes.
 * @param {(offset: number, length: number) => Promise<Uint8Array>} read
 * @param {any} entry
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function readZipEntryRanged(read, entry, options) {
  const limit = options?.maxBytes ?? DEFAULT_ENTRY_LIMIT
  if (entry.dir) throw new ArchiveError('unsupported', 'entry is a directory')
  assertZipEntryReadable(entry, limit)
  // Deflate never grows data by more than a few bytes per block, so packed
  // bytes far beyond the limit can only belong to an entry that is too large.
  if (entry.packed > limit + 65536) throw new ArchiveError('too-large', 'entry exceeds the preview limit')
  const header = await read(entry.offset, 30)
  if (header.length < 30 || u32(header, 0) !== ZIP_LOCAL) throw new ArchiveError('invalid', 'local header is missing')
  const start = entry.offset + 30 + u16(header, 26) + u16(header, 28)
  const data = entry.packed === 0 ? new Uint8Array(0) : await read(start, entry.packed)
  if (data.length < entry.packed) throw new ArchiveError('invalid', 'entry data is cut short')
  return expandZipData(data, entry, limit)
}

// ---- TAR ------------------------------------------------------------------

const BLOCK = 512

/** Read a NUL-terminated field. */
function field(bytes, start, length) {
  const slice = bytes.subarray(start, start + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end))
}

/** Read a numeric header field (octal, or GNU base-256 when the high bit is set). */
function numeric(bytes, start, length) {
  if ((bytes[start] & 0x80) !== 0) {
    // GNU base-256: big-endian, the high bit of the first byte is the flag.
    let value = 0
    for (let index = 1; index < length; index++) value = value * 256 + bytes[start + index]
    return value
  }
  const text = field(bytes, start, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/** A PAX record set (`<len> <key>=<value>\n`). */
function parsePax(bytes) {
  const out = {}
  let at = 0
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at)
    if (space === -1) break
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(at, space)), 10)
    if (!Number.isFinite(length) || length <= 0 || at + length > bytes.length) break
    const record = new TextDecoder().decode(bytes.subarray(space + 1, at + length - 1))
    const equals = record.indexOf('=')
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1)
    at += length
  }
  return out
}

/**
 * List a TAR archive.
 * @param {Uint8Array} bytes
 * @param {number} limit
 * @returns {{ format: string, entries: any[], note?: string }}
 */
function listTar(bytes, limit) {
  const entries = []
  let at = 0
  let longName
  let pax = {}
  let note
  while (at + BLOCK <= bytes.length) {
    const header = bytes.subarray(at, at + BLOCK)
    if (header.every((byte) => byte === 0)) break
    let size = numeric(bytes, at + 124, 12)
    const type = String.fromCharCode(bytes[at + 156] || 0x30)
    const bodyStart = at + BLOCK
    if (type === 'L' || type === 'K') {
      // GNU long name / long link: the next header's name lives in this body.
      const raw = bytes.subarray(bodyStart, bodyStart + size)
      const end = raw.indexOf(0)
      const value = new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end))
      if (type === 'L') longName = value
      at = bodyStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (type === 'x' || type === 'g') {
      pax = type === 'x' ? parsePax(bytes.subarray(bodyStart, bodyStart + size)) : pax
      at = bodyStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (type === 'V') break
    const prefix = field(bytes, at + 345, 155)
    let name = field(bytes, at, 100)
    if (prefix !== '') name = `${prefix}/${name}`
    if (pax.path !== undefined) name = pax.path
    if (longName !== undefined) name = longName
    if (pax.size !== undefined) size = Number.parseInt(pax.size, 10) || size
    const mtime = pax.mtime !== undefined ? Number.parseInt(pax.mtime, 10) : numeric(bytes, at + 136, 12)
    const dir = type === '5' || name.endsWith('/')
    entries.push({
      name,
      size: dir ? 0 : size,
      packed: dir ? 0 : size,
      dir,
      method: 0,
      offset: bodyStart,
      modified: Number.isFinite(mtime) && mtime > 0 ? new Date(mtime * 1000).toISOString().slice(0, 19) : undefined,
    })
    longName = undefined
    pax = {}
    at = bodyStart + (dir ? 0 : Math.ceil(size / BLOCK) * BLOCK)
    if (entries.length >= limit) {
      note = `listing truncated at ${limit} entries`
      break
    }
  }
  return { format: 'tar', entries, note }
}

// ---- dispatch -------------------------------------------------------------

/**
 * Read one named member of a ZIP container, case-insensitively.
 * Used by the document reader to pull `content.xml` out of an ODF file.
 * @param {Uint8Array} bytes
 * @param {string} wanted
 * @param {{ maxBytes?: number }} [options]
 * @returns {Uint8Array | undefined}
 */
export function readZipMember(bytes, wanted, options) {
  const limit = options?.maxBytes ?? DEFAULT_ENTRY_LIMIT
  let listed
  try {
    listed = listZip(bytes)
  } catch {
    return undefined
  }
  const lower = wanted.toLowerCase()
  const entry = listed.entries.find((candidate) => candidate.name.toLowerCase() === lower)
  return entry === undefined ? undefined : readZipEntry(bytes, entry, limit)
}

/** Default ceiling for the expanded form of a compressed stream. */
const DEFAULT_OUTPUT_LIMIT = 192 * 1024 * 1024

/** A byte view over a Node Buffer's memory, without copying it. */
const viewOf = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

function outputTooLarge(limit) {
  return new ArchiveError('too-large', `the decompressed data is larger than the ${Math.round(limit / (1024 * 1024))} MiB preview limit`)
}

/** Expand a single-stream container. */
function expand(bytes, format, limit) {
  try {
    switch (format) {
      case 'gzip':
        // The trailer states the expanded size; an honest oversized stream is
        // refused before a single byte is inflated. A lying one still hits
        // `maxOutputLength` below.
        if (bytes.length >= 18 && u32(bytes, bytes.length - 4) > limit) throw outputTooLarge(limit)
        return viewOf(gunzipSync(bytes, { maxOutputLength: limit }))
      case 'zstd':
        if (typeof zlib.zstdDecompressSync !== 'function') {
          throw new ArchiveError('unsupported', 'zstd decompression is not available in this Node.js runtime')
        }
        return viewOf(zlib.zstdDecompressSync(bytes, { maxOutputLength: limit }))
      case 'bzip2':
      case 'xz':
        return decompressAll(format, bytes, { maxOutputBytes: limit })
      default:
        throw new ArchiveError('unsupported', `${format} is not supported`)
    }
  } catch (cause) {
    if (cause instanceof ArchiveError) throw cause
    const tooLarge = cause?.code === 'too-large' || cause?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength/i.test(cause?.message ?? '')
    if (tooLarge) throw outputTooLarge(limit)
    throw new ArchiveError('invalid', cause?.message ?? 'decompression failed')
  }
}

/** archive bytes → their expanded form, for as long as the archive itself is alive. */
const expanded = new WeakMap()

/**
 * Decompress a single-stream container; returns the inner bytes.
 *
 * Listing an archive and then reading one of its members would otherwise
 * expand the same stream twice, which is the slowest step by far.
 */
function unwrap(bytes, format, limit) {
  const known = expanded.get(bytes)
  if (known !== undefined && known.format === format && known.inner.length <= limit) return known.inner
  const inner = expand(bytes, format, limit)
  expanded.set(bytes, { format, inner })
  return inner
}

/** Size of the expanded form held for these archive bytes; `undefined` when nothing was expanded. */
export function expandedSizeOf(bytes) {
  return expanded.get(bytes)?.inner.length
}

/** Suffixes that are really ZIP containers under another name. */
const ZIP_LIKE = new Set([
  'zip', 'jar', 'war', 'ear', 'apk', 'ipa', 'xpi', 'crx', 'vsix', 'whl', 'nupkg', 'epub', 'cbz',
])

/** Suffixes of a bare compressed stream (no tar inside, or not known yet). */
const STREAM = new Set(['gz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'z'])

/** Suffixes that are 7z or RAR containers; listing only, no extraction. */
const SEVEN_ZIP = new Set(['7z', 'rar', 'cbr'])

/** Map a filename suffix to the stream format it implies. */
function streamFormat(suffix, compression) {
  if (compression !== undefined && compression !== 'brotli') return compression
  if (suffix === 'bz2') return 'bzip2'
  if (suffix === 'xz' || suffix === 'lzma') return 'xz'
  if (suffix === 'zst') return 'zstd'
  return 'gzip'
}

/** Whether the bytes start a tar archive. */
function looksTar(bytes) {
  return bytes.length >= 262 && new TextDecoder().decode(bytes.subarray(257, 262)) === 'ustar'
}

/** Whether the bytes start a 7z or RAR container. */
function looksSevenZip(bytes) {
  if (bytes.length < 4) return false
  if (bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf) return true
  return bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21
}

/**
 * Whether a file is a ZIP that can be listed through byte ranges, judged from
 * its first bytes and its name. Mirrors the dispatch order of
 * {@link listArchive}: ZIP magic first, other container magic next, the
 * suffix last.
 * @param {Uint8Array} head at least the first 512 bytes, or the whole file when shorter
 * @param {string} name
 */
export function isZipByRanges(head, name) {
  if (head.length >= 4 && (u32(head, 0) === ZIP_LOCAL || u32(head, 0) === ZIP_EOCD)) return true
  if (looksTar(head) || looksSevenZip(head)) return false
  return ZIP_LIKE.has(suffixOf(name))
}

/** List a 7z or RAR container, mapping its error type onto ours. */
function listSevenZip(bytes, limit) {
  try {
    const listed = list7zRar(bytes)
    if (listed.entries.length > limit) {
      listed.entries.length = limit
      listed.note = `listing truncated at ${limit} entries`
    }
    return {
      format: listed.format,
      note: listed.note,
      encrypted: listed.encrypted === true,
      // No crc/offset: extraction of these formats is not supported, and the
      // missing fields are what tells readArchiveEntry to say so.
      entries: listed.entries.map((entry) => ({
        name: entry.name,
        size: entry.size,
        packed: entry.packed,
        dir: entry.dir === true,
        encrypted: entry.encrypted === true,
        modified: entry.modified,
      })),
    }
  } catch (error) {
    if (error instanceof SevenZipError) throw new ArchiveError(error.code === 'too-large' ? 'too-large' : error.code === 'invalid' ? 'invalid' : 'unsupported', error.message)
    throw error
  }
}

/**
 * List the entries of an archive by its filename.
 * @param {Uint8Array} bytes whole archive
 * @param {string} name archive filename, used to pick the format
 * @param {{ maxOutputBytes?: number, maxEntries?: number }} [options]
 * @returns {{ format: string, entries: any[], note?: string }}
 */
export function listArchive(bytes, name, options) {
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT
  const maxEntries = options?.maxEntries ?? DEFAULT_ENTRY_COUNT
  const suffix = suffixOf(name)
  const compression = sniffCompression(bytes)
  const tarred = () => {
    const listed = listTar(bytes, maxEntries)
    listed.format = 'tar'
    return listed
  }

  // Container magic beats the extension: a `.zip` that is really a 7z exists.
  if (u32(bytes, 0) === ZIP_LOCAL || u32(bytes, 0) === ZIP_EOCD) return listZip(bytes, maxEntries)
  if (looksTar(bytes)) return tarred()
  if (looksSevenZip(bytes)) return listSevenZip(bytes, maxEntries)

  if (ZIP_LIKE.has(suffix)) return listZip(bytes, maxEntries)
  if (SEVEN_ZIP.has(suffix)) return listSevenZip(bytes, maxEntries)
  if (suffix === 'tar') return tarred()
  if (suffix.startsWith('tar.') || ['tgz', 'tbz', 'tbz2', 'txz'].includes(suffix)) {
    const format = streamFormat(suffix, compression)
    const listed = listTar(unwrap(bytes, format, maxOutputBytes), maxEntries)
    listed.format = `tar.${format}`
    return listed
  }
  if (STREAM.has(suffix)) {
    const format = streamFormat(suffix, compression)
    const inner = unwrap(bytes, format, maxOutputBytes)
    if (looksTar(inner)) {
      const listed = listTar(inner, maxEntries)
      listed.format = `tar.${format}`
      return listed
    }
    return {
      format,
      entries: [{
        name: name.replace(/\.(gz|bz2|xz|zst|lz|lzma|z)$/i, ''),
        size: inner.length,
        packed: bytes.length,
        dir: false,
        method: 0,
      }],
      note: 'single compressed stream',
    }
  }
  throw new ArchiveError('unsupported', `${suffix || 'this file'} is not a supported archive`)
}

/**
 * Extract one entry of a listed archive.
 * @param {Uint8Array} bytes whole archive
 * @param {string} name archive filename
 * @param {any} entry an entry from {@link listArchive}
 * @param {{ maxBytes?: number, maxOutputBytes?: number }} [options]
 * @returns {Uint8Array}
 */
export function readArchiveEntry(bytes, name, entry, options) {
  const limit = options?.maxBytes ?? DEFAULT_ENTRY_LIMIT
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT
  if (entry.dir) throw new ArchiveError('unsupported', 'entry is a directory')
  if (entry.size > limit) throw new ArchiveError('too-large', 'entry exceeds the preview limit')
  if (entry.crc !== undefined) return readZipEntry(bytes, entry, limit)
  const suffix = suffixOf(name)
  if (looksTar(bytes) || suffix === 'tar') return bytes.subarray(entry.offset, entry.offset + entry.size)
  if (suffix.startsWith('tar.') || ['tgz', 'tbz', 'tbz2', 'txz'].includes(suffix)) {
    // Offsets refer to the inner tar, so the stream has to be expanded again.
    const inner = unwrap(bytes, streamFormat(suffix, sniffCompression(bytes)), maxOutputBytes)
    return inner.subarray(entry.offset, entry.offset + entry.size)
  }
  if (STREAM.has(suffix)) {
    const inner = unwrap(bytes, streamFormat(suffix, sniffCompression(bytes)), maxOutputBytes)
    const start = looksTar(inner) ? entry.offset : 0
    return inner.subarray(start, start + entry.size)
  }
  throw new ArchiveError('unsupported', 'entry extraction is not available for this format')
}
