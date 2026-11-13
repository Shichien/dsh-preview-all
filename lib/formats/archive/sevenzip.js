/**
 * Listing of `.7z` and `.rar` archives held in memory.
 *
 * ZIP and TAR live in `./archive.js`; this module covers the two remaining
 * common containers and returns only the listing — names, sizes, timestamps
 * and folder flags — because that is what the preview tab shows before the
 * user opens an entry. Nothing is written to disk.
 *
 * Entry data is never decompressed. A 7z *header* usually is compressed
 * (`kEncodedHeader`), so a compact LZMA/LZMA2 decoder lives here to read it.
 * RAR compression is proprietary and listing does not need it.
 */

/** @typedef {{ name: string, size: number, packed?: number, modified?: string, dir?: boolean, encrypted?: boolean, method?: string }} ArchiveEntry */

/** Ceiling for a header that has to be inflated before it can be parsed. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024
/** Ceiling for the number of entries we are willing to allocate for. */
const MAX_ENTRIES = 500000
/** How deeply `kEncodedHeader` may nest before we call the archive bogus. */
const MAX_HEADER_DEPTH = 8
/** Ticks between the Windows epoch (1601) and the Unix epoch (1970), in 100ns. */
const FILETIME_EPOCH = 116444736000000000n

export class SevenZipError extends Error {
  /** @param {'invalid'|'unsupported'|'encrypted'|'too-large'} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'SevenZipError'
    this.code = code
  }
}

/** @param {string} message @returns {never} */
function invalid(message) {
  throw new SevenZipError('invalid', message)
}

/** @param {string} message @returns {never} */
function unsupported(message) {
  throw new SevenZipError('unsupported', message)
}

/** @param {string} message @returns {never} */
function encrypted(message) {
  throw new SevenZipError('encrypted', message)
}

/** @param {string} message @returns {never} */
function tooLarge(message) {
  throw new SevenZipError('too-large', message)
}

/**
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
function asBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  invalid('expected a Uint8Array')
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
 * CRC32 over a byte range, using the IEEE polynomial both formats use.
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

/** @param {Uint8Array} bytes @param {number} at @returns {number} */
function readU16(bytes, at) {
  return bytes[at] | (bytes[at + 1] << 8)
}

/** @param {Uint8Array} bytes @param {number} at @returns {number} */
function readU32(bytes, at) {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}

/**
 * Format a Windows FILETIME as an ISO-8601 instant.
 * @param {bigint} ticks
 * @returns {string | undefined}
 */
function filetimeToIso(ticks) {
  if (ticks <= FILETIME_EPOCH) return undefined
  const date = new Date(Number((ticks - FILETIME_EPOCH) / 10000n))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * Convert a 4-byte MS-DOS date/time stamp (RAR4 FTIME) to an ISO-8601 instant.
 * DOS stamps carry no zone, so they are read as UTC to keep a listing stable.
 * @param {number} value
 * @returns {string | undefined}
 */
function dosTimeToIso(value) {
  const time = value & 0xffff
  const date = (value >>> 16) & 0xffff
  const day = date & 0x1f
  const month = (date >>> 5) & 0x0f
  const year = ((date >>> 9) & 0x7f) + 1980
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date2 = new Date(Date.UTC(year, month - 1, day, (time >>> 11) & 0x1f, (time >>> 5) & 0x3f, (time & 0x1f) * 2))
  return Number.isNaN(date2.getTime()) ? undefined : date2.toISOString()
}

/**
 * A bounds-checked cursor over a byte range. Every read past the end is a
 * format error rather than an `undefined` that would spread silently.
 */
class ByteReader {
  /**
   * @param {Uint8Array} bytes
   * @param {number} [start]
   * @param {number} [end]
   */
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes
    this.pos = start
    this.end = end
  }

  /** @returns {number} */
  get remaining() {
    return this.end - this.pos
  }

  /** @param {number} count */
  need(count) {
    if (count < 0 || this.pos + count > this.end) invalid('truncated archive header')
  }

  /** @returns {number} */
  byte() {
    this.need(1)
    return this.bytes[this.pos++]
  }

  /**
   * @param {number} count
   * @returns {Uint8Array}
   */
  take(count) {
    this.need(count)
    const slice = this.bytes.subarray(this.pos, this.pos + count)
    this.pos += count
    return slice
  }

  /** @returns {number} */
  u32() {
    this.need(4)
    const value = readU32(this.bytes, this.pos)
    this.pos += 4
    return value
  }

  /** @returns {bigint} */
  u64Big() {
    const low = BigInt(this.u32())
    const high = BigInt(this.u32())
    return (high << 32n) | low
  }

  /**
   * The 7z variable-length integer (LZMA SDK `ReadNumber`).
   * @returns {number}
   */
  number() {
    const first = this.byte()
    let mask = 0x80
    let value = 0
    for (let i = 0; i < 8; i += 1) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * 2 ** (8 * i)
        if (!Number.isSafeInteger(value)) invalid('variable-length integer out of range')
        return value
      }
      value += this.byte() * 2 ** (8 * i)
      mask >>= 1
    }
    if (!Number.isSafeInteger(value)) invalid('variable-length integer out of range')
    return value
  }

  /** A property id is just a number. @returns {number} */
  id() {
    return this.number()
  }

  /**
   * The RAR5 variable-length integer: 7 bits per byte, low bits first.
   * @returns {number}
   */
  vint() {
    let value = 0
    let shift = 0
    for (let i = 0; i < 10; i += 1) {
      const byte = this.byte()
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) invalid('RAR5 integer out of range')
        return value
      }
      shift += 7
    }
    invalid('RAR5 integer is too long')
  }

  /**
   * A packed bit vector, most significant bit first.
   * @param {number} count
   * @returns {Uint8Array} one byte (0 or 1) per item
   */
  bits(count) {
    const bits = new Uint8Array(count)
    let mask = 0
    let byte = 0
    for (let i = 0; i < count; i += 1) {
      if (mask === 0) {
        byte = this.byte()
        mask = 0x80
      }
      bits[i] = (byte & mask) === 0 ? 0 : 1
      mask >>= 1
    }
    return bits
  }

  /**
   * A bit vector preceded by an "all defined" byte, the way 7z stores optional
   * fields: a zero byte means a vector of bits follows, any other value means
   * every item is present.
   * @param {number} count
   * @returns {Uint8Array}
   */
  boolVector2(count) {
    if (this.byte() !== 0) {
      const all = new Uint8Array(count)
      all.fill(1)
      return all
    }
    return this.bits(count)
  }
}

// ---------------------------------------------------------------------------
// LZMA / LZMA2
//
// Node's zlib has neither, and a 7z header is normally an LZMA or LZMA2
// stream, so the decoder is implemented here. It is a transcription of the
// reference decoder in the LZMA SDK. The only simplification is that the
// output length is always known up front, which removes the end-marker and
// dictionary-window bookkeeping.
// ---------------------------------------------------------------------------

const PROB_INIT = 1024

/** Layout of one LZMA length coder inside a flat probability array. */
const LEN_CHOICE = 0
const LEN_CHOICE2 = 1
const LEN_LOW = 2
const LEN_MID = 130
const LEN_HIGH = 258
const LEN_SIZE = 514

/** The LZMA binary range decoder. */
class RangeDecoder {
  /**
   * @param {Uint8Array} bytes
   * @param {number} start
   * @param {number} end
   */
  constructor(bytes, start, end) {
    if (start + 5 > end) invalid('truncated LZMA range coder')
    if (bytes[start] !== 0) invalid('bad LZMA range coder initial byte')
    this.bytes = bytes
    this.pos = start + 5
    this.end = end
    this.code = ((bytes[start + 1] << 24) | (bytes[start + 2] << 16) | (bytes[start + 3] << 8) | bytes[start + 4]) >>> 0
    this.range = 0xffffffff
  }

  /** @returns {number} */
  next() {
    if (this.pos >= this.end) invalid('truncated LZMA range coder')
    return this.bytes[this.pos++]
  }

  normalize() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0
      this.code = ((this.code << 8) | this.next()) >>> 0
    }
  }

  /**
   * @param {Uint16Array} probs
   * @param {number} index
   * @returns {number} 0 or 1
   */
  decodeBit(probs, index) {
    const prob = probs[index]
    const bound = (this.range >>> 11) * prob
    let bit
    if (this.code < bound) {
      this.range = bound
      probs[index] = prob + ((2048 - prob) >>> 5)
      bit = 0
    } else {
      this.range = (this.range - bound) >>> 0
      this.code = (this.code - bound) >>> 0
      probs[index] = prob - (prob >>> 5)
      bit = 1
    }
    this.normalize()
    return bit
  }

  /**
   * @param {number} count
   * @returns {number}
   */
  decodeDirectBits(count) {
    let result = 0
    for (let i = 0; i < count; i += 1) {
      this.range = this.range >>> 1
      this.code = (this.code - this.range) >>> 0
      const borrow = (this.code >>> 31) & 1
      if (borrow === 1) this.code = (this.code + this.range) >>> 0
      this.normalize()
      result = result * 2 + (1 - borrow)
    }
    return result
  }
}

/**
 * @param {RangeDecoder} decoder
 * @param {Uint16Array} probs
 * @param {number} base
 * @param {number} numBits
 * @returns {number}
 */
function decodeBitTree(decoder, probs, base, numBits) {
  let model = 1
  for (let i = 0; i < numBits; i += 1) model = (model << 1) | decoder.decodeBit(probs, base + model)
  return model - (1 << numBits)
}

/**
 * @param {RangeDecoder} decoder
 * @param {Uint16Array} probs
 * @param {number} base
 * @param {number} numBits
 * @returns {number}
 */
function decodeBitTreeReverse(decoder, probs, base, numBits) {
  let model = 1
  let symbol = 0
  for (let i = 0; i < numBits; i += 1) {
    const bit = decoder.decodeBit(probs, base + model)
    model = (model << 1) | bit
    symbol |= bit << i
  }
  return symbol
}

/** The LZMA state shared by one LZMA1 stream or every chunk of an LZMA2 stream. */
class LzmaCore {
  constructor() {
    this.lc = 3
    this.lp = 0
    this.pb = 2
    this.allocate()
  }

  allocate() {
    this.literal = new Uint16Array(0x300 << (this.lc + this.lp))
    this.isMatch = new Uint16Array(12 * 16)
    this.isRep = new Uint16Array(12)
    this.isRepG0 = new Uint16Array(12)
    this.isRepG1 = new Uint16Array(12)
    this.isRepG2 = new Uint16Array(12)
    this.isRep0Long = new Uint16Array(12 * 16)
    this.posSlot = new Uint16Array(4 * 64)
    // The SDK packs one reverse bit tree per position slot into this single
    // region of 114 probabilities, indexed by `distance - posSlot - 1`.
    this.specPos = new Uint16Array(114)
    this.align = new Uint16Array(16)
    this.lenCoder = new Uint16Array(LEN_SIZE)
    this.repLenCoder = new Uint16Array(LEN_SIZE)
    this.reset()
  }

  reset() {
    this.literal.fill(PROB_INIT)
    this.isMatch.fill(PROB_INIT)
    this.isRep.fill(PROB_INIT)
    this.isRepG0.fill(PROB_INIT)
    this.isRepG1.fill(PROB_INIT)
    this.isRepG2.fill(PROB_INIT)
    this.isRep0Long.fill(PROB_INIT)
    this.posSlot.fill(PROB_INIT)
    this.specPos.fill(PROB_INIT)
    this.align.fill(PROB_INIT)
    this.lenCoder.fill(PROB_INIT)
    this.repLenCoder.fill(PROB_INIT)
    this.state = 0
    this.rep0 = 0
    this.rep1 = 0
    this.rep2 = 0
    this.rep3 = 0
  }

  /** @param {number} byte lc/lp/pb packed the way LZMA stores them */
  setProperties(byte) {
    if (byte >= 9 * 5 * 5) invalid('bad LZMA properties byte')
    const lc = byte % 9
    const rest = (byte - lc) / 9
    const lp = rest % 5
    const pb = (rest - lp) / 5
    if (lc + lp > 4) invalid('bad LZMA literal context bits')
    const reallocate = lc !== this.lc || lp !== this.lp
    this.lc = lc
    this.lp = lp
    this.pb = pb
    if (reallocate) this.allocate()
  }

  /**
   * @param {RangeDecoder} decoder
   * @param {Uint16Array} coder
   * @param {number} posState
   * @returns {number} the match length minus 2
   */
  decodeLength(decoder, coder, posState) {
    if (decoder.decodeBit(coder, LEN_CHOICE) === 0) return decodeBitTree(decoder, coder, LEN_LOW + posState * 8, 3)
    if (decoder.decodeBit(coder, LEN_CHOICE2) === 0) return 8 + decodeBitTree(decoder, coder, LEN_MID + posState * 8, 3)
    return 16 + decodeBitTree(decoder, coder, LEN_HIGH, 8)
  }

  /**
   * Decode `count` bytes into `out` at `start`. `start` is the absolute output
   * position, which is what LZMA uses for its position contexts.
   * @param {RangeDecoder} decoder
   * @param {Uint8Array} out
   * @param {number} start
   * @param {number} count
   */
  decodeChunk(decoder, out, start, count) {
    const lc = this.lc
    const lpMask = (1 << this.lp) - 1
    const pbMask = (1 << this.pb) - 1
    const end = start + count
    let pos = start
    while (pos < end) {
      const posState = pos & pbMask
      if (decoder.decodeBit(this.isMatch, (this.state << 4) + posState) === 0) {
        const previous = pos > 0 ? out[pos - 1] : 0
        const literalBase = (((pos & lpMask) << lc) + (previous >>> (8 - lc))) * 0x300
        let symbol = 1
        if (this.state >= 7) {
          const distance = this.rep0 + 1
          if (distance > pos) invalid('LZMA match distance points before the output start')
          let matchByte = out[pos - distance]
          do {
            const matchBit = (matchByte >>> 7) & 1
            matchByte = (matchByte << 1) & 0xff
            const bit = decoder.decodeBit(this.literal, literalBase + ((1 + matchBit) << 8) + symbol)
            symbol = (symbol << 1) | bit
            if (matchBit !== bit) break
          } while (symbol < 0x100)
        }
        while (symbol < 0x100) symbol = (symbol << 1) | decoder.decodeBit(this.literal, literalBase + symbol)
        out[pos] = symbol & 0xff
        pos += 1
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6
        continue
      }

      let length
      if (decoder.decodeBit(this.isRep, this.state) === 0) {
        this.rep3 = this.rep2
        this.rep2 = this.rep1
        this.rep1 = this.rep0
        length = this.decodeLength(decoder, this.lenCoder, posState)
        this.state = this.state < 7 ? 7 : 10
        const lenState = length < 3 ? length : 3
        const posSlot = decodeBitTree(decoder, this.posSlot, lenState * 64, 6)
        let distance
        if (posSlot < 4) {
          distance = posSlot
        } else {
          const directBits = (posSlot >>> 1) - 1
          distance = (2 | (posSlot & 1)) * 2 ** directBits
          if (posSlot < 14) {
            distance += decodeBitTreeReverse(decoder, this.specPos, distance - posSlot - 1, directBits)
          } else {
            distance += decoder.decodeDirectBits(directBits - 4) * 16
            distance += decodeBitTreeReverse(decoder, this.align, 0, 4)
          }
        }
        this.rep0 = distance
      } else {
        if (decoder.decodeBit(this.isRepG0, this.state) === 0) {
          if (decoder.decodeBit(this.isRep0Long, (this.state << 4) + posState) === 0) {
            this.state = this.state < 7 ? 9 : 11
            const distance = this.rep0 + 1
            if (distance > pos) invalid('LZMA match distance points before the output start')
            out[pos] = out[pos - distance]
            pos += 1
            continue
          }
        } else {
          let distance
          if (decoder.decodeBit(this.isRepG1, this.state) === 0) {
            distance = this.rep1
          } else {
            if (decoder.decodeBit(this.isRepG2, this.state) === 0) {
              distance = this.rep2
            } else {
              distance = this.rep3
              this.rep3 = this.rep2
            }
            this.rep2 = this.rep1
          }
          this.rep1 = this.rep0
          this.rep0 = distance
        }
        length = this.decodeLength(decoder, this.repLenCoder, posState)
        this.state = this.state < 7 ? 8 : 11
      }

      const matchLength = length + 2
      const distance = this.rep0 + 1
      if (distance > pos) invalid('LZMA match distance points before the output start')
      if (pos + matchLength > end) invalid('LZMA match runs past the end of the stream')
      const source = pos - distance
      for (let i = 0; i < matchLength; i += 1) out[pos + i] = out[source + i]
      pos += matchLength
    }
  }
}

/**
 * Decode a raw LZMA1 stream (coder id `030101`) of a known size.
 * @param {Uint8Array} input
 * @param {Uint8Array} props five property bytes: lc/lp/pb, then the dictionary size
 * @param {number} outSize
 * @returns {Uint8Array}
 */
function decodeLzma(input, props, outSize) {
  if (props.length !== 5) invalid('bad LZMA coder properties')
  const core = new LzmaCore()
  core.setProperties(props[0])
  const out = new Uint8Array(outSize)
  if (outSize > 0) core.decodeChunk(new RangeDecoder(input, 0, input.length), out, 0, outSize)
  return out
}

/**
 * Decode an LZMA2 stream (coder id `21`) of a known size. Chunks share the
 * dictionary, so one LZMA core decodes the whole stream.
 * @param {Uint8Array} input
 * @param {Uint8Array} props the single dictionary-size property byte
 * @param {number} outSize
 * @returns {Uint8Array}
 */
function decodeLzma2(input, props, outSize) {
  if (props.length !== 1) invalid('bad LZMA2 coder properties')
  if (props[0] > 40) unsupported(`LZMA2 dictionary property ${props[0]} is not supported`)
  const core = new LzmaCore()
  const out = new Uint8Array(outSize)
  let outLength = 0
  let pos = 0
  let resetNeeded = true
  while (outLength < outSize) {
    if (pos >= input.length) invalid('truncated LZMA2 stream')
    const control = input[pos]
    pos += 1
    if (control === 0x00) break
    if (control === 0x01 || control === 0x02) {
      if (pos + 2 > input.length) invalid('truncated LZMA2 chunk header')
      const size = ((input[pos] << 8) | input[pos + 1]) + 1
      pos += 2
      if (pos + size > input.length) invalid('truncated LZMA2 uncompressed chunk')
      if (outLength + size > outSize) invalid('LZMA2 chunk overruns the declared size')
      out.set(input.subarray(pos, pos + size), outLength)
      outLength += size
      pos += size
      // An uncompressed chunk forces the following LZMA chunk to reset.
      resetNeeded = true
      continue
    }
    if (control < 0x80) invalid(`bad LZMA2 control byte 0x${control.toString(16)}`)
    const resetMode = (control >>> 5) & 0x03
    if (pos + 4 > input.length) invalid('truncated LZMA2 chunk header')
    const unpackedSize = ((control & 0x1f) << 16) + ((input[pos] << 8) | input[pos + 1]) + 1
    pos += 2
    const packedSize = ((input[pos] << 8) | input[pos + 1]) + 1
    pos += 2
    if (resetMode >= 2) {
      if (pos >= input.length) invalid('truncated LZMA2 chunk header')
      core.setProperties(input[pos])
      pos += 1
    }
    if (resetMode >= 1 || resetNeeded) {
      core.reset()
      resetNeeded = false
    }
    if (pos + packedSize > input.length) invalid('truncated LZMA2 chunk')
    if (outLength + unpackedSize > outSize) invalid('LZMA2 chunk overruns the declared size')
    core.decodeChunk(new RangeDecoder(input, pos, pos + packedSize), out, outLength, unpackedSize)
    outLength += unpackedSize
    pos += packedSize
  }
  if (outLength !== outSize) invalid('LZMA2 stream ended before the declared size')
  return out
}

// ---------------------------------------------------------------------------
// 7z
// ---------------------------------------------------------------------------

const SEVEN_ZIP_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]
/** Offset of the first byte after the 32-byte signature header. */
const AFTER_SIGNATURE_HEADER = 32

const kHeader = 0x01
const kArchiveProperties = 0x02
const kAdditionalStreamsInfo = 0x03
const kMainStreamsInfo = 0x04
const kFilesInfo = 0x05
const kPackInfo = 0x06
const kUnpackInfo = 0x07
const kSubStreamsInfo = 0x08
const kSize = 0x09
const kCrc = 0x0a
const kFolder = 0x0b
const kCodersUnpackSize = 0x0c
const kNumUnpackStream = 0x0d
const kEmptyStream = 0x0e
const kEmptyFile = 0x0f
const kName = 0x11
const kMTime = 0x14
const kWinAttributes = 0x15
const kEncodedHeader = 0x17
const kEnd = 0x00

/** Coder method ids, as hex, for the methods this module understands. */
const CODER_COPY = '00'
const CODER_LZMA = '030101'
const CODER_LZMA2 = '21'
const CODER_AES = '06f10701'

/** @param {Uint8Array} bytes @returns {string} */
function hexOf(bytes) {
  let text = ''
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0')
  return text
}

/**
 * Read one folder — a coder graph — from `kUnpackInfo`.
 * @param {ByteReader} reader
 * @returns {{ coders: { method: string, props: Uint8Array }[], totalOut: number, unpackSizes: number[], unpackSize: number, crcDefined: boolean, bindOuts: number[] }}
 */
function readFolder(reader) {
  const numCoders = reader.number()
  if (numCoders === 0) invalid('folder without a coder')
  if (numCoders > 64) unsupported('folder with more than 64 coders')
  const coders = []
  let totalIn = 0
  let totalOut = 0
  for (let i = 0; i < numCoders; i += 1) {
    const flags = reader.byte()
    const methodSize = flags & 0x0f
    const isComplex = (flags & 0x10) !== 0
    const hasProps = (flags & 0x20) !== 0
    if (methodSize === 0) invalid('coder without a method id')
    const method = hexOf(reader.take(methodSize))
    let numIn = 1
    let numOut = 1
    if (isComplex) {
      numIn = reader.number()
      numOut = reader.number()
      if (numIn === 0 || numOut === 0) invalid('coder with no input or output stream')
    }
    totalIn += numIn
    totalOut += numOut
    const props = hasProps ? reader.take(reader.number()) : new Uint8Array(0)
    coders.push({ method, props })
  }
  if (totalOut < 1) invalid('folder without an output stream')
  const numBindPairs = totalOut - 1
  if (totalIn < numBindPairs + 1) invalid('folder has too few input streams')
  const bindOuts = []
  for (let i = 0; i < numBindPairs; i += 1) {
    reader.number()
    bindOuts.push(reader.number())
  }
  const numPackedStreams = totalIn - numBindPairs
  if (numPackedStreams < 1) invalid('folder declares no packed stream')
  if (numPackedStreams > 1) for (let i = 0; i < numPackedStreams; i += 1) reader.number()
  return { coders, totalOut, unpackSizes: [], unpackSize: 0, crcDefined: false, bindOuts }
}

/**
 * A folder's unpacked size is the one coder output that feeds nothing else.
 * @param {{ unpackSizes: number[], bindOuts: number[] }} folder
 * @returns {number}
 */
function folderUnpackSize(folder) {
  for (let i = folder.unpackSizes.length - 1; i >= 0; i -= 1) {
    if (!folder.bindOuts.includes(i)) return folder.unpackSizes[i]
  }
  return invalid('folder without an unbound output stream')
}

/**
 * Read a `StreamsInfo` block (pack + unpack + substreams) and return what a
 * listing needs: where the packed bytes are, how big each folder's output is,
 * and the unpacked size of every substream.
 * @param {ByteReader} reader
 * @returns {{ packPos: number, packSizes: number[], folders: any[], streamSizes: number[], note?: string }}
 */
function readStreamsInfo(reader) {
  const info = { packPos: 0, packSizes: [], folders: [], streamSizes: [], note: undefined }
  let id = reader.id()

  if (id === kPackInfo) {
    info.packPos = reader.number()
    const numPackStreams = reader.number()
    if (numPackStreams > MAX_ENTRIES) tooLarge('too many packed streams in the archive header')
    let pid = reader.id()
    if (pid === kSize) {
      for (let i = 0; i < numPackStreams; i += 1) info.packSizes.push(reader.number())
      pid = reader.id()
    }
    if (pid === kCrc) {
      const defined = reader.boolVector2(numPackStreams)
      for (let i = 0; i < numPackStreams; i += 1) if (defined[i] === 1) reader.u32()
      pid = reader.id()
    }
    if (pid !== kEnd) invalid('pack info is not terminated')
    id = reader.id()
  }

  if (id === kUnpackInfo) {
    let pid = reader.id()
    if (pid !== kFolder) invalid('unpack info without a folder list')
    const numFolders = reader.number()
    if (numFolders > MAX_ENTRIES) tooLarge('too many folders in the archive header')
    if (reader.byte() !== 0) unsupported('folder data stored outside the archive header')
    for (let i = 0; i < numFolders; i += 1) info.folders.push(readFolder(reader))
    pid = reader.id()
    if (pid !== kCodersUnpackSize) invalid('unpack info without coder output sizes')
    for (const folder of info.folders) {
      for (let i = 0; i < folder.totalOut; i += 1) folder.unpackSizes.push(reader.number())
    }
    pid = reader.id()
    if (pid === kCrc) {
      const defined = reader.boolVector2(numFolders)
      for (let i = 0; i < numFolders; i += 1) {
        if (defined[i] === 1) reader.u32()
        info.folders[i].crcDefined = defined[i] === 1
      }
      pid = reader.id()
    }
    if (pid !== kEnd) invalid('unpack info is not terminated')
    id = reader.id()
  }

  for (const folder of info.folders) folder.unpackSize = folderUnpackSize(folder)

  if (id === kSubStreamsInfo) {
    const numUnpackStreams = info.folders.map(() => 1)
    let pid = reader.id()
    if (pid === kNumUnpackStream) {
      let total = 0
      for (let i = 0; i < numUnpackStreams.length; i += 1) {
        numUnpackStreams[i] = reader.number()
        total += numUnpackStreams[i]
        if (total > MAX_ENTRIES) tooLarge('too many streams in the archive header')
      }
      pid = reader.id()
    }
    if (pid === kSize) {
      for (let i = 0; i < info.folders.length; i += 1) {
        let sum = 0
        for (let j = 1; j < numUnpackStreams[i]; j += 1) {
          const size = reader.number()
          info.streamSizes.push(size)
          sum += size
        }
        info.streamSizes.push(info.folders[i].unpackSize - sum)
      }
      pid = reader.id()
    } else {
      // Without kSize the per-substream sizes are not stored; the folder total
      // is the only number available, so every substream inherits it.
      let guessed = false
      for (let i = 0; i < info.folders.length; i += 1) {
        for (let j = 0; j < numUnpackStreams[i]; j += 1) info.streamSizes.push(info.folders[i].unpackSize)
        if (numUnpackStreams[i] > 1) guessed = true
      }
      if (guessed) info.note = 'entry sizes are per folder: this archive does not store them per file'
    }
    let numDigests = 0
    for (let i = 0; i < info.folders.length; i += 1) {
      if (numUnpackStreams[i] !== 1 || !info.folders[i].crcDefined) numDigests += numUnpackStreams[i]
    }
    if (pid === kCrc) {
      const defined = reader.boolVector2(numDigests)
      for (let i = 0; i < numDigests; i += 1) if (defined[i] === 1) reader.u32()
      pid = reader.id()
    }
    if (pid !== kEnd) invalid('substreams info is not terminated')
    id = reader.id()
  } else {
    for (const folder of info.folders) info.streamSizes.push(folder.unpackSize)
  }

  if (id !== kEnd) invalid('streams info is not terminated')
  return info
}

/**
 * Decompress the packed stream of one folder — for an encoded header, that
 * stream is the plain header.
 * @param {{ coders: { method: string, props: Uint8Array }[], unpackSize: number }} folder
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
function decodeFolderStream(folder, input) {
  if (folder.coders.length !== 1) unsupported('multi-coder folders in the archive header')
  const coder = folder.coders[0]
  const outSize = folder.unpackSize
  if (outSize > MAX_HEADER_BYTES) tooLarge('the archive header is larger than 64 MiB')
  if (coder.method === CODER_COPY) {
    if (input.length < outSize) invalid('truncated stored header stream')
    return input.subarray(0, outSize)
  }
  if (coder.method === CODER_LZMA) return decodeLzma(input, coder.props, outSize)
  if (coder.method === CODER_LZMA2) return decodeLzma2(input, coder.props, outSize)
  if (coder.method === CODER_AES) encrypted('the archive header is encrypted')
  return unsupported(`header coder ${coder.method} is not supported`)
}

/**
 * Inflate a `kEncodedHeader` into the plain header bytes it wraps.
 * @param {Uint8Array} archive
 * @param {{ packPos: number, packSizes: number[], folders: any[] }} streams
 * @returns {Uint8Array}
 */
function decodeEncodedHeader(archive, streams) {
  if (streams.folders.length === 0) invalid('encoded header without a folder')
  if (streams.packSizes.length !== streams.folders.length) unsupported('encoded header with a shared packed stream')
  const parts = []
  let offset = AFTER_SIGNATURE_HEADER + streams.packPos
  for (let i = 0; i < streams.folders.length; i += 1) {
    const end = offset + streams.packSizes[i]
    if (end > archive.length) invalid('packed header stream runs past the end of the archive')
    parts.push(decodeFolderStream(streams.folders[i], archive.subarray(offset, end)))
    offset = end
  }
  if (parts.length === 1) return parts[0]
  let total = 0
  for (const part of parts) total += part.length
  if (total > MAX_HEADER_BYTES) tooLarge('the archive header is larger than 64 MiB')
  const merged = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.length
  }
  return merged
}

/**
 * Read the file property block: names, timestamps, attributes and the
 * empty-stream vectors that distinguish folders from empty files.
 * @param {ByteReader} reader
 * @returns {{ numFiles: number, names: string[], hasStream: Uint8Array, dirs: Uint8Array, mtimes: (string | undefined)[] }}
 */
function readFilesInfo(reader) {
  const numFiles = reader.number()
  if (numFiles > MAX_ENTRIES) tooLarge('too many files in the archive header')
  const emptyStream = new Uint8Array(numFiles)
  let emptyFile = new Uint8Array(0)
  let numEmptyStreams = 0
  let names = []
  const mtimes = new Array(numFiles).fill(undefined)
  const attributes = new Array(numFiles).fill(undefined)

  for (;;) {
    const propId = reader.id()
    if (propId === kEnd) break
    const size = reader.number()
    const end = reader.pos + size
    if (end > reader.end) invalid('file property runs past the end of the header')
    const sub = new ByteReader(reader.bytes, reader.pos, end)
    if (propId === kEmptyStream) {
      const bits = sub.bits(numFiles)
      numEmptyStreams = 0
      for (let i = 0; i < numFiles; i += 1) {
        emptyStream[i] = bits[i]
        numEmptyStreams += bits[i]
      }
    } else if (propId === kEmptyFile) {
      emptyFile = sub.bits(numEmptyStreams)
    } else if (propId === kName) {
      if (sub.byte() !== 0) unsupported('file names stored outside the archive header')
      names = readNames(sub, numFiles)
    } else if (propId === kMTime) {
      readTimes(sub, numFiles, mtimes)
    } else if (propId === kWinAttributes) {
      readAttributes(sub, numFiles, attributes)
    }
    // kCTime, kATime, kComment, kStartPos, kDummy and anything newer are
    // irrelevant to a listing and are skipped by their declared size.
    reader.pos = end
  }

  const hasStream = new Uint8Array(numFiles)
  const dirs = new Uint8Array(numFiles)
  let emptyIndex = 0
  for (let i = 0; i < numFiles; i += 1) {
    const isEmptyStream = emptyStream[i] === 1
    hasStream[i] = isEmptyStream ? 0 : 1
    if (!isEmptyStream) continue
    // kEmptyFile is indexed by the position among the empty streams, not by
    // the file index, so walk it with a separate counter. Without kEmptyFile
    // every empty stream is a folder.
    const isFile = emptyFile.length > 0 && emptyFile[emptyIndex] === 1
    emptyIndex += 1
    const byAttribute = attributes[i] !== undefined && (attributes[i] & 0x10) !== 0
    dirs[i] = !isFile || byAttribute ? 1 : 0
  }
  if (names.length !== numFiles) invalid('the archive header has no file names')
  return { numFiles, names, hasStream, dirs, mtimes }
}

/**
 * Names are UTF-16LE code units, each entry terminated by a zero code unit.
 * @param {ByteReader} reader
 * @param {number} numFiles
 * @returns {string[]}
 */
function readNames(reader, numFiles) {
  const names = []
  let text = ''
  while (names.length < numFiles) {
    if (reader.pos + 2 > reader.end) invalid('truncated file name list')
    const code = reader.bytes[reader.pos] | (reader.bytes[reader.pos + 1] << 8)
    reader.pos += 2
    if (code === 0) {
      names.push(text)
      text = ''
    } else {
      text += String.fromCharCode(code)
    }
  }
  return names
}

/**
 * @param {ByteReader} reader
 * @param {number} numFiles
 * @param {(string | undefined)[]} out
 */
function readTimes(reader, numFiles, out) {
  const defined = reader.boolVector2(numFiles)
  if (reader.byte() !== 0) unsupported('timestamps stored outside the archive header')
  for (let i = 0; i < numFiles; i += 1) {
    if (defined[i] === 0) continue
    out[i] = filetimeToIso(reader.u64Big())
  }
}

/**
 * @param {ByteReader} reader
 * @param {number} numFiles
 * @param {(number | undefined)[]} out
 */
function readAttributes(reader, numFiles, out) {
  const defined = reader.boolVector2(numFiles)
  if (reader.byte() !== 0) unsupported('attributes stored outside the archive header')
  for (let i = 0; i < numFiles; i += 1) {
    if (defined[i] === 0) continue
    out[i] = reader.u32()
  }
}

/**
 * Parse one archive header, following `kEncodedHeader` wrappers.
 * @param {Uint8Array} bytes the (already decompressed) header
 * @param {Uint8Array} archive the whole archive, needed to reach packed streams
 * @param {number} [depth]
 * @returns {{ streams: any, files: any }}
 */
function readArchiveHeader(bytes, archive, depth = 0) {
  if (depth > MAX_HEADER_DEPTH) invalid('archive header is nested too deeply')
  const reader = new ByteReader(bytes)
  let id = reader.id()
  if (id === kEncodedHeader) {
    const streams = readStreamsInfo(reader)
    return readArchiveHeader(decodeEncodedHeader(archive, streams), archive, depth + 1)
  }
  if (id !== kHeader) invalid('unexpected 7z header id')
  let streams
  let files
  id = reader.id()
  if (id === kArchiveProperties) {
    for (;;) {
      const propId = reader.id()
      if (propId === kEnd) break
      const size = reader.number()
      reader.need(size)
      reader.pos += size
    }
    id = reader.id()
  }
  if (id === kAdditionalStreamsInfo) {
    readStreamsInfo(reader)
    id = reader.id()
  }
  if (id === kMainStreamsInfo) {
    streams = readStreamsInfo(reader)
    id = reader.id()
  }
  if (id === kFilesInfo) {
    files = readFilesInfo(reader)
    id = reader.id()
  }
  if (id !== kEnd) invalid('archive header is not terminated')
  return { streams, files }
}

/**
 * @param {Uint8Array} archive
 * @returns {{ format: '7z', entries: ArchiveEntry[], note?: string, encrypted?: boolean }}
 */
function list7z(archive) {
  if (archive.length < AFTER_SIGNATURE_HEADER) invalid('truncated 7z signature header')
  if (crc32(archive, 12, AFTER_SIGNATURE_HEADER) !== readU32(archive, 8)) invalid('7z start header CRC mismatch')
  const nextHeaderOffset = readU32(archive, 12) + readU32(archive, 16) * 0x100000000
  const nextHeaderSize = readU32(archive, 20) + readU32(archive, 24) * 0x100000000
  const nextHeaderCrc = readU32(archive, 28)
  const start = AFTER_SIGNATURE_HEADER + nextHeaderOffset
  if (start + nextHeaderSize > archive.length) invalid('the 7z next header lies outside the archive')
  if (nextHeaderSize > MAX_HEADER_BYTES) tooLarge('the 7z next header is larger than 64 MiB')
  if (crc32(archive, start, start + nextHeaderSize) !== nextHeaderCrc) invalid('7z next header CRC mismatch')

  const header = readArchiveHeader(archive.subarray(start, start + nextHeaderSize), archive)
  const files = header.files
  const streams = header.streams
  if (files === undefined) return { format: '7z', entries: [] }

  const result = { format: '7z', entries: [] }
  if (streams !== undefined && streams.note !== undefined) result.note = streams.note

  let encryptedData = false
  if (streams !== undefined) {
    for (const folder of streams.folders) {
      for (const coder of folder.coders) if (coder.method === CODER_AES) encryptedData = true
    }
  }

  const streamSizes = streams === undefined ? [] : streams.streamSizes
  let streamIndex = 0
  for (let i = 0; i < files.numFiles; i += 1) {
    const entry = { name: files.names[i], size: 0 }
    if (files.hasStream[i] === 1) {
      const size = streamSizes[streamIndex]
      streamIndex += 1
      if (typeof size === 'number') entry.size = size
    }
    if (files.mtimes[i] !== undefined) entry.modified = files.mtimes[i]
    if (files.dirs[i] === 1) entry.dir = true
    if (encryptedData) entry.encrypted = true
    result.entries.push(entry)
  }
  if (encryptedData) {
    result.encrypted = true
    result.note = 'entry data is encrypted: only the file listing is available'
  }
  return result
}

// ---------------------------------------------------------------------------
// RAR
// ---------------------------------------------------------------------------

const RAR_MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]

/** RAR5 block types. */
const RAR5_MAIN = 1
const RAR5_FILE = 2
const RAR5_SERVICE = 3
const RAR5_ENCRYPTION = 4
const RAR5_END = 5

/**
 * Read a RAR5 `FHEXTRA_HTIME` record: a flags vint followed by a 4-byte Unix
 * time for each timestamp it announces.
 * @param {ByteReader} reader
 * @returns {string | undefined}
 */
function readRar5ExtraTime(reader) {
  const flags = reader.vint()
  if ((flags & 0x02) === 0) return undefined
  if (reader.remaining < 4) return undefined
  return new Date(reader.u32() * 1000).toISOString()
}

/**
 * Read a RAR5 file or service header.
 * @param {ByteReader} reader
 * @param {number} headerEnd
 * @param {number} extraSize
 * @param {number} dataSize the block's data area, which is the packed size
 * @returns {ArchiveEntry}
 */
function readRar5FileHeader(reader, headerEnd, extraSize, dataSize) {
  const fileFlags = reader.vint()
  const unpackedSize = reader.vint()
  const attributes = reader.vint()
  let modified
  if ((fileFlags & 0x02) !== 0) modified = new Date(reader.u32() * 1000).toISOString()
  if ((fileFlags & 0x04) !== 0) reader.u32()
  const compressionInfo = reader.vint()
  reader.vint() // host OS
  const nameLength = reader.vint()
  if (reader.pos + nameLength > headerEnd) invalid('RAR5 file name runs past the header')
  const name = new TextDecoder('utf-8').decode(reader.take(nameLength))

  let isEncrypted = false
  let extraModified
  const extraStart = headerEnd - extraSize
  if (extraSize > 0 && extraStart >= reader.pos) {
    let at = extraStart
    while (at < headerEnd) {
      const record = new ByteReader(reader.bytes, at, headerEnd)
      const recordSize = record.vint()
      const recordType = record.vint()
      const recordEnd = record.pos + recordSize
      if (recordEnd > headerEnd) invalid('RAR5 extra record runs past the header')
      if (recordType === 0x01) isEncrypted = true
      else if (recordType === 0x03) extraModified = readRar5ExtraTime(record)
      at = recordEnd
    }
  }

  const method = (compressionInfo >>> 7) & 0x07
  const entry = { name, size: (fileFlags & 0x08) !== 0 ? 0 : unpackedSize }
  if (dataSize > 0) entry.packed = dataSize
  const timestamp = modified ?? extraModified
  if (timestamp !== undefined) entry.modified = timestamp
  if ((fileFlags & 0x01) !== 0 || (attributes & 0x10) !== 0) entry.dir = true
  if (isEncrypted) entry.encrypted = true
  entry.method = method === 0 ? 'store' : 'compress'
  return entry
}

/**
 * @param {Uint8Array} archive
 * @returns {{ format: 'rar5', entries: ArchiveEntry[], note?: string, encrypted?: boolean }}
 */
function listRar5(archive) {
  const reader = new ByteReader(archive, 8)
  const entries = []
  let note
  let first = true
  while (reader.remaining > 0) {
    const blockStart = reader.pos
    if (reader.remaining < 5) invalid('truncated RAR5 block header')
    const storedCrc = reader.u32()
    const headerSize = reader.vint()
    const headerEnd = reader.pos + headerSize
    if (headerEnd > reader.end) invalid('RAR5 block header runs past the end of the archive')
    const type = reader.vint()
    const flags = reader.vint()
    const extraSize = (flags & 0x01) !== 0 ? reader.vint() : 0
    const dataSize = (flags & 0x02) !== 0 ? reader.vint() : 0
    if (crc32(archive, blockStart + 4, headerEnd) !== storedCrc) invalid('RAR5 block CRC mismatch')

    if (type === RAR5_MAIN) {
      const archiveFlags = reader.vint()
      if ((archiveFlags & 0x02) !== 0) reader.vint()
      if ((archiveFlags & 0x01) !== 0) note = 'multi-volume archive: only the present volume is listed'
      first = false
    } else if (type === RAR5_FILE || type === RAR5_SERVICE) {
      const entry = readRar5FileHeader(reader, headerEnd, extraSize, dataSize)
      if (type === RAR5_FILE) entries.push(entry)
      first = false
    } else if (type === RAR5_ENCRYPTION) {
      encrypted('the RAR5 archive header is encrypted')
    } else if (type === RAR5_END) {
      break
    } else if (first) {
      invalid('RAR5 archive does not start with a main header')
    }

    reader.pos = headerEnd
    if (dataSize > 0) {
      if (reader.pos + dataSize > reader.end) invalid('RAR5 data block runs past the end of the archive')
      reader.pos += dataSize
    }
  }
  const result = { format: 'rar5', entries }
  if (note !== undefined) result.note = note
  if (entries.some((entry) => entry.encrypted === true)) result.encrypted = true
  return result
}

/**
 * Read a RAR4 file header.
 * @param {Uint8Array} archive
 * @param {number} blockStart
 * @param {number} flags
 * @param {number} headSize
 * @returns {{ entry: ArchiveEntry, dataSize: number }}
 */
function readRar4FileHeader(archive, blockStart, flags, headSize) {
  const headerEnd = blockStart + headSize
  let at = blockStart + 7
  if (at + 25 > headerEnd) invalid('RAR4 file header is too short')
  let packSize = readU32(archive, at)
  let unpackSize = readU32(archive, at + 4)
  const hostOs = archive[at + 8]
  const dosTime = readU32(archive, at + 13)
  const method = archive[at + 18]
  const nameSize = readU16(archive, at + 19)
  const attributes = readU32(archive, at + 21)
  at += 25
  if ((flags & 0x0100) !== 0) {
    if (at + 8 > headerEnd) invalid('RAR4 large file header is too short')
    packSize += readU32(archive, at) * 0x100000000
    unpackSize += readU32(archive, at + 4) * 0x100000000
    at += 8
  }
  if (at + nameSize > headerEnd) invalid('RAR4 file name runs past the header')
  const name = new TextDecoder('utf-8').decode(archive.subarray(at, at + nameSize))

  const entry = { name, size: unpackSize }
  if (packSize > 0) entry.packed = packSize
  const modified = dosTimeToIso(dosTime)
  if (modified !== undefined) entry.modified = modified
  const windowsHost = hostOs === 0 || hostOs === 2
  const byAttribute = windowsHost ? (attributes & 0x10) !== 0 : (attributes & 0xf000) === 0x4000
  if (byAttribute || (flags & 0x00e0) === 0x00e0) entry.dir = true
  if ((flags & 0x0004) !== 0) entry.encrypted = true
  entry.method = method === 0x30 ? 'store' : 'compress'
  return { entry, dataSize: packSize }
}

/**
 * @param {Uint8Array} archive
 * @returns {{ format: 'rar4', entries: ArchiveEntry[], note?: string, encrypted?: boolean }}
 */
function listRar4(archive) {
  const entries = []
  let note
  let pos = 7
  while (pos + 7 <= archive.length) {
    const blockStart = pos
    const headCrc = readU16(archive, pos)
    const type = archive[pos + 2]
    const flags = readU16(archive, pos + 3)
    const headSize = readU16(archive, pos + 5)
    if (headSize < 7) invalid('RAR4 block header is too short')
    const headerEnd = blockStart + headSize
    if (headerEnd > archive.length) invalid('RAR4 block header runs past the end of the archive')

    // The MARK_HEAD and ENDARC blocks carry a constant in the CRC field.
    if (type !== 0x72 && type !== 0x7a) {
      if ((crc32(archive, blockStart + 2, headerEnd) & 0xffff) !== headCrc) invalid('RAR4 block CRC mismatch')
    }

    let dataSize = 0
    if (type === 0x73) {
      if ((flags & 0x0080) !== 0) encrypted('the RAR4 archive header is encrypted')
      if ((flags & 0x0001) !== 0 || (flags & 0x0100) !== 0) {
        note = 'multi-volume archive: only the present volume is listed'
      }
    } else if (type === 0x74) {
      const file = readRar4FileHeader(archive, blockStart, flags, headSize)
      entries.push(file.entry)
      dataSize = file.dataSize
    } else if (type === 0x7a) {
      break
    }

    pos = headerEnd + dataSize
    if (pos > archive.length) invalid('RAR4 data block runs past the end of the archive')
  }
  const result = { format: 'rar4', entries }
  if (note !== undefined) result.note = note
  if (entries.some((entry) => entry.encrypted === true)) result.encrypted = true
  return result
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} bytes
 * @param {number[]} magic
 * @returns {boolean}
 */
function startsWith(bytes, magic) {
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i += 1) if (bytes[i] !== magic[i]) return false
  return true
}

/**
 * List the entries of a 7z or RAR archive held fully in memory.
 *
 * Only the listing is produced: entry data is never decompressed. A `.rar`
 * therefore lists whatever compression method it uses, and a 7z whose entry
 * coders this module does not know (PPMd, BCJ chains, AES, ...) still lists as
 * long as its header can be read.
 *
 * @param {Uint8Array} bytes whole archive (the caller enforces a size cap, e.g. 128 MiB)
 * @returns {{ format: '7z' | 'rar4' | 'rar5', entries: ArchiveEntry[], note?: string, encrypted?: boolean }}
 * @throws {SevenZipError} code 'invalid' | 'unsupported' | 'encrypted' | 'too-large'
 */
export function list7zRar(bytes) {
  const archive = asBytes(bytes)
  try {
    if (startsWith(archive, SEVEN_ZIP_MAGIC)) return list7z(archive)
    if (startsWith(archive, RAR_MAGIC)) {
      // RAR 4.x ends the signature here; RAR 5.0 adds a zero byte after the
      // version byte, so the two are told apart by what follows `Rar!\x1a\x07`.
      if (archive.length < 7) invalid('truncated RAR signature')
      if (archive[6] === 0x00) return listRar4(archive)
      if (archive[6] === 0x01) {
        if (archive.length < 8 || archive[7] !== 0x00) invalid('truncated RAR5 signature')
        return listRar5(archive)
      }
      unsupported(`RAR signature version ${archive[6]}`)
    }
    invalid('not a 7z or RAR archive')
  } catch (error) {
    if (error instanceof SevenZipError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new SevenZipError('invalid', `malformed archive: ${message}`)
  }
}
