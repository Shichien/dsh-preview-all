/**
 * Pure-JS decompression for the two formats `node:zlib` cannot handle: bzip2
 * (`.bz2`) and xz/LZMA2 (`.xz`). The Sidebar preview needs both to list the
 * contents of `.tar.bz2` / `.tar.xz` archives.
 *
 * Everything here works on one complete stream held in memory. The caller's
 * `maxOutputBytes` is enforced *before* memory is committed: the decoders grow
 * their buffers in bounded steps and throw `DecompressError('too-large')` the
 * moment the produced output would cross the cap, so a hostile 1 KiB file
 * cannot ask for a multi-gigabyte allocation.
 *
 * Supported:
 * - bzip2: every block feature except the deprecated "randomised" blocks, with
 *   block and stream CRC verification and concatenated streams.
 * - xz: the LZMA2, delta and x86 BCJ filters, none/CRC32/CRC64 integrity
 *   checks, multiple blocks and concatenated streams.
 *
 * Anything else throws `DecompressError('unsupported')` instead of returning
 * garbage. No third-party dependencies, no `Buffer` requirement.
 */

/** Default cap on decoded output: 96 MiB. */
const DEFAULT_MAX_OUTPUT_BYTES = 96 * 1024 * 1024

/** First allocation of a growable output buffer. */
const INITIAL_CAPACITY = 64 * 1024

/** bzip2 block magic numbers. */
const BZIP2_BLOCK_MAGIC = 0x314159265359
const BZIP2_EOS_MAGIC = 0x177245385090

/** xz stream signature. */
const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]

/** xz filter identifiers. */
const FILTER_DELTA = 0x03
const FILTER_X86 = 0x04
const FILTER_LZMA2 = 0x21

/** LZMA probability values start at 1/2. */
const PROB_INIT = 1024

/** @typedef {{ code: 'unsupported' | 'invalid' | 'too-large', message: string }} DecompressFailure */

export class DecompressError extends Error {
  /** @param {'unsupported'|'invalid'|'too-large'} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'DecompressError'
    this.code = code
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function invalid(message) {
  throw new DecompressError('invalid', message)
}

/**
 * @param {string} message
 * @returns {never}
 */
function unsupported(message) {
  throw new DecompressError('unsupported', message)
}

/**
 * @param {number} limit
 * @returns {never}
 */
function tooLarge(limit) {
  throw new DecompressError('too-large', `decompressed output would exceed ${limit} bytes`)
}

/**
 * Coerce a byte-ish value into a Uint8Array without copying when possible.
 * @param {unknown} input
 * @returns {Uint8Array | undefined}
 */
function asBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return undefined
}

/** CRC-32 (IEEE 802.3), reflected table. Same numeric result as zlib's crc32. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? ((value >>> 1) ^ 0xedb88320) >>> 0 : (value >>> 1) >>> 0
    }
    table[i] = value >>> 0
  }
  return table
})()

/** CRC-32 as bzip2 defines it: the same polynomial, but MSB-first and unreflected. */
const BZIP2_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = (i << 24) >>> 0
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x80000000) !== 0 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0
    }
    table[i] = value >>> 0
  }
  return table
})()

/**
 * Update a CRC-32 register over a byte range.
 * @param {number} register
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function crc32Range(register, bytes, start, end) {
  let crc = register >>> 0
  for (let i = start; i < end; i += 1) {
    crc = ((crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff]) >>> 0
  }
  return crc >>> 0
}

/**
 * Update a bzip2 CRC-32 register over a byte range.
 * @param {number} register
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function bzip2Crc32Range(register, bytes, start, end) {
  let crc = register >>> 0
  for (let i = start; i < end; i += 1) {
    crc = ((crc << 8) ^ BZIP2_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0
  }
  return crc >>> 0
}

/**
 * CRC-32 of a byte range, exposed as the conventional init/final-xor value.
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number}
 */
function crc32(bytes, start = 0, end = bytes.length) {
  return (crc32Range(0xffffffff, bytes, start, end) ^ 0xffffffff) >>> 0
}

/** CRC-64 (ECMA-182) table, reflected as xz defines it, split into 32-bit halves. */
const CRC64_HI = new Uint32Array(256)
const CRC64_LO = new Uint32Array(256)

for (let i = 0; i < 256; i += 1) {
  let hi = 0
  let lo = i
  for (let bit = 0; bit < 8; bit += 1) {
    const carry = lo & 1
    lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0
    hi = hi >>> 1
    if (carry === 1) {
      hi = (hi ^ 0xc96c5795) >>> 0
      lo = (lo ^ 0xd7870f42) >>> 0
    }
  }
  CRC64_HI[i] = hi
  CRC64_LO[i] = lo
}

/** Incremental CRC-64 (ECMA-182) over 32-bit halves. */
class Crc64 {
  constructor() {
    this.hi = 0xffffffff
    this.lo = 0xffffffff
  }

  /**
   * @param {Uint8Array} bytes
   * @param {number} [start]
   * @param {number} [end]
   */
  update(bytes, start = 0, end = bytes.length) {
    let hi = this.hi
    let lo = this.lo
    for (let i = start; i < end; i += 1) {
      const index = (lo ^ bytes[i]) & 0xff
      lo = (((lo >>> 8) | ((hi & 0xff) << 24)) ^ CRC64_LO[index]) >>> 0
      hi = ((hi >>> 8) ^ CRC64_HI[index]) >>> 0
    }
    this.hi = hi
    this.lo = lo
  }

  /** The finished checksum, as the two 32-bit halves xz stores little-endian. */
  digest() {
    return { hi: (this.hi ^ 0xffffffff) >>> 0, lo: (this.lo ^ 0xffffffff) >>> 0 }
  }
}

/** A growable output buffer that refuses to grow past a hard cap. */
class ByteSink {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.buffer = new Uint8Array(Math.min(Math.max(maxBytes, 1), INITIAL_CAPACITY))
    this.length = 0
  }

  /** @param {number} extra */
  reserve(extra) {
    const needed = this.length + extra
    if (needed > this.maxBytes) tooLarge(this.maxBytes)
    if (needed <= this.buffer.length) return
    let size = this.buffer.length
    while (size < needed) size = Math.min(size * 2, this.maxBytes)
    const grown = new Uint8Array(size)
    grown.set(this.buffer.subarray(0, this.length))
    this.buffer = grown
  }

  /** @param {number} byte @param {number} count */
  pushRun(byte, count) {
    if (count <= 0) return
    this.reserve(count)
    this.buffer.fill(byte & 0xff, this.length, this.length + count)
    this.length += count
  }

  /** @param {Uint8Array} bytes */
  pushBytes(bytes) {
    if (bytes.length === 0) return
    this.reserve(bytes.length)
    this.buffer.set(bytes, this.length)
    this.length += bytes.length
  }

  /** @returns {Uint8Array} */
  result() {
    return this.buffer.subarray(0, this.length)
  }
}

/**
 * MSB-first bit reader over a byte array.
 */
class BitReader {
  /**
   * @param {Uint8Array} bytes
   * @param {number} offset
   */
  constructor(bytes, offset) {
    this.bytes = bytes
    this.pos = offset
    this.bitBuffer = 0
    this.bitCount = 0
  }

  /**
   * Read `count` bits as an unsigned integer (any width up to 48).
   * @param {number} count
   * @returns {number}
   */
  read(count) {
    let value = 0
    let need = count
    while (need > 0) {
      if (this.bitCount === 0) {
        if (this.pos >= this.bytes.length) invalid('truncated bitstream')
        this.bitBuffer = this.bytes[this.pos]
        this.pos += 1
        this.bitCount = 8
      }
      const take = need < this.bitCount ? need : this.bitCount
      const shift = this.bitCount - take
      const scale = 2 ** take
      value = value * scale + (Math.floor(this.bitBuffer / 2 ** shift) % scale)
      this.bitCount = shift
      this.bitBuffer %= 2 ** shift
      need -= take
    }
    return value
  }

  /** @returns {number} */
  bit() {
    return this.read(1)
  }
}

/**
 * Build the canonical Huffman decode tables bzip2 uses (limit/base/perm).
 * @param {Uint8Array} lengths
 * @param {number} alphaSize
 * @returns {{ minLen: number, limit: Int32Array, base: Int32Array, perm: Int32Array }}
 */
function buildHuffman(lengths, alphaSize) {
  let minLen = 32
  let maxLen = 0
  for (let i = 0; i < alphaSize; i += 1) {
    const len = lengths[i]
    if (len > 0 && len < minLen) minLen = len
    if (len > maxLen) maxLen = len
  }
  if (maxLen === 0 || minLen > maxLen) invalid('bzip2 Huffman table is empty')

  const perm = new Int32Array(alphaSize)
  let count = 0
  for (let len = minLen; len <= maxLen; len += 1) {
    for (let symbol = 0; symbol < alphaSize; symbol += 1) {
      if (lengths[symbol] === len) {
        perm[count] = symbol
        count += 1
      }
    }
  }

  const base = new Int32Array(25)
  for (let i = 0; i < alphaSize; i += 1) base[lengths[i] + 1] += 1
  for (let i = 1; i < base.length; i += 1) base[i] += base[i - 1]

  const limit = new Int32Array(25)
  let vec = 0
  for (let len = minLen; len <= maxLen; len += 1) {
    vec += base[len + 1] - base[len]
    limit[len] = vec - 1
    vec <<= 1
  }
  for (let len = minLen + 1; len <= maxLen; len += 1) {
    base[len] = ((limit[len - 1] + 1) << 1) - base[len]
  }
  return { minLen, limit, base, perm }
}

/**
 * Decode one bzip2 block body (everything after the block header fields) into
 * `sink`, returning the block CRC read from the stream.
 * @param {BitReader} reader
 * @param {ByteSink} sink
 * @param {number} maxBlock
 * @param {number} blockCrc
 * @param {number} origPtr
 * @returns {void}
 */
function decodeBzip2Block(reader, sink, maxBlock, blockCrc, origPtr) {
  const inUse16 = reader.read(16)
  const inUse = new Uint8Array(256)
  const seqToUnseq = []
  for (let group = 0; group < 16; group += 1) {
    if (((inUse16 >>> (15 - group)) & 1) === 0) continue
    const bits = reader.read(16)
    for (let bit = 0; bit < 16; bit += 1) {
      if (((bits >>> (15 - bit)) & 1) === 0) continue
      const symbol = group * 16 + bit
      inUse[symbol] = 1
      seqToUnseq.push(symbol)
    }
  }
  const nInUse = seqToUnseq.length
  if (nInUse === 0) invalid('bzip2 block has an empty symbol map')

  const nGroups = reader.read(3)
  if (nGroups < 2 || nGroups > 6) invalid('bzip2 block has a bad group count')
  const nSelectors = reader.read(15)
  if (nSelectors < 1) invalid('bzip2 block has no selectors')

  const selectors = new Uint8Array(nSelectors)
  for (let i = 0; i < nSelectors; i += 1) {
    let run = 0
    while (reader.bit() === 1) {
      run += 1
      if (run >= nGroups) invalid('bzip2 selector index out of range')
    }
    selectors[i] = run
  }
  const groupOrder = [0, 1, 2, 3, 4, 5]
  for (let i = 0; i < nSelectors; i += 1) {
    const moved = groupOrder[selectors[i]]
    for (let k = selectors[i]; k > 0; k -= 1) groupOrder[k] = groupOrder[k - 1]
    groupOrder[0] = moved
    selectors[i] = moved
  }

  const alphaSize = nInUse + 2
  const tables = []
  for (let group = 0; group < nGroups; group += 1) {
    const lengths = new Uint8Array(alphaSize)
    let length = reader.read(5)
    for (let symbol = 0; symbol < alphaSize; symbol += 1) {
      while (true) {
        if (length < 1 || length > 20) invalid('bzip2 Huffman code length out of range')
        if (reader.bit() === 0) break
        length += reader.bit() === 0 ? 1 : -1
      }
      lengths[symbol] = length
    }
    tables.push(buildHuffman(lengths, alphaSize))
  }

  let groupNo = -1
  let groupPos = 0
  let table = tables[0]
  const nextSymbol = () => {
    if (groupPos === 0) {
      groupNo += 1
      if (groupNo >= nSelectors) invalid('bzip2 selector list overrun')
      groupPos = 50
      table = tables[selectors[groupNo]]
    }
    groupPos -= 1
    let length = table.minLen
    let code = reader.read(length)
    while (code > table.limit[length]) {
      length += 1
      if (length > 24) invalid('bzip2 Huffman code out of range')
      code = (code << 1) | reader.bit()
    }
    const index = code - table.base[length]
    if (index < 0 || index >= alphaSize) invalid('bzip2 Huffman index out of range')
    return table.perm[index]
  }

  const mtf = new Uint8Array(256)
  for (let i = 0; i < nInUse; i += 1) mtf[i] = i

  const tt = new Uint8Array(maxBlock)
  const endOfBlock = nInUse + 1
  let nblock = 0
  let symbol = nextSymbol()
  for (;;) {
    if (symbol === endOfBlock) break
    if (nblock >= maxBlock) invalid('bzip2 block overflows its declared size')
    if (symbol === 0 || symbol === 1) {
      let run = -1
      let weight = 1
      do {
        if (weight > 2 * 1024 * 1024) invalid('bzip2 run length out of range')
        run += symbol === 0 ? weight : 2 * weight
        weight *= 2
        symbol = nextSymbol()
      } while (symbol === 0 || symbol === 1)
      run += 1
      if (nblock + run > maxBlock) invalid('bzip2 block overflows its declared size')
      const byte = seqToUnseq[mtf[0]]
      tt.fill(byte, nblock, nblock + run)
      nblock += run
      continue
    }
    if (symbol - 1 >= nInUse) invalid('bzip2 MTF index out of range')
    const index = mtf[symbol - 1]
    for (let k = symbol - 1; k > 0; k -= 1) mtf[k] = mtf[k - 1]
    mtf[0] = index
    tt[nblock] = seqToUnseq[index]
    nblock += 1
    symbol = nextSymbol()
  }

  if (nblock === 0) {
    if (blockCrc !== 0) invalid('bzip2 block CRC mismatch')
    return
  }
  if (origPtr >= nblock) invalid('bzip2 block pointer out of range')

  const starts = new Uint32Array(256)
  for (let i = 0; i < nblock; i += 1) starts[tt[i]] += 1
  let running = 0
  for (let byte = 0; byte < 256; byte += 1) {
    const count = starts[byte]
    starts[byte] = running
    running += count
  }
  const next = new Uint32Array(nblock)
  const cursor = starts.slice()
  for (let i = 0; i < nblock; i += 1) {
    const byte = tt[i]
    next[cursor[byte]] = i
    cursor[byte] += 1
  }

  const bwt = new Uint8Array(nblock)
  let walk = next[origPtr]
  for (let i = 0; i < nblock; i += 1) {
    bwt[i] = tt[walk]
    walk = next[walk]
  }

  let crc = 0xffffffff
  let i = 0
  const repeat = new Uint8Array(256)
  while (i < nblock) {
    const byte = bwt[i]
    let run = 1
    i += 1
    while (run < 4 && i < nblock && bwt[i] === byte) {
      run += 1
      i += 1
    }
    if (run === 4) {
      if (i >= nblock) invalid('bzip2 RLE run is truncated')
      run += bwt[i]
      i += 1
    }
    if (run > repeat.length) {
      const wider = new Uint8Array(run)
      wider.fill(byte)
      crc = bzip2Crc32Range(crc, wider, 0, run)
    } else {
      repeat.fill(byte, 0, run)
      crc = bzip2Crc32Range(crc, repeat, 0, run)
    }
    sink.pushRun(byte, run)
  }
  if (((crc ^ 0xffffffff) >>> 0) !== blockCrc) invalid('bzip2 block CRC mismatch')
}

/**
 * Decompress a bzip2 stream (possibly several concatenated streams).
 * @param {Uint8Array} input
 * @param {number} maxOutputBytes
 * @returns {Uint8Array}
 */
function bunzip2(input, maxOutputBytes) {
  const sink = new ByteSink(maxOutputBytes)
  let offset = 0
  let streams = 0
  while (offset < input.length) {
    if (input[offset] === 0x00) {
      let pad = 0
      while (offset + pad < input.length && input[offset + pad] === 0x00) pad += 1
      offset += pad
      break
    }
    if (offset + 4 > input.length) invalid('truncated bzip2 header')
    if (input[offset] !== 0x42 || input[offset + 1] !== 0x5a || input[offset + 2] !== 0x68) {
      invalid('missing bzip2 signature')
    }
    const level = input[offset + 3] - 0x30
    if (level < 1 || level > 9) invalid('bzip2 block size out of range')
    const maxBlock = level * 100000
    const reader = new BitReader(input, offset + 4)
    let combined = 0
    for (;;) {
      const magic = reader.read(48)
      if (magic === BZIP2_EOS_MAGIC) {
        const expected = reader.read(32) >>> 0
        if (expected !== (combined >>> 0)) invalid('bzip2 stream CRC mismatch')
        break
      }
      if (magic !== BZIP2_BLOCK_MAGIC) invalid('bad bzip2 block magic')
      const blockCrc = reader.read(32) >>> 0
      if (reader.bit() !== 0) unsupported('randomised bzip2 blocks are not supported')
      const origPtr = reader.read(24)
      decodeBzip2Block(reader, sink, maxBlock, blockCrc, origPtr)
      combined = (((combined << 1) | (combined >>> 31)) ^ blockCrc) >>> 0
    }
    offset = reader.pos
    streams += 1
  }
  if (streams === 0) invalid('no bzip2 stream found')
  return sink.result()
}

/**
 * MSB-first range decoder used by LZMA and LZMA2.
 */
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
    const byte = this.bytes[this.pos]
    this.pos += 1
    return byte
  }

  /** @param {Uint16Array} probs @param {number} index @returns {number} */
  decodeBit(probs, index) {
    const prob = probs[index]
    const bound = (this.range >>> 11) * prob
    let bit
    if (this.code < bound) {
      this.range = bound
      probs[index] = prob + ((2048 - prob) >>> 5)
      bit = 0
    } else {
      this.range -= bound
      this.code -= bound
      probs[index] = prob - (prob >>> 5)
      bit = 1
    }
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0
      this.code = ((this.code << 8) | this.next()) >>> 0
    }
    return bit
  }

  /** @param {number} count @returns {number} */
  decodeDirectBits(count) {
    let result = 0
    for (let i = 0; i < count; i += 1) {
      this.range = this.range >>> 1
      let bit = 0
      if (this.code >= this.range) {
        this.code -= this.range
        bit = 1
      }
      result = result * 2 + bit
      if (this.range < 0x1000000) {
        this.range = (this.range << 8) >>> 0
        this.code = ((this.code << 8) | this.next()) >>> 0
      }
    }
    return result
  }
}

/**
 * Decode a canonical bit-tree symbol.
 * @param {RangeDecoder} decoder
 * @param {Uint16Array} probs
 * @param {number} offset
 * @param {number} numBits
 * @returns {number}
 */
function decodeBitTree(decoder, probs, offset, numBits) {
  let model = 1
  for (let i = 0; i < numBits; i += 1) model = (model << 1) | decoder.decodeBit(probs, offset + model)
  return model - (1 << numBits)
}

/**
 * Decode a reversed (LSB-first) bit-tree symbol.
 * @param {RangeDecoder} decoder
 * @param {Uint16Array} probs
 * @param {number} offset
 * @param {number} numBits
 * @returns {number}
 */
function decodeBitTreeReverse(decoder, probs, offset, numBits) {
  let model = 1
  let symbol = 0
  for (let i = 0; i < numBits; i += 1) {
    const bit = decoder.decodeBit(probs, offset + model)
    model = (model << 1) | bit
    symbol |= bit << i
  }
  return symbol
}

/** Layout of one LZMA length coder inside a single flat probability array. */
const LEN_CHOICE = 0
const LEN_CHOICE2 = 1
const LEN_LOW = 2
const LEN_MID = 130
const LEN_HIGH = 258
const LEN_SIZE = 514

/**
 * Size of the shared short-distance probability tree. Distances 4..127 are
 * coded here, and the deepest slot starts at index 82, so the tree needs
 * `82 + 32` entries.
 */
const SPEC_POS_SIZE = 128

/** The LZMA decoder core shared by every LZMA2 chunk of a block. */
class LzmaDecoder {
  constructor() {
    this.lc = 3
    this.lp = 0
    this.pb = 2
    this.state = 0
    this.processed = 0
    this.rep0 = 0
    this.rep1 = 0
    this.rep2 = 0
    this.rep3 = 0
    this.endMarker = false
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
    // One flat tree array shared by every short-distance slot; the base offset
    // for a slot is `distance - posSlot - 1` (see LzmaDec.c SpecPos).
    this.specPos = new Uint16Array(SPEC_POS_SIZE)
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
    this.processed = 0
    this.rep0 = 0
    this.rep1 = 0
    this.rep2 = 0
    this.rep3 = 0
    this.endMarker = false
  }

  /** @param {number} byte */
  setProperties(byte) {
    if (byte >= 9 * 5 * 5) invalid('bad LZMA properties byte')
    const lc = byte % 9
    const rest = (byte - lc) / 9
    const lp = rest % 5
    const pb = (rest - lp) / 5
    if (lc + lp > 4) invalid('bad LZMA literal context bits')
    if (lc !== this.lc || lp !== this.lp) {
      this.lc = lc
      this.lp = lp
      this.pb = pb
      this.allocate()
      return
    }
    this.pb = pb
  }

  /**
   * @param {RangeDecoder} decoder
   * @param {Uint16Array} coder
   * @param {number} posState
   * @returns {number}
   */
  decodeLength(decoder, coder, posState) {
    if (decoder.decodeBit(coder, LEN_CHOICE) === 0) {
      return decodeBitTree(decoder, coder, LEN_LOW + posState * 8, 3)
    }
    if (decoder.decodeBit(coder, LEN_CHOICE2) === 0) {
      return 8 + decodeBitTree(decoder, coder, LEN_MID + posState * 8, 3)
    }
    return 16 + decodeBitTree(decoder, coder, LEN_HIGH, 8)
  }

  /**
   * Decode `count` bytes into `out` starting at `start`.
   * @param {RangeDecoder} decoder
   * @param {Uint8Array} out
   * @param {number} start
   * @param {number} count
   * @returns {number} the position reached
   */
  decodeChunk(decoder, out, start, count) {
    const lc = this.lc
    const lpMask = (1 << this.lp) - 1
    const pbMask = (1 << this.pb) - 1
    const end = start + count
    let pos = start
    while (pos < end) {
      const posState = this.processed & pbMask
      if (decoder.decodeBit(this.isMatch, (this.state << 4) + posState) === 0) {
        const previous = pos > 0 ? out[pos - 1] : 0
        const base = ((((this.processed & lpMask) << lc) + (previous >>> (8 - lc))) * 0x300)
        let symbol = 1
        if (this.state >= 7) {
          const distance = this.rep0 + 1
          if (distance > pos) invalid('LZMA match distance before the output start')
          let matchByte = out[pos - distance]
          do {
            const matchBit = (matchByte >>> 7) & 1
            matchByte = (matchByte << 1) & 0xff
            const bit = decoder.decodeBit(this.literal, base + ((1 + matchBit) << 8) + symbol)
            symbol = (symbol << 1) | bit
            if (matchBit !== bit) break
          } while (symbol < 0x100)
        }
        while (symbol < 0x100) symbol = (symbol << 1) | decoder.decodeBit(this.literal, base + symbol)
        out[pos] = symbol & 0xff
        pos += 1
        this.processed += 1
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
        if (distance === 0xffffffff) {
          this.endMarker = true
          return pos
        }
        this.rep0 = distance
      } else {
        if (decoder.decodeBit(this.isRepG0, this.state) === 0) {
          if (decoder.decodeBit(this.isRep0Long, (this.state << 4) + posState) === 0) {
            this.state = this.state < 7 ? 9 : 11
            const distance = this.rep0 + 1
            if (distance > pos) invalid('LZMA match distance before the output start')
            out[pos] = out[pos - distance]
            pos += 1
            this.processed += 1
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
      if (distance > pos) invalid('LZMA match distance before the output start')
      if (pos + matchLength > end) invalid('LZMA match runs past the end of its chunk')
      let source = pos - distance
      for (let i = 0; i < matchLength; i += 1) out[pos + i] = out[source + i]
      pos += matchLength
      this.processed += matchLength
    }
    return pos
  }
}

/**
 * Decode the LZMA2 dictionary-size property byte.
 * @param {number} byte
 * @returns {number}
 */
function lzma2DictionarySize(byte) {
  if (byte > 40) unsupported(`LZMA2 dictionary property ${byte} is not supported`)
  if (byte === 40) return 0xffffffff
  return (2 | (byte & 1)) * 2 ** (Math.floor(byte / 2) + 11)
}

/**
 * Decode one LZMA2 stream (one xz block's compressed payload).
 * @param {Uint8Array} input
 * @param {number} start
 * @param {number} limit
 * @param {Uint8Array} props
 * @param {number} maxOutputBytes
 * @returns {{ bytes: Uint8Array, end: number }}
 */
function decodeLzma2(input, start, limit, props, maxOutputBytes) {
  if (props.length !== 1) invalid('bad LZMA2 filter properties')
  lzma2DictionarySize(props[0])
  let out = new Uint8Array(Math.min(Math.max(maxOutputBytes, 1), INITIAL_CAPACITY))
  let outLength = 0
  const reserve = (extra) => {
    const needed = outLength + extra
    if (needed > maxOutputBytes) tooLarge(maxOutputBytes)
    if (needed <= out.length) return
    let size = out.length
    while (size < needed) size = Math.min(size * 2, maxOutputBytes)
    const grown = new Uint8Array(size)
    grown.set(out.subarray(0, outLength))
    out = grown
  }

  const decoder = new LzmaDecoder()
  let pos = start
  let needsReset = true
  for (;;) {
    if (pos >= limit) invalid('truncated LZMA2 stream')
    const control = input[pos]
    pos += 1
    if (control === 0x00) break
    if (control === 0x01 || control === 0x02) {
      if (pos + 2 > limit) invalid('truncated LZMA2 chunk header')
      const size = ((input[pos] << 8) | input[pos + 1]) + 1
      pos += 2
      if (pos + size > limit) invalid('truncated LZMA2 uncompressed chunk')
      reserve(size)
      out.set(input.subarray(pos, pos + size), outLength)
      outLength += size
      pos += size
      needsReset = true
      continue
    }
    if (control < 0x80) invalid(`bad LZMA2 control byte 0x${control.toString(16)}`)

    const resetMode = (control >>> 5) & 0x03
    const unpackedHigh = control & 0x1f
    if (pos + 4 > limit) invalid('truncated LZMA2 chunk header')
    const unpackedSize = (unpackedHigh << 16) + ((input[pos] << 8) | input[pos + 1]) + 1
    pos += 2
    const packedSize = ((input[pos] << 8) | input[pos + 1]) + 1
    pos += 2
    if (resetMode >= 2) {
      if (pos >= limit) invalid('truncated LZMA2 chunk header')
      decoder.setProperties(input[pos])
      pos += 1
    }
    if (resetMode >= 1 || needsReset) {
      decoder.reset()
      needsReset = false
    }
    if (pos + packedSize > limit) invalid('truncated LZMA2 chunk')
    reserve(unpackedSize)
    const rangeDecoder = new RangeDecoder(input, pos, pos + packedSize)
    outLength = decoder.decodeChunk(rangeDecoder, out, outLength, unpackedSize)
    if (decoder.endMarker) invalid('unexpected LZMA end marker inside an LZMA2 chunk')
    pos += packedSize
  }
  return { bytes: out.subarray(0, outLength), end: pos }
}

/**
 * Undo the xz delta filter.
 * @param {Uint8Array} bytes
 * @param {Uint8Array} props
 * @returns {Uint8Array}
 */
function decodeDelta(bytes, props) {
  if (props.length !== 1) invalid('bad delta filter properties')
  const distance = props[0] + 1
  const out = new Uint8Array(bytes.length)
  const history = new Uint8Array(distance)
  for (let i = 0; i < bytes.length; i += 1) {
    const slot = i % distance
    const value = (bytes[i] + history[slot]) & 0xff
    out[i] = value
    history[slot] = value
  }
  return out
}

/** @param {number} byte @returns {boolean} */
function isMsByte(byte) {
  return byte === 0 || byte === 0xff
}

/**
 * Undo the xz x86 BCJ filter (the LZMA SDK's `x86_Convert` in decoding mode).
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function decodeX86(bytes) {
  const out = bytes.slice()
  const size = out.length
  if (size < 5) return out
  const limit = size - 4
  let mask = 0
  let pos = 0
  const ip = 5
  for (;;) {
    let cursor = pos
    while (cursor < limit && (out[cursor] & 0xfe) !== 0xe8) cursor += 1
    const distance = cursor - pos
    pos = cursor
    if (cursor >= limit) return out
    if (distance > 2) {
      mask = 0
    } else {
      mask >>>= distance
      if (mask !== 0 && (mask > 4 || mask === 3 || isMsByte(out[cursor + (mask >>> 1) + 1]))) {
        mask = (mask >>> 1) | 4
        pos += 1
        continue
      }
    }
    if (!isMsByte(out[cursor + 4])) {
      mask = (mask >>> 1) | 4
      pos += 1
      continue
    }
    let value = ((out[cursor + 4] << 24) | (out[cursor + 3] << 16) | (out[cursor + 2] << 8) | out[cursor + 1]) >>> 0
    const current = (ip + pos) >>> 0
    pos += 5
    value = (value - current) >>> 0
    if (mask !== 0) {
      const shift = (mask & 6) << 2
      if (isMsByte((value >>> shift) & 0xff)) {
        value = (value ^ (((0x100 << shift) - 1) >>> 0)) >>> 0
        value = (value - current) >>> 0
      }
      mask = 0
    }
    out[cursor + 1] = value & 0xff
    out[cursor + 2] = (value >>> 8) & 0xff
    out[cursor + 3] = (value >>> 16) & 0xff
    out[cursor + 4] = (0 - ((value >>> 24) & 1)) & 0xff
  }
}

/**
 * Read one xz variable-length integer.
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} end
 * @returns {{ value: number, next: number }}
 */
function readVli(bytes, pos, end) {
  let value = 0
  let scale = 1
  for (let i = 0; i < 9; i += 1) {
    if (pos >= end) invalid('truncated xz variable-length integer')
    const byte = bytes[pos]
    pos += 1
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) {
      if (byte === 0 && i > 0) invalid('non-minimal xz variable-length integer')
      return { value, next: pos }
    }
    scale *= 128
    if (scale > 2 ** 53) invalid('xz variable-length integer is too large')
  }
  invalid('xz variable-length integer is too long')
}

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @returns {number}
 */
function readU32le(bytes, pos) {
  if (pos + 4 > bytes.length) invalid('truncated little-endian integer')
  return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0
}

/** Check sizes per xz check type. */
const XZ_CHECK_SIZES = new Map([
  [0x00, 0],
  [0x01, 4],
  [0x04, 8],
])

/**
 * Decode one xz block, appending its payload to `sink`.
 * @param {Uint8Array} input
 * @param {number} blockStart
 * @param {number} checkType
 * @param {ByteSink} sink
 * @returns {number} offset of the next block header
 */
function decodeXzBlock(input, blockStart, checkType, sink) {
  if (blockStart >= input.length) invalid('truncated xz block header')
  const headerSize = (input[blockStart] + 1) * 4
  const headerEnd = blockStart + headerSize
  if (headerEnd > input.length) invalid('truncated xz block header')
  const storedCrc = readU32le(input, headerEnd - 4)
  if (crc32(input, blockStart, headerEnd - 4) !== storedCrc) invalid('xz block header CRC mismatch')

  let pos = blockStart + 1
  const flags = input[pos]
  pos += 1
  if ((flags & 0x3c) !== 0) invalid('reserved xz block header flags are set')
  const filterCount = (flags & 0x03) + 1
  let compressedSize = -1
  let uncompressedSize = -1
  if ((flags & 0x40) !== 0) {
    const read = readVli(input, pos, headerEnd - 4)
    compressedSize = read.value
    pos = read.next
  }
  if ((flags & 0x80) !== 0) {
    const read = readVli(input, pos, headerEnd - 4)
    uncompressedSize = read.value
    pos = read.next
  }
  const filters = []
  for (let i = 0; i < filterCount; i += 1) {
    const id = readVli(input, pos, headerEnd - 4)
    pos = id.next
    const propsSize = readVli(input, pos, headerEnd - 4)
    pos = propsSize.next
    if (pos + propsSize.value > headerEnd - 4) invalid('truncated xz filter properties')
    filters.push({ id: id.value, props: input.subarray(pos, pos + propsSize.value) })
    pos += propsSize.value
  }
  for (let i = pos; i < headerEnd - 4; i += 1) {
    if (input[i] !== 0) invalid('non-zero xz block header padding')
  }

  const dataStart = headerEnd
  const dataEnd = compressedSize >= 0 ? dataStart + compressedSize : input.length
  if (dataEnd > input.length) invalid('truncated xz block data')

  const last = filters[filters.length - 1]
  if (last.id !== FILTER_LZMA2) unsupported(`xz filter 0x${last.id.toString(16)} is not supported`)
  if (filters.length > 1) {
    for (const filter of filters.slice(0, -1)) {
      if (filter.id !== FILTER_DELTA && filter.id !== FILTER_X86) {
        unsupported(`xz filter 0x${filter.id.toString(16)} is not supported`)
      }
    }
  }
  const remaining = sink.maxBytes - sink.length
  const decoded = decodeLzma2(input, dataStart, dataEnd, last.props, remaining)
  if (compressedSize >= 0 && decoded.end !== dataEnd) invalid('xz block compressed size mismatch')

  let payload = decoded.bytes
  if (uncompressedSize >= 0 && payload.length !== uncompressedSize) invalid('xz block uncompressed size mismatch')
  for (let i = filters.length - 2; i >= 0; i -= 1) {
    const filter = filters[i]
    payload = filter.id === FILTER_DELTA ? decodeDelta(payload, filter.props) : decodeX86(payload)
  }

  let pos2 = decoded.end
  const padding = (4 - ((pos2 - blockStart) % 4)) % 4
  for (let i = 0; i < padding; i += 1) {
    if (pos2 + i >= input.length) invalid('truncated xz block padding')
    if (input[pos2 + i] !== 0) invalid('non-zero xz block padding')
  }
  pos2 += padding

  const checkSize = XZ_CHECK_SIZES.get(checkType)
  if (checkSize === undefined) unsupported(`xz check type 0x${checkType.toString(16)} is not supported`)
  if (pos2 + checkSize > input.length) invalid('truncated xz block check')
  if (checkSize === 4) {
    if (crc32(payload) !== readU32le(input, pos2)) invalid('xz block CRC32 mismatch')
  } else if (checkSize === 8) {
    const crc = new Crc64()
    crc.update(payload)
    const digest = crc.digest()
    if (digest.lo !== readU32le(input, pos2) || digest.hi !== readU32le(input, pos2 + 4)) {
      invalid('xz block CRC64 mismatch')
    }
  }

  sink.pushBytes(payload)
  return pos2 + checkSize
}

/**
 * Decode one complete xz stream (header, blocks, index, footer).
 * @param {Uint8Array} input
 * @param {number} start
 * @param {ByteSink} sink
 * @returns {number} offset just past the stream footer
 */
function decodeXzStream(input, start, sink) {
  if (start + 12 > input.length) invalid('truncated xz stream header')
  for (let i = 0; i < 6; i += 1) {
    if (input[start + i] !== XZ_MAGIC[i]) invalid('missing xz stream signature')
  }
  const flagsOffset = start + 6
  if (input[flagsOffset] !== 0) unsupported('reserved xz stream flags are set')
  const checkType = input[flagsOffset + 1]
  if (crc32(input, flagsOffset, flagsOffset + 2) !== readU32le(input, start + 8)) {
    invalid('xz stream header CRC mismatch')
  }

  let pos = start + 12
  let blocks = 0
  for (;;) {
    if (pos >= input.length) invalid('truncated xz stream')
    if (input[pos] === 0x00) break
    pos = decodeXzBlock(input, pos, checkType, sink)
    blocks += 1
  }

  const indexStart = pos
  pos += 1
  const count = readVli(input, pos, input.length)
  pos = count.next
  for (let i = 0; i < count.value; i += 1) {
    const unpadded = readVli(input, pos, input.length)
    pos = unpadded.next
    const uncompressed = readVli(input, pos, input.length)
    pos = uncompressed.next
  }
  if (count.value !== blocks) invalid('xz index block count does not match the stream')
  const indexPadding = (4 - ((pos - indexStart) % 4)) % 4
  pos += indexPadding
  if (pos + 4 > input.length) invalid('truncated xz index')
  if (crc32(input, indexStart, pos) !== readU32le(input, pos)) invalid('xz index CRC mismatch')
  pos += 4

  if (pos + 12 > input.length) invalid('truncated xz stream footer')
  if (crc32(input, pos + 4, pos + 10) !== readU32le(input, pos)) invalid('xz stream footer CRC mismatch')
  const backward = readU32le(input, pos + 4)
  if ((backward + 1) * 4 !== pos - indexStart) invalid('xz stream footer index size mismatch')
  if (input[pos + 8] !== input[flagsOffset] || input[pos + 9] !== input[flagsOffset + 1]) {
    invalid('xz stream footer flags do not match the header')
  }
  if (input[pos + 10] !== 0x59 || input[pos + 11] !== 0x5a) invalid('missing xz stream footer signature')
  return pos + 12
}

/**
 * Decompress an xz stream (possibly several concatenated streams).
 * @param {Uint8Array} input
 * @param {number} maxOutputBytes
 * @returns {Uint8Array}
 */
function unxz(input, maxOutputBytes) {
  const sink = new ByteSink(maxOutputBytes)
  let offset = 0
  let streams = 0
  while (offset < input.length) {
    if (input[offset] === 0x00) {
      let pad = 0
      while (offset + pad < input.length && input[offset + pad] === 0x00) pad += 1
      if (pad % 4 !== 0) invalid('xz stream padding is not a multiple of four bytes')
      offset += pad
      if (offset >= input.length) break
    }
    offset = decodeXzStream(input, offset, sink)
    streams += 1
  }
  if (streams === 0) invalid('no xz stream found')
  return sink.result()
}

/**
 * Decompress one complete compressed stream held in memory.
 * @param {'bzip2' | 'xz'} format
 * @param {Uint8Array} input the whole compressed stream
 * @param {{ maxOutputBytes?: number }} [options] default 96 MiB
 * @returns {Uint8Array}
 * @throws {DecompressError} 'too-large' when the output would exceed the cap (checked before allocating),
 *   'invalid' for corrupt or truncated input, 'unsupported' for a feature the decoder does not implement.
 */
export function decompressAll(format, input, options) {
  const bytes = asBytes(input)
  if (bytes === undefined) invalid('input must be a Uint8Array')
  const limit = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    invalid('maxOutputBytes must be a non-negative number')
  }
  const maxOutputBytes = Math.floor(limit)
  if (format !== 'bzip2' && format !== 'xz') unsupported(`unsupported compression format: ${String(format)}`)
  try {
    return format === 'bzip2' ? bunzip2(bytes, maxOutputBytes) : unxz(bytes, maxOutputBytes)
  } catch (error) {
    if (error instanceof DecompressError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new DecompressError('invalid', `malformed ${format} stream: ${detail}`)
  }
}

/**
 * Detect a compressed-stream format from leading bytes.
 * @param {Uint8Array} head
 * @returns {'gzip'|'bzip2'|'xz'|'zstd'|'brotli'|undefined}
 */
export function sniffCompression(head) {
  const bytes = asBytes(head)
  if (bytes === undefined) return undefined
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip'
  if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) return 'bzip2'
  if (bytes.length >= 6) {
    let xz = true
    for (let i = 0; i < 6; i += 1) {
      if (bytes[i] !== XZ_MAGIC[i]) {
        xz = false
        break
      }
    }
    if (xz) return 'xz'
  }
  if (bytes.length >= 4) {
    if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) return 'zstd'
    if ((bytes[0] & 0xf0) === 0x50 && bytes[1] === 0x2a && bytes[2] === 0x4d && bytes[3] === 0x18) return 'zstd'
  }
  // Brotli has no magic number: it is never guessed.
  return undefined
}
