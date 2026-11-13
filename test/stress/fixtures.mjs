/**
 * Large fixtures for the stress run.
 *
 * Everything is generated: nothing big is checked in. Multi-gigabyte files are
 * sparse (a few real bytes, the rest holes), so a 5 GiB archive costs kilobytes
 * of disk. Compressed archives are produced by the system `tar` (bsdtar on
 * Windows), which is also what makes them independent of this project's own
 * decoders. A fixture whose tool is missing is reported as unavailable and the
 * scenarios that need it are skipped.
 */
import {
  closeSync, copyFileSync, createWriteStream, existsSync, ftruncateSync, linkSync, openSync,
  rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, deflateRawSync, deflateSync } from 'node:zlib'

export const MIB = 1024 * 1024
export const GIB = 1024 * MIB

const WINDOWS = process.platform === 'win32'
const TAR = WINDOWS ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
/** A real font to pad; the stress run also opens system fonts in place. */
export const SYSTEM_FONTS = WINDOWS
  ? ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\simsun.ttc', 'C:\\Windows\\Fonts\\seguiemj.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
  : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']

// ---- primitives -----------------------------------------------------------

/** Create a file of `size` bytes that is zeros except for `pieces`. Sparse where the platform allows. */
function writeSparse(path, size, pieces) {
  writeFileSync(path, '')
  if (WINDOWS) {
    // Without the flag NTFS zero-fills everything below a high write.
    try { execFileSync('fsutil', ['sparse', 'setflag', path], { stdio: 'ignore' }) } catch { /* slower, still correct */ }
  }
  const fd = openSync(path, 'r+')
  try {
    ftruncateSync(fd, size)
    for (const { offset, bytes } of pieces) writeSync(fd, bytes, 0, bytes.length, offset)
  } finally {
    closeSync(fd)
  }
}

/** Deterministic pseudo-random bytes generator (xorshift32). */
function randomSource(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
}

const WORDS = (() => {
  const next = randomSource(7)
  const words = []
  for (let index = 0; index < 4000; index++) {
    let word = ''
    for (let length = 2 + (next() % 9); length > 0; length--) word += String.fromCharCode(97 + (next() % 26))
    words.push(word)
  }
  return words
})()

/** About `bytes` of prose-like ASCII: compressible, but not trivially. */
function prose(bytes, seed) {
  const next = randomSource(seed)
  const parts = []
  let length = 0
  while (length < bytes) {
    const word = WORDS[next() % WORDS.length]
    parts.push(word)
    length += word.length + 1
  }
  return parts.join(' ')
}

// ---- TAR ------------------------------------------------------------------

function tarHeader(name, size) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return header
}

const padded = (size) => Math.ceil(size / 512) * 512

/** `count` members of `bodySize` bytes each, then one member of `tailSize`. */
function wideTar(count, bodySize, tailSize) {
  const each = 512 + padded(bodySize)
  const out = Buffer.alloc(count * each + (tailSize > 0 ? 512 + padded(tailSize) : 0) + 1024)
  let at = 0
  for (let index = 0; index < count; index++) {
    tarHeader(`dir-${index % 500}/file-${index}.txt`, bodySize).copy(out, at)
    if (bodySize > 0) out.write(`member ${index}\n`, at + 512)
    at += each
  }
  if (tailSize > 0) {
    tarHeader('tail/large.bin', tailSize).copy(out, at)
    out.fill(0x61, at + 512, at + 512 + tailSize)
  }
  return out
}

/** A TAR holding one member of zeros (a hole on disk) and a small note after it. */
function zerosTar(path, zeros) {
  const note = Buffer.from('the note after the zeros\n')
  const noteAt = 512 + padded(zeros)
  writeSparse(path, noteAt + 512 + 512 + 1024, [
    { offset: 0, bytes: tarHeader('zeros.bin', zeros) },
    { offset: noteAt, bytes: tarHeader('note.txt', note.length) },
    { offset: noteAt + 512, bytes: note },
  ])
}

function textTar(files, bytesEach) {
  const parts = []
  for (let index = 0; index < files; index++) {
    const body = Buffer.from(prose(bytesEach, 100 + index))
    const block = Buffer.alloc(512 + padded(body.length))
    tarHeader(`chapter-${index}.txt`, body.length).copy(block)
    body.copy(block, 512)
    parts.push(block)
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

// ---- ZIP ------------------------------------------------------------------

const u16 = (value) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b }
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b }
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b }
const FF32 = 0xffffffff

/**
 * Local header + central record for one member. Sizes or offsets that do not
 * fit 32 bits go into a ZIP64 extra field, as real archivers write them.
 */
function zipRecords({ name, method, size, packed, offset }) {
  const nameBytes = Buffer.from(name)
  const bigSize = size >= FF32 || packed >= FF32
  const bigOffset = offset >= FF32
  const localExtra = bigSize ? Buffer.concat([u16(1), u16(16), u64(size), u64(packed)]) : Buffer.alloc(0)
  const centralFields = [...(bigSize ? [u64(size), u64(packed)] : []), ...(bigOffset ? [u64(offset)] : [])]
  const centralExtra = centralFields.length === 0 ? Buffer.alloc(0)
    : Buffer.concat([u16(1), u16(centralFields.length * 8), ...centralFields])
  const sizes = [u32(bigSize ? FF32 : packed), u32(bigSize ? FF32 : size)]
  const local = Buffer.concat([
    u32(0x04034b50), u16(45), u16(0x0800), u16(method), u16(0), u16(0), u32(0), ...sizes,
    u16(nameBytes.length), u16(localExtra.length), nameBytes, localExtra,
  ])
  const central = Buffer.concat([
    u32(0x02014b50), u16(45), u16(45), u16(0x0800), u16(method), u16(0), u16(0), u32(0), ...sizes,
    u16(nameBytes.length), u16(centralExtra.length), u16(0), u16(0), u16(0), u32(0),
    u32(bigOffset ? FF32 : offset), nameBytes, centralExtra,
  ])
  return { local, central }
}

/** End records; ZIP64 ones are added when the classic fields overflow. */
function zipEnd(count, directorySize, directoryOffset) {
  const zip64 = count >= 0xffff || directoryOffset >= FF32 || directorySize >= FF32
  const classic = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(Math.min(count, 0xffff)), u16(Math.min(count, 0xffff)),
    u32(Math.min(directorySize, FF32)), u32(Math.min(directoryOffset, FF32)), u16(0),
  ])
  if (!zip64) return classic
  const record = Buffer.concat([
    u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(count), u64(count),
    u64(directorySize), u64(directoryOffset),
  ])
  const locator = Buffer.concat([u32(0x07064b50), u32(0), u64(directoryOffset + directorySize), u32(1)])
  return Buffer.concat([record, locator, classic])
}

/** An in-memory ZIP. `data` is stored as is (method 0) or deflated (method 8). */
function zipBytes(members) {
  const body = []
  const directory = []
  let offset = 0
  for (const member of members) {
    const method = member.method ?? 8
    const packed = method === 8 ? deflateRawSync(member.data) : member.data
    const { local, central } = zipRecords({ name: member.name, method, size: member.data.length, packed: packed.length, offset })
    body.push(local, packed)
    directory.push(central)
    offset += local.length + packed.length
  }
  const directoryBytes = Buffer.concat(directory)
  return Buffer.concat([...body, directoryBytes, zipEnd(members.length, directoryBytes.length, offset)])
}

/** A ZIP64 archive: one stored member of `bigSize` zeros (a hole), then a small deflated text past 4 GiB. */
function hugeZip(path, bigSize) {
  const text = Buffer.from('a readme stored beyond the four gigabyte line\n')
  const packed = deflateRawSync(text)
  const big = zipRecords({ name: 'big.bin', method: 0, size: bigSize, packed: bigSize, offset: 0 })
  const smallOffset = big.local.length + bigSize
  const small = zipRecords({ name: 'docs/readme.txt', method: 8, size: text.length, packed: packed.length, offset: smallOffset })
  const directoryOffset = smallOffset + small.local.length + packed.length
  const directory = Buffer.concat([big.central, small.central])
  const tail = Buffer.concat([directory, zipEnd(2, directory.length, directoryOffset)])
  writeSparse(path, directoryOffset + tail.length, [
    { offset: 0, bytes: big.local },
    { offset: smallOffset, bytes: Buffer.concat([small.local, packed]) },
    { offset: directoryOffset, bytes: tail },
  ])
}

// ---- rasters ----------------------------------------------------------------

/** A single-strip RGB TIFF. `strip` is the (possibly compressed) pixel data. */
function tiff(width, height, compression, strip) {
  const entries = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 3, 0 /* patched below */], [259, 3, 1, compression],
    [262, 3, 1, 2], [273, 4, 1, 0 /* patched below */], [277, 3, 1, 3], [278, 4, 1, height], [279, 4, 1, strip.length],
  ]
  const ifdAt = 8
  const ifdSize = 2 + entries.length * 12 + 4
  const bitsAt = ifdAt + ifdSize
  const stripAt = bitsAt + 6
  entries[2][3] = bitsAt
  entries[5][3] = stripAt
  const head = Buffer.alloc(stripAt)
  head.write('II', 0, 'latin1')
  head.writeUInt16LE(42, 2)
  head.writeUInt32LE(ifdAt, 4)
  head.writeUInt16LE(entries.length, ifdAt)
  entries.forEach(([tag, type, count, value], index) => {
    const at = ifdAt + 2 + index * 12
    head.writeUInt16LE(tag, at)
    head.writeUInt16LE(type, at + 2)
    head.writeUInt32LE(count, at + 4)
    if (type === 3 && count === 1) head.writeUInt16LE(value, at + 8)
    else head.writeUInt32LE(value, at + 8)
  })
  for (let index = 0; index < 3; index++) head.writeUInt16LE(8, bitsAt + index * 2)
  return Buffer.concat([head, strip])
}

/** A gradient with a little noise: what a photo costs the PNG encoder, roughly. */
function photoPixels(width, height) {
  const next = randomSource(99)
  const out = Buffer.allocUnsafe(width * height * 3)
  let at = 0
  for (let y = 0; y < height; y++) {
    const green = (y * 255 / height) | 0
    for (let x = 0; x < width; x++) {
      const noise = next() & 7
      out[at++] = ((x * 255 / width) | 0) ^ noise
      out[at++] = green ^ noise
      out[at++] = ((x + y) & 255) ^ noise
    }
  }
  return out
}

/** An RLE-compressed RGB PSD of zeros: a few megabytes that expand to `width * height * 3`. */
function blankPsd(width, height) {
  const head = Buffer.alloc(26 + 4 + 4 + 4 + 2)
  head.write('8BPS', 0, 'latin1')
  head.writeUInt16BE(1, 4)
  head.writeUInt16BE(3, 12)
  head.writeUInt32BE(height, 14)
  head.writeUInt32BE(width, 18)
  head.writeUInt16BE(8, 22)
  head.writeUInt16BE(3, 24)
  head.writeUInt16BE(1, 38) // RLE; the three section lengths before it stay zero
  // PackBits: 0x81 repeats the next byte 128 times.
  const row = Buffer.alloc((width / 128) * 2)
  for (let at = 0; at < row.length; at += 2) row[at] = 0x81
  const counts = Buffer.alloc(3 * height * 2)
  for (let index = 0; index < 3 * height; index++) counts.writeUInt16BE(row.length, index * 2)
  const rows = Buffer.alloc(3 * height * row.length)
  for (let index = 0; index < 3 * height; index++) row.copy(rows, index * row.length)
  return Buffer.concat([head, counts, rows])
}

// ---- documents --------------------------------------------------------------

function bigRtf(bytes) {
  const parts = ['{\\rtf1\\ansi\\deff0 ']
  let length = 0
  for (let index = 0; length < bytes; index++) {
    const paragraph = `${index % 7 === 0 ? '\\b ' : ''}${prose(900, index + 1)}${index % 7 === 0 ? '\\b0 ' : ''}\\par\n`
    parts.push(paragraph)
    length += paragraph.length
  }
  parts.push('}')
  return Buffer.from(parts.join(''), 'latin1')
}

function bigOdt(xmlBytes) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content'
    + ' xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
    + ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>']
  let length = 0
  for (let index = 0; length < xmlBytes; index++) {
    const paragraph = `<text:p text:style-name="P1">${prose(600, index + 1)} <text:span text:style-name="T1">${prose(60, index + 9)}</text:span></text:p>\n`
    parts.push(paragraph)
    length += paragraph.length
  }
  parts.push('</office:text></office:body></office:document-content>')
  return zipBytes([
    { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text'), method: 0 },
    { name: 'content.xml', data: Buffer.from(parts.join('')) },
  ])
}

// ---- the fixture table ----------------------------------------------------

const tar = (...args) => execFileSync(TAR, args, { stdio: ['ignore', 'ignore', 'pipe'] })

/** A fixture made from another one, which is built first and passed in as `source`. */
const derived = (from, build) => ({ from, build })

/** name → builder writing `path`, or a `derived` fixture. */
const BUILDERS = {
  // 5 GiB ZIP64, and the same bytes under other suffixes for the streaming routes.
  'huge.zip': (path) => hugeZip(path, 5 * GIB),
  'huge.mp4': derived('huge.zip', (path, source) => linkSync(source, path)),
  'huge.heic': derived('huge.zip', (path, source) => linkSync(source, path)),
  'huge.iso': derived('huge.zip', (path, source) => linkSync(source, path)),

  // Many entries.
  'many.zip': (path) => writeFileSync(path, zipBytes(Array.from({ length: 200000 }, (_, index) => ({
    name: `dir-${index % 500}/entry-${index}.txt`, data: Buffer.alloc(0), method: 0,
  })))),
  'wide.tar': (path) => writeFileSync(path, wideTar(150000, 512, 28 * MIB)),
  'names.tar': (path) => writeFileSync(path, wideTar(100000, 0, 0)),
  'names.7z': derived('names.tar', (path, source) => tar('-c', '--format=7zip', '-f', path, `@${source}`)),

  // Decompression bombs: tiny on disk, 500 MiB once expanded.
  'zeros.tar': (path) => zerosTar(path, 500 * MIB),
  'zeros.tar.gz': derived('zeros.tar', (path, source) => tar('-c', '-z', '-f', path, `@${source}`)),
  'zeros.tar.bz2': derived('zeros.tar', (path, source) => tar('-c', '-j', '-f', path, `@${source}`)),
  'zeros.tar.xz': derived('zeros.tar', (path, source) => tar('-c', '-J', '-f', path, `@${source}`)),
  'zeros.tar.zst': derived('zeros.tar', (path, source) => tar('-c', '--zstd', '-f', path, `@${source}`)),
  // A bare stream that expands past the 512 MiB output cap.
  'bomb.gz': (path) => pipeline(
    Readable.from((function* zeros() { const block = Buffer.alloc(MIB); for (let index = 0; index < 600; index++) yield block })()),
    createGzip(),
    createWriteStream(path),
  ),

  // Realistic text through the pure-JS bzip2 and xz decoders.
  'text.tar': (path) => writeFileSync(path, textTar(32, MIB)),
  'text.tar.bz2': derived('text.tar', (path, source) => tar('-c', '-j', '-f', path, `@${source}`)),
  'text.tar.xz': derived('text.tar', (path, source) => tar('-c', '-J', '-f', path, `@${source}`)),

  // Rasters: one near the file-size cap, two that are small files but huge images.
  'photo.tiff': (path) => writeFileSync(path, tiff(5600, 5600, 1, photoPixels(5600, 5600))),
  'blank.tiff': (path) => writeFileSync(path, tiff(8192, 8192, 8, deflateSync(Buffer.alloc(8192 * 8192 * 3)))),
  'blank.psd': (path) => writeFileSync(path, blankPsd(8192, 8192)),

  // Documents.
  'long.rtf': (path) => writeFileSync(path, bigRtf(90 * MIB)),
  'long.odt': (path) => writeFileSync(path, bigOdt(60 * MIB)),

  // A real font padded to just under the 64 MiB cap.
  'padded.ttf': (path) => {
    const source = SYSTEM_FONTS.filter((font) => font.endsWith('.ttf')).find((font) => existsSync(font))
    if (source === undefined) throw new Error('no system TrueType font to pad')
    copyFileSync(source, path)
    const fd = openSync(path, 'r+')
    try { ftruncateSync(fd, 63 * MIB) } finally { closeSync(fd) }
  },
}

/**
 * Build the named fixtures (and whatever they are derived from) into `dir`.
 * Existing files are reused, so a kept directory makes reruns fast.
 * @returns {Promise<{ available: Set<string>, unavailable: Map<string, string> }>}
 */
export async function buildFixtures(dir, names, log = () => {}) {
  const available = new Set()
  const unavailable = new Map()
  const build = async (name) => {
    if (available.has(name)) return join(dir, name)
    if (unavailable.has(name)) throw new Error(unavailable.get(name))
    const path = join(dir, name)
    if (!existsSync(path)) {
      const started = Date.now()
      const builder = BUILDERS[name]
      try {
        if (typeof builder === 'function') await builder(path)
        else await builder.build(path, await build(builder.from))
      } catch (error) {
        // A half-written file must not be mistaken for a finished fixture next time.
        rmSync(path, { force: true })
        const reason = String(error?.stderr?.toString().trim() || error?.message || error).split('\n')[0]
        unavailable.set(name, reason)
        throw new Error(reason)
      }
      log(`  built ${name.padEnd(14)} ${(statSync(path).size / MIB).toFixed(1).padStart(8)} MiB  in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    }
    available.add(name)
    return path
  }
  for (const name of names) {
    try { await build(name) } catch { /* recorded in `unavailable` */ }
  }
  return { available, unavailable }
}
