/**
 * Decode raster formats Chromium cannot render into PNG bytes.
 *
 * The Sidebar preview handles files that DSH's builtin preview refuses. TIFF,
 * PSD and camera raw belong to that set: no browser paints them, so the Host
 * decodes the pixels here and hands the Sidebar a PNG instead.
 *
 * - Self-contained: Node builtins only (`node:zlib`), no state, no I/O.
 * - Bounded: the caller caps the input size; this module caps the pixel count
 *   and every decompressed block, so a hostile header cannot allocate wildly.
 * - Defensive: every read is bounds-checked. A file that is recognisably one of
 *   the supported formats but cannot be decoded raises `RasterError`; anything
 *   else is reported as `undefined` so the caller can fall back to a byte dump.
 */
import { deflateSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'

/** Largest image this module will materialise, in pixels (64 Mi px ≈ 67 MP). */
const PIXEL_CAP = 64 * 1024 * 1024

/** PNG file signature. */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Byte width of each TIFF field type we can read. */
const TIFF_TYPE_SIZES = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  16: 8, // LONG8
  17: 8, // SLONG8
  18: 8, // IFD8
}

/** Channels each PSD colour mode stores before any alpha channel. */
const PSD_BASE_CHANNELS = { 1: 1, 3: 3, 4: 4, 7: 1, 9: 3 }

/** Human names for the PSD colour modes we recognise but do not convert. */
const PSD_MODE_NAMES = { 0: 'bitmap', 1: 'grayscale', 2: 'indexed', 3: 'RGB', 4: 'CMYK', 7: 'multichannel', 8: 'duotone', 9: 'Lab' }

/** Decode failure that the caller can distinguish by kind. */
export class RasterError extends Error {
  /**
   * @param {'unsupported'|'invalid'|'too-large'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'RasterError'
    this.code = code
  }
}

/**
 * Decode a raster image the browser cannot render into PNG bytes.
 * @param {Uint8Array} bytes  whole file (caller enforces a size cap before calling)
 * @returns {{ png: Uint8Array, width: number, height: number, note?: string } | undefined}
 *   `undefined` when the format is unrecognised; throw RasterError when recognised but undecodable.
 */
export function rasterToPng(bytes) {
  const view = asBytes(bytes)
  switch (sniffRaster(view)) {
    case 'tiff':
      return guarded(() => decodeTiff(view))
    case 'psd':
      return guarded(() => decodePsd(view))
    default:
      // PNG/JPEG/GIF/BMP/WebP need no help: the browser renders those itself.
      return undefined
  }
}

/** @param {Uint8Array} bytes @returns {'tiff'|'psd'|'png'|'jpeg'|'gif'|'bmp'|'webp'|undefined} */
export function sniffRaster(bytes) {
  const view = asBytes(bytes)
  const at = (index) => (index < view.length ? view[index] : -1)
  if (at(0) === 0x49 && at(1) === 0x49) {
    // Classic TIFF (42) and BigTIFF (43), little-endian.
    if (at(2) === 0x2a && at(3) === 0x00) return 'tiff'
    if (at(2) === 0x2b && at(3) === 0x00) return 'tiff'
  }
  if (at(0) === 0x4d && at(1) === 0x4d) {
    // Big-endian variants.
    if (at(2) === 0x00 && at(3) === 0x2a) return 'tiff'
    if (at(2) === 0x00 && at(3) === 0x2b) return 'tiff'
  }
  // Photoshop documents start with '8BPS'; version 2 is the large-document PSB.
  if (at(0) === 0x38 && at(1) === 0x42 && at(2) === 0x50 && at(3) === 0x53) return 'psd'
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'gif'
  if (at(0) === 0x42 && at(1) === 0x4d) return 'bmp'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'webp'
  return undefined
}

/**
 * Coerce a byte-ish argument into a plain view without copying.
 * @param {unknown} input
 * @returns {Uint8Array}
 */
function asBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return new Uint8Array(0)
}

/**
 * Run a decoder, normalising unexpected throws into `RasterError('invalid')`.
 * @template T
 * @param {() => T} run
 * @returns {T}
 */
function guarded(run) {
  try {
    return run()
  } catch (error) {
    if (error instanceof RasterError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new RasterError('invalid', message)
  }
}

/**
 * Read one unsigned 16-bit word.
 * @param {Uint8Array} bytes
 * @param {number} at
 * @param {'le' | 'be'} order
 * @returns {number}
 */
function read16(bytes, at, order) {
  return order === 'le' ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]
}

/**
 * Write one unsigned 16-bit word.
 * @param {Uint8Array} bytes
 * @param {number} at
 * @param {number} value
 * @param {'le' | 'be'} order
 */
function write16(bytes, at, value, order) {
  if (order === 'le') {
    bytes[at] = value & 0xff
    bytes[at + 1] = (value >> 8) & 0xff
  } else {
    bytes[at] = (value >> 8) & 0xff
    bytes[at + 1] = value & 0xff
  }
}

/**
 * Read one packed sample out of a row.
 * @param {Uint8Array} bytes
 * @param {number} base  first byte of the row
 * @param {number} index  sample index inside the row
 * @param {number} bits  1, 4, 8 or 16
 * @param {'le' | 'be'} order
 * @returns {number}
 */
function getSample(bytes, base, index, bits, order) {
  if (bits === 8) return bytes[base + index]
  if (bits === 16) return read16(bytes, base + index * 2, order)
  if (bits === 1) return (bytes[base + (index >> 3)] >> (7 - (index & 7))) & 1
  if (bits === 4) {
    const byte = bytes[base + (index >> 1)]
    return (index & 1) === 0 ? byte >> 4 : byte & 0x0f
  }
  throw new RasterError('unsupported', `TIFF samples of ${bits} bits are not supported`)
}

/**
 * Write one packed sample into a row.
 * @param {Uint8Array} bytes
 * @param {number} base
 * @param {number} index
 * @param {number} bits
 * @param {'le' | 'be'} order
 * @param {number} value
 */
function setSample(bytes, base, index, bits, order, value) {
  if (bits === 8) {
    bytes[base + index] = value
    return
  }
  if (bits === 16) {
    write16(bytes, base + index * 2, value, order)
    return
  }
  if (bits === 1) {
    const at = base + (index >> 3)
    const shift = 7 - (index & 7)
    bytes[at] = (bytes[at] & ~(1 << shift)) | ((value & 1) << shift)
    return
  }
  if (bits === 4) {
    const at = base + (index >> 1)
    bytes[at] = (index & 1) === 0 ? (bytes[at] & 0x0f) | ((value & 0x0f) << 4) : (bytes[at] & 0xf0) | (value & 0x0f)
    return
  }
  throw new RasterError('unsupported', `TIFF samples of ${bits} bits are not supported`)
}

/**
 * Bytes per row of packed samples.
 * @param {number} width
 * @param {number} samples
 * @param {number} bits
 * @returns {number}
 */
function rowStrideOf(width, samples, bits) {
  return Math.ceil((width * samples * bits) / 8)
}

/* ------------------------------------------------------------------------- *
 * PNG output
 * ------------------------------------------------------------------------- */

/** Lazily built CRC32 table (polynomial 0xEDB88320, the PNG one). */
let crcTable

/** @returns {Uint32Array} */
function crcLookup() {
  if (crcTable !== undefined) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

/**
 * CRC32 of a byte range, as PNG chunks use it.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function crc32(bytes, start, end) {
  const table = crcLookup()
  let crc = 0xffffffff
  for (let i = start; i < end; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build one PNG chunk: length, type, payload, CRC.
 * @param {string} type  four ASCII characters
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function pngChunk(type, payload) {
  const chunk = new Uint8Array(12 + payload.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, payload.length)
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(payload, 8)
  view.setUint32(8 + payload.length, crc32(chunk, 4, 8 + payload.length))
  return chunk
}

/**
 * Encode 8-bit interleaved pixels as a PNG.
 *
 * Every row uses filter 0 (None): the image is already deflated, and one filter
 * keeps the encoder obviously correct.
 * @param {Uint8Array} pixels  `width * height * channels` bytes
 * @param {number} width
 * @param {number} height
 * @param {number} channels  3 (RGB) or 4 (RGBA)
 * @returns {Uint8Array}
 */
function encodePng(pixels, width, height, channels) {
  const rowBytes = width * channels
  const raw = new Uint8Array((rowBytes + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const at = y * (rowBytes + 1)
    raw[at] = 0
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), at + 1)
  }
  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, width)
  header.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = channels === 4 ? 6 : 2 // colour type: truecolour, with or without alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const png = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    png.set(part, cursor)
    cursor += part.length
  }
  return png
}

/* ------------------------------------------------------------------------- *
 * Shared decoding helpers
 * ------------------------------------------------------------------------- */

/**
 * Inflate a zlib/raw-deflate/gzip stream, whichever it turns out to be.
 * @param {Uint8Array} data
 * @param {number} expected  ceiling for the decompressed size
 * @returns {Uint8Array}
 */
function inflateAny(data, expected) {
  const limit = Math.max(1024, expected)
  for (const inflate of [inflateSync, inflateRawSync, gunzipSync]) {
    try {
      return new Uint8Array(inflate(data, { maxOutputLength: limit }))
    } catch {
      // Try the next wrapper; the last failure is reported below.
    }
  }
  throw new RasterError('invalid', 'compressed image data could not be inflated')
}

/**
 * Decode PackBits (TIFF 32773 / PSD RLE) into exactly `expected` bytes.
 * @param {Uint8Array} data
 * @param {number} expected
 * @returns {Uint8Array}
 */
function packBitsDecode(data, expected) {
  const out = new Uint8Array(expected)
  let read = 0
  let write = 0
  while (read < data.length && write < expected) {
    const header = data[read]
    read += 1
    if (header < 128) {
      const count = header + 1
      if (write + count > expected || read + count > data.length) throw new RasterError('invalid', 'PackBits run overruns its strip')
      out.set(data.subarray(read, read + count), write)
      read += count
      write += count
    } else if (header > 128) {
      const count = 257 - header
      if (write + count > expected || read >= data.length) throw new RasterError('invalid', 'PackBits run overruns its strip')
      out.fill(data[read], write, write + count)
      read += 1
      write += count
    }
  }
  return write === expected ? out : out.subarray(0, write)
}

/**
 * Decode TIFF LZW: 9- to 12-bit codes, MSB-first, clear 256, end 257.
 *
 * TIFF uses the Aldus variant, whose code width grows one code earlier than
 * textbook LZW: the decoder widens once its next free slot passes
 * `MAXCODE(width) - 1`, so entry 510 is the last 9-bit one (libtiff's
 * `tif_lzw.c` sets `lzw_maxcode = MAXCODE(BITS_MIN) - 1`). Files written by a
 * strictly conformant encoder exist too, so the other rule is tried as well.
 * @param {Uint8Array} data
 * @param {number} expected  ceiling for the decompressed size
 * @returns {Uint8Array}
 */
function lzwDecode(data, expected) {
  // A leading zero byte followed by an odd byte marks the pre-6.0 bit-reversed
  // encoding, which is a different format rather than a broken stream.
  if (data.length >= 2 && data[0] === 0 && (data[1] & 1) === 1) {
    throw new RasterError('unsupported', 'TIFF with old-style bit-reversed LZW is not supported')
  }
  try {
    return lzwDecodeWith(data, expected, true)
  } catch (error) {
    if (!(error instanceof RasterError)) throw error
    return lzwDecodeWith(data, expected, false)
  }
}

/**
 * Decode LZW with one specific code-width growth rule.
 * @param {Uint8Array} data
 * @param {number} expected  ceiling for the decompressed size
 * @param {boolean} earlyChange  Aldus rule (grow one code early) when true
 * @returns {Uint8Array}
 */
function lzwDecodeWith(data, expected, earlyChange) {
  const limit = expected
  const prefix = new Int32Array(4096).fill(-1)
  const suffix = new Uint8Array(4096)
  for (let i = 0; i < 256; i += 1) suffix[i] = i
  const stack = new Uint8Array(4096)
  let out = new Uint8Array(Math.max(1024, Math.min(limit, data.length * 8)))
  let produced = 0
  const totalBits = data.length * 8
  let bitPos = 0
  let width = 9
  let next = 258
  let previous = -1

  const firstCharOf = (code) => {
    let c = code
    while (prefix[c] >= 0) c = prefix[c]
    return suffix[c]
  }
  const emit = (code) => {
    let length = 0
    let c = code
    while (c >= 0) {
      if (length >= stack.length) throw new RasterError('invalid', 'LZW string is longer than its dictionary allows')
      stack[length] = suffix[c]
      length += 1
      c = prefix[c]
    }
    if (produced + length > limit) throw new RasterError('invalid', 'LZW strip expands past its expected size')
    if (produced + length > out.length) {
      const grown = new Uint8Array(Math.min(limit, Math.max(out.length * 2, produced + length)))
      grown.set(out.subarray(0, produced))
      out = grown
    }
    while (length > 0) {
      length -= 1
      out[produced] = stack[length]
      produced += 1
    }
  }

  for (;;) {
    if (bitPos + width > totalBits) break
    const byte = bitPos >> 3
    const shift = bitPos & 7
    const word = (data[byte] << 16) | ((data[byte + 1] ?? 0) << 8) | (data[byte + 2] ?? 0)
    const code = (word >> (24 - shift - width)) & ((1 << width) - 1)
    bitPos += width
    if (code === 256) {
      width = 9
      next = 258
      previous = -1
      continue
    }
    if (code === 257) break
    if (previous === -1) {
      if (code > 255) throw new RasterError('invalid', 'LZW strip starts with a dictionary code')
      emit(code)
      previous = code
      continue
    }
    let firstChar
    if (code < next) {
      firstChar = firstCharOf(code)
      emit(code)
    } else if (code === next) {
      firstChar = firstCharOf(previous)
      emit(previous)
      emit(firstChar)
    } else {
      throw new RasterError('invalid', 'LZW strip references an undefined code')
    }
    if (next < 4096) {
      prefix[next] = previous
      suffix[next] = firstChar
      next += 1
      const grows = earlyChange ? next > (1 << width) - 2 : next > (1 << width) - 1
      if (grows && width < 12) width += 1
    }
    previous = code
  }
  return produced === out.length ? out : out.subarray(0, produced)
}

/**
 * Reverse horizontal differencing (Predictor 2) in place.
 * @param {Uint8Array} block
 * @param {number} rowBytes  bytes per row inside the block
 * @param {number} bits  8 or 16
 * @param {number} samples  differencing stride (samples per pixel)
 * @param {'le' | 'be'} order
 */
function undoPredictor(block, rowBytes, bits, samples, order) {
  if (bits === 8) {
    for (let row = 0; row + rowBytes <= block.length; row += rowBytes) {
      const end = row + rowBytes
      for (let i = row + samples; i < end; i += 1) block[i] = (block[i] + block[i - samples]) & 0xff
    }
    return
  }
  const perRow = rowBytes >> 1
  for (let row = 0; row + rowBytes <= block.length; row += rowBytes) {
    for (let i = samples; i < perRow; i += 1) {
      const at = row + i * 2
      const previous = row + (i - samples) * 2
      write16(block, at, (read16(block, at, order) + read16(block, previous, order)) & 0xffff, order)
    }
  }
}

/**
 * Expand a block of compressed image data.
 * @param {Uint8Array} raw
 * @param {number} compression
 * @param {number} expected  exact decompressed size of the block
 * @returns {Uint8Array}
 */
function decompressBlock(raw, compression, expected) {
  switch (compression) {
    case 1:
      return raw
    case 5:
      return lzwDecode(raw, expected)
    case 8:
    case 32946:
      return inflateAny(raw, expected)
    case 32773:
      return packBitsDecode(raw, expected)
    default:
      throw new RasterError('unsupported', `TIFF compression ${compression} is not supported`)
  }
}

/* ------------------------------------------------------------------------- *
 * TIFF
 * ------------------------------------------------------------------------- */

/** Bounds-checked reader for one TIFF file. */
class TiffReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    if (bytes.length < 8) throw new RasterError('invalid', 'TIFF header is truncated')
    this.bytes = bytes
    this.order = bytes[0] === 0x49 && bytes[1] === 0x49 ? 'le' : 'be'
    const magic = this.u16(2)
    if (magic !== 42 && magic !== 43) throw new RasterError('invalid', `TIFF magic ${magic} is not 42 or 43`)
    this.bigTiff = magic === 43
    this.firstIfd = this.bigTiff ? this.u64(8) : this.u32(4)
  }

  /** @param {number} at @returns {number} */
  u8(at) {
    if (at < 0 || at + 1 > this.bytes.length) throw new RasterError('invalid', 'TIFF read past end of file')
    return this.bytes[at]
  }

  /** @param {number} at @returns {number} */
  u16(at) {
    if (at < 0 || at + 2 > this.bytes.length) throw new RasterError('invalid', 'TIFF read past end of file')
    return read16(this.bytes, at, this.order)
  }

  /** @param {number} at @returns {number} */
  u32(at) {
    if (at < 0 || at + 4 > this.bytes.length) throw new RasterError('invalid', 'TIFF read past end of file')
    return this.order === 'le'
      ? (this.bytes[at] | (this.bytes[at + 1] << 8) | (this.bytes[at + 2] << 16) | (this.bytes[at + 3] << 24)) >>> 0
      : ((this.bytes[at] << 24) | (this.bytes[at + 1] << 16) | (this.bytes[at + 2] << 8) | this.bytes[at + 3]) >>> 0
  }

  /** @param {number} at @returns {number} */
  u64(at) {
    const lo = this.u32(this.order === 'le' ? at : at + 4)
    const hi = this.u32(this.order === 'le' ? at + 4 : at)
    return hi * 0x100000000 + lo
  }

  /**
   * Read one IFD into `tag -> values` plus the offset of the next IFD.
   * @param {number} offset
   * @returns {{ tags: Map<number, number[]>, next: number }}
   */
  readIfd(offset) {
    const count = this.bigTiff ? this.u64(offset) : this.u16(offset)
    if (count > 65535) throw new RasterError('invalid', 'TIFF IFD declares an implausible number of entries')
    const entrySize = this.bigTiff ? 20 : 12
    const base = offset + (this.bigTiff ? 8 : 2)
    const valueField = this.bigTiff ? 8 : 4
    const valueStart = this.bigTiff ? 12 : 8
    const tags = new Map()
    for (let i = 0; i < count; i += 1) {
      const at = base + i * entrySize
      const tag = this.u16(at)
      const type = this.u16(at + 2)
      const n = this.bigTiff ? this.u64(at + 4) : this.u32(at + 4)
      const size = TIFF_TYPE_SIZES[type]
      // RATIONAL/FLOAT/DOUBLE carry nothing we decode; skipping them keeps the
      // reader honest instead of inventing values.
      if (size === undefined || type === 2) continue
      const total = n * size
      if (total > this.bytes.length) throw new RasterError('invalid', `TIFF tag ${tag} overruns the file`)
      const valueAt = total <= valueField ? at + valueStart : this.bigTiff ? this.u64(at + 12) : this.u32(at + 8)
      const values = []
      for (let k = 0; k < n; k += 1) {
        const p = valueAt + k * size
        values.push(type === 16 || type === 18 ? this.u64(p) : size === 1 ? this.u8(p) : size === 2 ? this.u16(p) : this.u32(p))
      }
      tags.set(tag, values)
    }
    return { tags, next: this.bigTiff ? this.u64(base + count * 20) : this.u32(base + count * 12) }
  }
}

/**
 * Decode the first decodable page of a TIFF.
 *
 * IFD0 is tried first, then any SubIFDs: DNG stores a full-resolution raw image
 * in IFD0 and printable previews in the sub-IFDs, so a preview page is the only
 * thing a non-demosaicing decoder can render.
 * @param {Uint8Array} bytes
 * @returns {{ png: Uint8Array, width: number, height: number, note?: string }}
 */
function decodeTiff(bytes) {
  const tiff = new TiffReader(bytes)
  const first = tiff.readIfd(tiff.firstIfd)
  const candidates = [first.tags]
  for (const offset of first.tags.get(330) ?? []) {
    try {
      candidates.push(tiff.readIfd(offset).tags)
    } catch {
      // A dangling SubIFD offset is not fatal; the other pages may still work.
    }
  }
  let refusal
  for (const tags of candidates) {
    try {
      return decodeTiffPage(tiff, bytes, tags)
    } catch (error) {
      if (error instanceof RasterError && error.code === 'unsupported') {
        refusal = refusal ?? error
        continue
      }
      throw error
    }
  }
  throw refusal ?? new RasterError('unsupported', 'TIFF has no decodable image page')
}

/**
 * Decode one TIFF IFD.
 * @param {TiffReader} tiff
 * @param {Uint8Array} bytes
 * @param {Map<number, number[]>} tags
 * @returns {{ png: Uint8Array, width: number, height: number, note?: string }}
 */
function decodeTiffPage(tiff, bytes, tags) {
  const width = tags.get(256)?.[0]
  const height = tags.get(257)?.[0]
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RasterError('invalid', 'TIFF image page has no usable dimensions')
  }
  if (width * height > PIXEL_CAP) {
    throw new RasterError('too-large', `TIFF image is ${width}×${height}, above the ${PIXEL_CAP} pixel cap`)
  }

  const samples = tags.get(277)?.[0] ?? 1
  const bitsList = tags.get(258) ?? [1]
  const bits = bitsList[0]
  const compression = tags.get(259)?.[0] ?? 1
  const photometric = tags.get(262)?.[0] ?? (samples >= 3 ? 2 : 1)
  const planar = tags.get(284)?.[0] ?? 1
  const predictor = tags.get(317)?.[0] ?? 1
  const extras = tags.get(338) ?? []

  if (samples < 1 || samples > 4) throw new RasterError('unsupported', `TIFF with ${samples} samples per pixel is not supported`)
  if (bitsList.some((value) => value !== bits)) throw new RasterError('unsupported', 'TIFF with mixed bit depths per sample is not supported')
  if (planar !== 1) throw new RasterError('unsupported', 'TIFF with separate colour planes (PlanarConfiguration 2) is not supported')
  if (bits !== 1 && bits !== 4 && bits !== 8 && bits !== 16) throw new RasterError('unsupported', `TIFF samples of ${bits} bits are not supported`)
  if (compression === 2 || compression === 3 || compression === 4) throw new RasterError('unsupported', `TIFF compression ${compression} (CCITT/Group 3/4 fax) is not supported`)
  if (compression === 7) throw new RasterError('unsupported', 'TIFF compression 7 (embedded JPEG) is not supported')
  if (compression !== 1 && compression !== 5 && compression !== 8 && compression !== 32946 && compression !== 32773) {
    throw new RasterError('unsupported', `TIFF compression ${compression} is not supported`)
  }
  if (photometric === 6) throw new RasterError('unsupported', 'TIFF photometric 6 (YCbCr) is not supported')
  if (photometric === 8) throw new RasterError('unsupported', 'TIFF photometric 8 (CIELab) is not supported')
  if (photometric === 32803) throw new RasterError('unsupported', 'camera raw (CFA) image data is not supported: no demosaicing here')
  if (photometric !== 0 && photometric !== 1 && photometric !== 2 && photometric !== 3 && photometric !== 5) {
    throw new RasterError('unsupported', `TIFF photometric ${photometric} is not supported`)
  }
  if (predictor !== 1 && predictor !== 2) throw new RasterError('unsupported', `TIFF predictor ${predictor} is not supported`)
  if (predictor === 2 && bits !== 8 && bits !== 16) throw new RasterError('unsupported', `TIFF predictor 2 with ${bits}-bit samples is not supported`)

  const rowStride = rowStrideOf(width, samples, bits)
  const packed = new Uint8Array(rowStride * height)
  const notes = []

  if (tags.has(324)) {
    const tileWidth = tags.get(322)?.[0]
    const tileLength = tags.get(323)?.[0]
    const offsets = tags.get(324) ?? []
    const counts = tags.get(325) ?? []
    if (!tileWidth || !tileLength) throw new RasterError('invalid', 'tiled TIFF without tile dimensions')
    const across = Math.ceil(width / tileWidth)
    const down = Math.ceil(height / tileLength)
    if (offsets.length < across * down) throw new RasterError('invalid', 'tiled TIFF has fewer tiles than its geometry needs')
    const tileRowStride = rowStrideOf(tileWidth, samples, bits)
    for (let ty = 0; ty < down; ty += 1) {
      for (let tx = 0; tx < across; tx += 1) {
        const index = ty * across + tx
        const block = readBlock(bytes, offsets, counts, index, compression, tileRowStride * tileLength)
        if (predictor === 2) undoPredictor(block, tileRowStride, bits, samples, tiff.order)
        const x0 = tx * tileWidth
        const y0 = ty * tileLength
        const copyWidth = Math.min(tileWidth, width - x0)
        const rows = Math.min(tileLength, height - y0)
        for (let r = 0; r < rows; r += 1) {
          copyRow(block, r * tileRowStride, packed, (y0 + r) * rowStride, x0, copyWidth, samples, bits, tiff.order)
        }
      }
    }
  } else {
    const offsets = tags.get(273)
    if (offsets === undefined || offsets.length === 0) throw new RasterError('invalid', 'TIFF image page has no strip offsets')
    const counts = tags.get(279) ?? []
    const rowsPerStrip = Math.min(tags.get(278)?.[0] ?? height, height)
    let y = 0
    for (let i = 0; i < offsets.length && y < height; i += 1) {
      const rows = Math.min(rowsPerStrip, height - y)
      const block = readBlock(bytes, offsets, counts, i, compression, rows * rowStride)
      if (predictor === 2) undoPredictor(block, rowStride, bits, samples, tiff.order)
      const take = Math.min(block.length, rows * rowStride)
      packed.set(block.subarray(0, take), y * rowStride)
      y += rows
    }
  }

  const scaled = scaleSamples(packed, width, height, samples, bits, photometric, tiff.order)
  const colorMap = tags.get(320)
  const base = photometric === 5 ? 4 : photometric === 2 ? 3 : 1
  const hasAlpha = samples > base
  const { pixels, channels } = toRgb(scaled, width, height, samples, photometric, hasAlpha, colorMap, bits)
  if (photometric === 5) notes.push('CMYK converted with a naive 255-(x+k) formula')
  if (bits === 16) notes.push('16-bit samples reduced to their high byte')
  if (extras.length > 0 && extras[0] === 1) notes.push('associated (premultiplied) alpha passed through as-is')
  return { png: encodePng(pixels, width, height, channels), width, height, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) }
}

/**
 * Read one strip or tile and decompress it.
 * @param {Uint8Array} bytes
 * @param {number[]} offsets
 * @param {number[]} counts
 * @param {number} index
 * @param {number} compression
 * @param {number} expected  decompressed size of the block
 * @returns {Uint8Array}
 */
function readBlock(bytes, offsets, counts, index, compression, expected) {
  const start = offsets[index]
  let length = counts[index]
  if (length === undefined) {
    // Some writers omit StripByteCounts; the next offset, or the end of the
    // file, then bounds the block.
    const next = offsets[index + 1]
    length = next !== undefined && next > start ? next - start : bytes.length - start
  }
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0 || start + length > bytes.length) {
    throw new RasterError('invalid', 'TIFF strip or tile lies outside the file')
  }
  return decompressBlock(bytes.subarray(start, start + length), compression, expected)
}

/**
 * Copy one row out of a tile into the packed image.
 * @param {Uint8Array} source
 * @param {number} sourceBase
 * @param {Uint8Array} dest
 * @param {number} destBase
 * @param {number} x0  first pixel of the row inside the image
 * @param {number} width  pixels to copy
 * @param {number} samples
 * @param {number} bits
 * @param {'le' | 'be'} order
 */
function copyRow(source, sourceBase, dest, destBase, x0, width, samples, bits, order) {
  const count = width * samples
  if (bits === 8 || bits === 16) {
    const step = bits === 8 ? 1 : 2
    dest.set(source.subarray(sourceBase, sourceBase + count * step), destBase + x0 * samples * step)
    return
  }
  for (let i = 0; i < count; i += 1) setSample(dest, destBase, x0 * samples + i, bits, order, getSample(source, sourceBase, i, bits, order))
}

/**
 * Turn packed samples into one byte per sample (0-255).
 * @param {Uint8Array} packed
 * @param {number} width
 * @param {number} height
 * @param {number} samples
 * @param {number} bits
 * @param {number} photometric
 * @param {'le' | 'be'} order
 * @returns {Uint8Array}
 */
function scaleSamples(packed, width, height, samples, bits, photometric, order) {
  const count = width * height * samples
  if (bits === 8) return packed.subarray(0, count)
  const pixels = new Uint8Array(count)
  const rowStride = rowStrideOf(width, samples, bits)
  const scale = bits === 1 ? 255 : bits === 4 ? 17 : 1
  const raw = photometric === 3
  for (let y = 0; y < height; y += 1) {
    const rowBase = y * rowStride
    const dest = y * width * samples
    for (let i = 0; i < width * samples; i += 1) {
      const value = getSample(packed, rowBase, i, bits, order)
      pixels[dest + i] = raw ? value : bits === 16 ? value >> 8 : value * scale
    }
  }
  return pixels
}

/**
 * Expand decoded samples into 8-bit RGB or RGBA.
 * @param {Uint8Array} samples
 * @param {number} width
 * @param {number} height
 * @param {number} count  samples per pixel
 * @param {number} photometric
 * @param {boolean} hasAlpha
 * @param {number[] | undefined} colorMap
 * @param {number} bits
 * @returns {{ pixels: Uint8Array, channels: number }}
 */
function toRgb(samples, width, height, count, photometric, hasAlpha, colorMap, bits) {
  const total = width * height
  const channels = hasAlpha ? 4 : 3
  // RGB or RGBA samples are already the output layout: no second full-size buffer.
  if (photometric === 2 && count === channels) return { pixels: samples.subarray(0, total * channels), channels }
  const pixels = new Uint8Array(total * channels)
  const entries = colorMap === undefined ? 0 : Math.floor(colorMap.length / 3)
  for (let i = 0; i < total; i += 1) {
    const s = i * count
    const o = i * channels
    if (photometric === 2) {
      pixels[o] = samples[s]
      pixels[o + 1] = samples[s + 1]
      pixels[o + 2] = samples[s + 2]
    } else if (photometric === 5) {
      const k = samples[s + 3]
      pixels[o] = 255 - Math.min(255, samples[s] + k)
      pixels[o + 1] = 255 - Math.min(255, samples[s + 1] + k)
      pixels[o + 2] = 255 - Math.min(255, samples[s + 2] + k)
    } else if (photometric === 3) {
      const index = Math.min(samples[s], entries - 1)
      pixels[o] = entries > 0 ? (colorMap[index] ?? 0) >> 8 : 0
      pixels[o + 1] = entries > 0 ? (colorMap[index + entries] ?? 0) >> 8 : 0
      pixels[o + 2] = entries > 0 ? (colorMap[index + entries * 2] ?? 0) >> 8 : 0
    } else {
      const gray = photometric === 0 ? 255 - samples[s] : samples[s]
      pixels[o] = gray
      pixels[o + 1] = gray
      pixels[o + 2] = gray
    }
    if (hasAlpha) pixels[o + 3] = samples[s + count - 1]
  }
  return { pixels, channels }
}

/* ------------------------------------------------------------------------- *
 * PSD / PSB
 * ------------------------------------------------------------------------- */

/**
 * Decode the merged composite of a Photoshop document.
 * @param {Uint8Array} bytes
 * @returns {{ png: Uint8Array, width: number, height: number, note?: string }}
 */
function decodePsd(bytes) {
  if (bytes.length < 26) throw new RasterError('invalid', 'PSD header is truncated')
  if (bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53) throw new RasterError('invalid', 'PSD signature is not 8BPS')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint16(4)
  if (version !== 1 && version !== 2) throw new RasterError('unsupported', `PSD version ${version} is not supported`)
  const psb = version === 2
  const channels = view.getUint16(12)
  const height = view.getUint32(14)
  const width = view.getUint32(18)
  const depth = view.getUint16(22)
  const mode = view.getUint16(24)

  if (width <= 0 || height <= 0 || channels <= 0) throw new RasterError('invalid', 'PSD declares an empty image')
  if (width * height > PIXEL_CAP) throw new RasterError('too-large', `PSD image is ${width}×${height}, above the ${PIXEL_CAP} pixel cap`)
  if (depth !== 8 && depth !== 16) throw new RasterError('unsupported', `PSD with ${depth}-bit channels is not supported`)
  const base = PSD_BASE_CHANNELS[mode]
  if (base === undefined) throw new RasterError('unsupported', `PSD colour mode ${mode} (${PSD_MODE_NAMES[mode] ?? 'unknown'}) is not supported`)
  if (channels < base) throw new RasterError('invalid', `PSD ${PSD_MODE_NAMES[mode]} image declares only ${channels} channel(s)`)

  let offset = 26
  offset = skipPsdSection(bytes, offset, 4, 'colour mode data')
  offset = skipPsdSection(bytes, offset, 4, 'image resources')
  const layerStart = offset
  const layerLength = psb ? readU64At(bytes, offset) : readU32At(bytes, offset)
  if (!Number.isFinite(layerLength) || layerLength < 0) throw new RasterError('invalid', 'PSD layer section has a bogus length')
  offset += (psb ? 8 : 4) + layerLength
  if (offset + 2 > bytes.length) throw new RasterError('unsupported', 'no merged composite')

  // A negative layer count marks the first extra channel as the merged
  // result's transparency; either way that channel is the alpha we keep.
  const layerCount = readPsdLayerCount(bytes, layerStart, psb)
  const hasAlpha = channels > base

  const compression = readU16At(bytes, offset)
  offset += 2
  const bytesPerSample = depth >> 3
  const rowSize = width * bytesPerSample
  const planeSize = rowSize * height
  const planes = []
  const notes = []

  if (compression === 0) {
    if (offset + planeSize * channels > bytes.length) throw new RasterError('invalid', 'PSD image data is truncated')
    for (let c = 0; c < channels; c += 1) {
      planes.push(bytes.subarray(offset, offset + planeSize))
      offset += planeSize
    }
  } else if (compression === 1) {
    const countBytes = psb ? 4 : 2
    const tableSize = countBytes * channels * height
    if (offset + tableSize > bytes.length) throw new RasterError('invalid', 'PSD RLE row-count table is truncated')
    const counts = new Array(channels * height)
    for (let i = 0; i < counts.length; i += 1) counts[i] = countBytes === 4 ? readU32At(bytes, offset + i * 4) : readU16At(bytes, offset + i * 2)
    offset += tableSize
    for (let c = 0; c < channels; c += 1) {
      const plane = new Uint8Array(planeSize)
      for (let y = 0; y < height; y += 1) {
        const length = counts[c * height + y]
        if (offset + length > bytes.length) throw new RasterError('invalid', 'PSD RLE row data is truncated')
        const row = packBitsDecode(bytes.subarray(offset, offset + length), rowSize)
        plane.set(row, y * rowSize)
        offset += length
      }
      planes.push(plane)
    }
  } else if (compression === 2 || compression === 3) {
    const expected = planeSize * channels
    const data = readPsdZip(bytes, offset, expected, planeSize, channels)
    if (compression === 3) {
      for (let c = 0; c < channels; c += 1) undoPsdPrediction(data.subarray(c * planeSize, (c + 1) * planeSize), rowSize, depth)
    }
    for (let c = 0; c < channels; c += 1) planes.push(data.subarray(c * planeSize, (c + 1) * planeSize))
    if (compression === 3) notes.push('ZIP prediction undone per row')
  } else {
    throw new RasterError('unsupported', `PSD compression ${compression} is not supported`)
  }

  const total = width * height
  const outChannels = hasAlpha ? 4 : 3
  const pixels = new Uint8Array(total * outChannels)
  const sample = (channel, index) => (depth === 16 ? planes[channel][index * 2] : planes[channel][index])
  for (let i = 0; i < total; i += 1) {
    const o = i * outChannels
    if (mode === 3) {
      pixels[o] = sample(0, i)
      pixels[o + 1] = sample(1, i)
      pixels[o + 2] = sample(2, i)
    } else if (mode === 4) {
      // PSD stores CMYK inverted: 0 means full ink and 255 means no ink, so the
      // additive formula lands as `stored + storedK - 255` per channel.
      const k = sample(3, i)
      pixels[o] = clampByte(sample(0, i) + k - 255)
      pixels[o + 1] = clampByte(sample(1, i) + k - 255)
      pixels[o + 2] = clampByte(sample(2, i) + k - 255)
    } else if (mode === 9) {
      const [r, g, b] = labToRgb(sample(0, i), sample(1, i), sample(2, i))
      pixels[o] = r
      pixels[o + 1] = g
      pixels[o + 2] = b
    } else {
      // Grayscale, and multichannel (which has no defined colour space) read
      // as the first channel repeated.
      const gray = sample(0, i)
      pixels[o] = gray
      pixels[o + 1] = gray
      pixels[o + 2] = gray
    }
    if (hasAlpha) pixels[o + 3] = sample(channels - 1, i)
  }

  if (mode === 4) notes.push('CMYK converted with a naive 255-(x+k) formula')
  if (mode === 7) notes.push('multichannel document rendered from its first channel as grayscale')
  if (mode === 9) notes.push('Lab converted to sRGB')
  if (depth === 16) notes.push('16-bit channels reduced to their high byte')
  if (layerCount !== 0 && hasAlpha) notes.push('merged composite alpha kept from the extra channel')
  return { png: encodePng(pixels, width, height, outChannels), width, height, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) }
}

/**
 * Clamp a number into the 0-255 byte range.
 * @param {number} value
 * @returns {number}
 */
function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/**
 * Convert one PSD Lab sample triple to sRGB.
 *
 * PSD stores L as `L* * 255 / 100` and a/b as `a* + 128` / `b* + 128`.
 * @param {number} l 0-255
 * @param {number} a 0-255
 * @param {number} b 0-255
 * @returns {[number, number, number]} 8-bit sRGB
 */
function labToRgb(l, a, b) {
  const lightness = (l * 100) / 255
  const aStar = a - 128
  const bStar = b - 128
  // Lab -> XYZ (D50 white point), then XYZ -> linear sRGB, then gamma encode.
  const fy = (lightness + 16) / 116
  const fx = fy + aStar / 500
  const fz = fy - bStar / 200
  const pivot = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787)
  const x = (0.9642 * pivot(fx)) / 0.9642
  const y = pivot(fy)
  const z = pivot(fz)
  const linear = [
    3.1338561 * x - 1.6168667 * y - 0.4906146 * z,
    -0.9787684 * x + 1.9161415 * y + 0.033454 * z,
    0.0719453 * x - 0.2289914 * y + 1.4052427 * z,
  ]
  return linear.map((value) => {
    const clamped = Math.max(0, Math.min(1, value))
    const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
    return Math.round(Math.max(0, Math.min(1, encoded)) * 255)
  })
}

/**
 * Inflate the merged composite's ZIP data.
 *
 * Photoshop writes one zlib stream covering every channel; some writers emit
 * one stream per channel instead, so a short whole-buffer inflate falls back to
 * a per-channel walk.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} expected  total decompressed size of all channels
 * @param {number} planeSize
 * @param {number} channels
 * @returns {Uint8Array}
 */
function readPsdZip(bytes, offset, expected, planeSize, channels) {
  const body = bytes.subarray(offset)
  try {
    const whole = new Uint8Array(inflateSync(body, { maxOutputLength: expected }))
    if (whole.length >= expected) return whole
  } catch {
    // Fall through to the per-channel layout.
  }
  const out = new Uint8Array(expected)
  let cursor = offset
  for (let c = 0; c < channels; c += 1) {
    if (cursor >= bytes.length) break
    let consumed = 0
    try {
      const result = inflateSync(bytes.subarray(cursor), { info: true })
      const data = new Uint8Array(result.buffer)
      consumed = result.engine?.bytesWritten ?? 0
      out.set(data.subarray(0, Math.min(planeSize, data.length)), c * planeSize)
    } catch {
      throw new RasterError('invalid', 'PSD ZIP channel data could not be inflated')
    }
    if (consumed <= 0) break
    cursor += consumed
  }
  return out
}

/**
 * Undo the per-row delta of PSD's "ZIP with prediction".
 * @param {Uint8Array} plane
 * @param {number} rowSize  bytes per row
 * @param {number} depth
 */
function undoPsdPrediction(plane, rowSize, depth) {
  for (let row = 0; row + rowSize <= plane.length; row += rowSize) {
    if (depth === 8) {
      for (let i = row + 1; i < row + rowSize; i += 1) plane[i] = (plane[i] + plane[i - 1]) & 0xff
    } else {
      for (let i = row + 2; i < row + rowSize; i += 2) {
        const value = (((plane[i] << 8) | plane[i + 1]) + ((plane[i - 2] << 8) | plane[i - 1])) & 0xffff
        plane[i] = value >> 8
        plane[i + 1] = value & 0xff
      }
    }
  }
}

/**
 * Read a 32-bit big-endian word.
 * @param {Uint8Array} bytes @param {number} at @returns {number}
 */
function readU32At(bytes, at) {
  if (at < 0 || at + 4 > bytes.length) throw new RasterError('invalid', 'PSD read past end of file')
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

/**
 * Read a 16-bit big-endian word.
 * @param {Uint8Array} bytes @param {number} at @returns {number}
 */
function readU16At(bytes, at) {
  if (at < 0 || at + 2 > bytes.length) throw new RasterError('invalid', 'PSD read past end of file')
  return (bytes[at] << 8) | bytes[at + 1]
}

/**
 * Read a 64-bit big-endian word as a JS number.
 * @param {Uint8Array} bytes @param {number} at @returns {number}
 */
function readU64At(bytes, at) {
  return readU32At(bytes, at) * 0x100000000 + readU32At(bytes, at + 4)
}

/**
 * Skip one length-prefixed PSD section.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} lengthBytes
 * @param {string} name
 * @returns {number} offset of the next section
 */
function skipPsdSection(bytes, offset, lengthBytes, name) {
  const length = lengthBytes === 8 ? readU64At(bytes, offset) : readU32At(bytes, offset)
  const next = offset + lengthBytes + length
  if (!Number.isFinite(length) || next > bytes.length) throw new RasterError('invalid', `PSD ${name} section is truncated`)
  return next
}

/**
 * Read the signed layer count at the head of the layer-and-mask section.
 * Zero means the document has no layers at all.
 * @param {Uint8Array} bytes
 * @param {number} layerStart
 * @param {boolean} psb
 * @returns {number}
 */
function readPsdLayerCount(bytes, layerStart, psb) {
  try {
    const length = psb ? readU64At(bytes, layerStart) : readU32At(bytes, layerStart)
    if (length === 0) return 0
    const at = layerStart + (psb ? 8 : 4)
    const raw = readU16At(bytes, at)
    return raw >= 0x8000 ? raw - 0x10000 : raw
  } catch {
    return 0
  }
}
