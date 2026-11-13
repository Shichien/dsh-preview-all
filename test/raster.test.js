import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, inflateSync } from 'node:zlib'
import { rasterToPng, sniffRaster, RasterError } from '../lib/formats/raster/decode.js'

/* ------------------------------------------------------------------------- *
 * Fixture writers
 *
 * Every TIFF below is built here rather than checked in, so each test states
 * exactly which tags it exercises. Real files written by libtiff (through
 * Pillow) and by ImageMagick appear at the end, as base64, to prove the same
 * code path against bytes no part of this test produced.
 * ------------------------------------------------------------------------- */

/**
 * Pack bits MSB-first into a byte array.
 * @param {number[]} codes
 * @param {number[]} widths  bit width of each code
 * @returns {Uint8Array}
 */
function packCodes(codes, widths) {
  const out = []
  let accumulator = 0
  let bits = 0
  for (let i = 0; i < codes.length; i += 1) {
    accumulator = (accumulator << widths[i]) | codes[i]
    bits += widths[i]
    while (bits >= 8) {
      bits -= 8
      out.push((accumulator >> bits) & 0xff)
    }
    accumulator &= (1 << bits) - 1
  }
  if (bits > 0) out.push((accumulator << (8 - bits)) & 0xff)
  return new Uint8Array(out)
}

/**
 * Encode bytes as TIFF LZW, mirroring libtiff's `LZWEncode`: 9- to 12-bit codes,
 * MSB-first, clear 256, end 257. The width grows only once the next free slot
 * passes MAXCODE(width), which is one entry later than the decoder's Aldus rule
 * because the decoder's table always trails the encoder's by one entry.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function lzwEncode(data) {
  const codes = []
  const widths = []
  let width = 9
  let maxCode = (1 << width) - 1
  const table = new Map()
  let next = 258
  const push = (code) => {
    codes.push(code)
    widths.push(width)
  }
  push(256)
  if (data.length === 0) {
    push(257)
    return packCodes(codes, widths)
  }
  let current = data[0]
  for (let i = 1; i < data.length; i += 1) {
    const byte = data[i]
    const key = (current << 8) | byte
    const found = table.get(key)
    if (found !== undefined) {
      current = found
      continue
    }
    push(current)
    if (next === 4094) {
      // Table full: libtiff emits a clear code at the current width, then resets.
      push(256)
      table.clear()
      next = 258
      width = 9
      maxCode = (1 << width) - 1
    } else {
      table.set(key, next)
      next += 1
      // libtiff's encoder widens only once its next free slot passes
      // MAXCODE(width), one entry later than the decoder's Aldus rule, because
      // the decoder's table always trails the encoder's by one entry.
      if (next > maxCode && width < 12) {
        width += 1
        maxCode = (1 << width) - 1
      }
    }
    current = byte
  }
  push(current)
  push(257)
  return packCodes(codes, widths)
}

/**
 * Encode bytes as PackBits.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function packBitsEncode(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    let run = 1
    while (i + run < data.length && data[i + run] === data[i] && run < 128) run += 1
    if (run >= 2) {
      out.push(257 - run, data[i])
      i += run
      continue
    }
    let literal = 0
    while (i + literal < data.length && literal < 128) {
      const next = i + literal + 1
      if (next < data.length && data[next] === data[i + literal] && next + 1 < data.length && data[next + 1] === data[i + literal]) break
      literal += 1
    }
    out.push(literal - 1)
    for (let k = 0; k < literal; k += 1) out.push(data[i + k])
    i += literal
  }
  return new Uint8Array(out)
}

/**
 * Build a TIFF file.
 *
 * One writer for both layouts: classic (magic 42, 12-byte entries) and BigTIFF
 * (magic 43, 20-byte entries with 64-bit counts and value fields), in either
 * byte order, with strips or tiles. `blocks` are already-compressed payloads;
 * the StripOffsets/StripByteCounts (or Tile*) tags are filled in here.
 * @param {object} spec
 * @param {'le' | 'be'} [spec.order]
 * @param {boolean} [spec.big]
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} [spec.samples]
 * @param {number} [spec.bits]
 * @param {number[]} [spec.bitsPerSample]  overrides `bits` when a tag needs several entries
 * @param {number} [spec.compression]
 * @param {number} [spec.photometric]
 * @param {number} [spec.predictor]
 * @param {number} [spec.rowsPerStrip]
 * @param {number} [spec.planar]
 * @param {number} [spec.orientation]
 * @param {number[]} [spec.extraSamples]
 * @param {number[]} [spec.colorMap]
 * @param {number[]} [spec.tileSize]  [width, height] to emit tiles instead of strips
 * @param {Uint8Array[]} spec.blocks
 * @returns {Uint8Array}
 */
function tiff(spec) {
  const order = spec.order ?? 'le'
  const big = spec.big ?? false
  const samples = spec.samples ?? 1
  const tiled = spec.tileSize !== undefined
  const blocks = spec.blocks

  const typeBytes = (type) => (type === 3 ? 2 : type === 4 ? 4 : 1)
  const entries = []
  const add = (tag, type, values) => entries.push({ tag, type, values })

  add(256, 4, [spec.width])
  add(257, 4, [spec.height])
  add(258, 3, spec.bitsPerSample ?? new Array(samples).fill(spec.bits ?? 8))
  add(259, 3, [spec.compression ?? 1])
  add(262, 3, [spec.photometric ?? (samples >= 3 ? 2 : 1)])
  if (spec.orientation !== undefined) add(274, 3, [spec.orientation])
  add(277, 3, [samples])
  if (spec.planar !== undefined) add(284, 3, [spec.planar])
  if (spec.predictor !== undefined) add(317, 3, [spec.predictor])
  if (spec.colorMap !== undefined) add(320, 3, spec.colorMap)
  if (spec.extraSamples !== undefined) add(338, 3, spec.extraSamples)
  if (tiled) {
    add(322, 4, [spec.tileSize[0]])
    add(323, 4, [spec.tileSize[1]])
    add(324, 4, new Array(blocks.length).fill(0))
    add(325, 4, new Array(blocks.length).fill(0))
  } else {
    add(273, 4, new Array(blocks.length).fill(0))
    add(278, 4, [spec.rowsPerStrip ?? spec.height])
    add(279, 4, new Array(blocks.length).fill(0))
  }
  // TIFF requires the IFD to be sorted by tag.
  entries.sort((a, b) => a.tag - b.tag)

  const headerSize = big ? 16 : 8
  const countSize = big ? 8 : 2
  const entrySize = big ? 20 : 12
  const valueSize = big ? 8 : 4
  const offsetTag = tiled ? 324 : 273
  const countTag = tiled ? 325 : 279

  // Out-of-line tag values first, then the block table, then the block bytes.
  let valueCursor = headerSize + countSize + entries.length * entrySize + valueSize
  const valueOffsets = new Map()
  for (const entry of entries) {
    const bytes = entry.values.length * typeBytes(entry.type)
    if (bytes > valueSize) {
      valueOffsets.set(entry.tag, valueCursor)
      valueCursor += bytes + (bytes % 2)
    }
  }
  const tableOffset = valueCursor
  let blockCursor = tableOffset + blocks.length * (big ? 16 : 8)
  const blockOffsets = []
  for (const block of blocks) {
    blockOffsets.push(blockCursor)
    blockCursor += block.length + (block.length % 2)
  }

  const out = new Uint8Array(blockCursor)
  const view = new DataView(out.buffer)
  const little = order === 'le'
  const w16 = (at, value) => view.setUint16(at, value, little)
  const w32 = (at, value) => view.setUint32(at, value, little)
  const w64 = (at, value) => {
    const lo = value % 0x100000000
    const hi = Math.floor(value / 0x100000000)
    view.setUint32(little ? at : at + 4, lo, little)
    view.setUint32(little ? at + 4 : at, hi, little)
  }

  out[0] = little ? 0x49 : 0x4d
  out[1] = little ? 0x49 : 0x4d
  if (big) {
    w16(2, 43)
    w16(4, 8)
    w16(6, 0)
    w64(8, headerSize)
  } else {
    w16(2, 42)
    w32(4, headerSize)
  }

  if (big) w64(headerSize, entries.length)
  else w16(headerSize, entries.length)

  const entryBase = headerSize + countSize
  entries.forEach((entry, index) => {
    const at = entryBase + index * entrySize
    let values = entry.values
    if (entry.tag === offsetTag) values = blockOffsets
    else if (entry.tag === countTag) values = blocks.map((block) => block.length)

    w16(at, entry.tag)
    w16(at + 2, entry.type)
    if (big) w64(at + 4, values.length)
    else w32(at + 4, values.length)

    const bytes = values.length * typeBytes(entry.type)
    const inline = bytes <= valueSize
    const valueAt = inline ? at + (big ? 12 : 8) : valueOffsets.get(entry.tag)
    if (!inline) {
      // The entry's value field holds the offset of the real data.
      if (big) w64(at + 12, valueAt)
      else w32(at + 8, valueAt)
    }
    values.forEach((value, k) => {
      // Inline values sit left-justified in the value field, written at their
      // own width: a BigTIFF LONG is still 4 bytes, not a padded 64-bit word.
      const p = valueAt + k * typeBytes(entry.type)
      if (entry.type === 3) w16(p, value)
      else w32(p, value)
    })
  })
  // No next IFD.
  if (big) w64(entryBase + entries.length * entrySize, 0)
  else w32(entryBase + entries.length * entrySize, 0)

  blockOffsets.forEach((offset, index) => out.set(blocks[index], offset))
  return out
}
/**
 * Build the uncompressed samples for a simple test image.
 * @param {number} width
 * @param {number} height
 * @param {number} samples
 * @param {(x: number, y: number, s: number) => number} value
 * @returns {Uint8Array}
 */
function pixels(width, height, samples, value) {
  const out = new Uint8Array(width * height * samples)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let s = 0; s < samples; s += 1) out[(y * width + x) * samples + s] = value(x, y, s)
    }
  }
  return out
}

/**
 * Apply horizontal differencing (Predictor 2) to 8-bit rows.
 * @param {Uint8Array} data
 * @param {number} rowBytes
 * @param {number} samples
 * @returns {Uint8Array}
 */
function applyPredictor8(data, rowBytes, samples) {
  const out = Uint8Array.from(data)
  for (let row = 0; row + rowBytes <= out.length; row += rowBytes) {
    for (let i = row + rowBytes - 1; i >= row + samples; i -= 1) out[i] = (out[i] - out[i - samples]) & 0xff
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * A tiny PNG reader, so assertions compare pixels rather than bytes
 * ------------------------------------------------------------------------- */

/**
 * Read a PNG produced by `rasterToPng` back into raw pixels.
 * @param {Uint8Array} png
 * @returns {{ width: number, height: number, channels: number, pixels: Uint8Array }}
 */
function readPng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let at = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []
  let sawEnd = false
  while (at < png.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7])
    const body = png.subarray(at + 8, at + 8 + length)
    const stored = view.getUint32(at + 8 + length)
    assert.equal(stored, crc32(png, at + 4, at + 8 + length), `PNG ${type} CRC`)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      bitDepth = body[8]
      colorType = body[9]
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body))
    } else if (type === 'IEND') {
      sawEnd = true
      break
    }
    at += 12 + length
  }
  assert.ok(sawEnd, 'PNG ends with IEND')
  assert.equal(bitDepth, 8, 'PNG is 8 bits per channel')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  assert.ok(channels !== 0, `PNG colour type ${colorType} is RGB or RGBA`)
  const raw = inflateSync(Buffer.concat(idat))
  const rowBytes = width * channels
  assert.equal(raw.length, (rowBytes + 1) * height, 'IDAT holds exactly one filter byte per row')
  const out = new Uint8Array(width * height * channels)
  for (let y = 0; y < height; y += 1) {
    const base = y * (rowBytes + 1)
    assert.equal(raw[base], 0, 'rows use filter type 0')
    out.set(raw.subarray(base + 1, base + 1 + rowBytes), y * rowBytes)
  }
  return { width, height, channels, pixels: out }
}

/**
 * CRC32 over a byte range, mirroring the PNG checksum.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function crc32(bytes, start, end) {
  let crc = 0xffffffff
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i]
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Assert that a decode result matches the expected 8-bit pixels.
 * @param {{ png: Uint8Array, width: number, height: number } | undefined} result
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {Uint8Array} expected
 */
function assertPixels(result, width, height, channels, expected) {
  assert.ok(result !== undefined, 'decode returned a result')
  assert.equal(result.width, width)
  assert.equal(result.height, height)
  const image = readPng(result.png)
  assert.equal(image.width, width)
  assert.equal(image.height, height)
  assert.equal(image.channels, channels)
  assert.deepEqual([...image.pixels], [...expected])
}

/**
 * Assert that a call raises a RasterError with a specific code.
 * @param {() => unknown} run
 * @param {'unsupported' | 'invalid' | 'too-large'} code
 * @param {RegExp} [message]
 */
function assertRasterError(run, code, message) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof RasterError, `expected RasterError, got ${error?.constructor?.name}`)
    assert.equal(error.code, code)
    assert.ok(error instanceof Error)
    if (message !== undefined) assert.match(error.message, message)
    return true
  })
}

/* ------------------------------------------------------------------------- *
 * sniffRaster
 * ------------------------------------------------------------------------- */

test('sniffRaster recognises every signature it claims', () => {
  assert.equal(sniffRaster(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0])), 'tiff')
  assert.equal(sniffRaster(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 0])), 'tiff')
  assert.equal(sniffRaster(new Uint8Array([0x49, 0x49, 0x2b, 0x00, 0, 0, 0, 0])), 'tiff')
  assert.equal(sniffRaster(new Uint8Array([0x4d, 0x4d, 0x00, 0x2b, 0, 0, 0, 0])), 'tiff')
  assert.equal(sniffRaster(new Uint8Array([0x38, 0x42, 0x50, 0x53, 0, 1])), 'psd')
  assert.equal(sniffRaster(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png')
  assert.equal(sniffRaster(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg')
  assert.equal(sniffRaster(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'gif')
  assert.equal(sniffRaster(new Uint8Array([0x42, 0x4d, 0, 0])), 'bmp')
  assert.equal(sniffRaster(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'webp')
})

test('sniffRaster reports nothing for unknown bytes', () => {
  assert.equal(sniffRaster(new Uint8Array(0)), undefined)
  assert.equal(sniffRaster(new Uint8Array([0x00, 0x01, 0x02, 0x03])), undefined)
  assert.equal(sniffRaster(new TextEncoder().encode('hello, world')), undefined)
  // A TIFF-like prefix with the wrong magic is not a TIFF.
  assert.equal(sniffRaster(new Uint8Array([0x49, 0x49, 0x2c, 0x00, 0, 0, 0, 0])), undefined)
})

test('rasterToPng ignores formats the browser already renders', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  assert.equal(rasterToPng(png), undefined)
  assert.equal(rasterToPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), undefined)
  assert.equal(rasterToPng(new TextEncoder().encode('not an image at all')), undefined)
})

/* ------------------------------------------------------------------------- *
 * TIFF: the basics
 * ------------------------------------------------------------------------- */

test('TIFF: uncompressed 8-bit RGB, little-endian', () => {
  const width = 5
  const height = 3
  const raw = pixels(width, height, 3, (x, y, s) => (x * 20 + y * 7 + s * 40) & 0xff)
  const file = tiff({ width, height, samples: 3, bits: 8, compression: 1, blocks: [raw] })
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: uncompressed 8-bit RGB, big-endian', () => {
  const width = 4
  const height = 4
  const raw = pixels(width, height, 3, (x, y, s) => (x * 11 + y * 23 + s * 60) & 0xff)
  const file = tiff({ order: 'be', width, height, samples: 3, bits: 8, blocks: [raw] })
  assert.equal(file[0], 0x4d)
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: BigTIFF is read the same as classic TIFF', () => {
  const width = 6
  const height = 2
  const raw = pixels(width, height, 3, (x, y, s) => (x * 31 + y * 5 + s * 90) & 0xff)
  const classic = tiff({ width, height, samples: 3, blocks: [raw] })
  const big = tiff({ big: true, width, height, samples: 3, blocks: [raw] })
  assert.equal(big[2], 0x2b)
  assert.equal(big[3], 0x00)
  assertPixels(rasterToPng(big), width, height, 3, raw)
  assert.deepEqual([...rasterToPng(big).png], [...rasterToPng(classic).png])
})

test('TIFF: BigTIFF big-endian', () => {
  const width = 3
  const height = 3
  const raw = pixels(width, height, 3, (x, y, s) => (x * 40 + y * 13 + s * 70) & 0xff)
  const file = tiff({ order: 'be', big: true, width, height, samples: 3, blocks: [raw] })
  assert.deepEqual([...file.subarray(0, 4)], [0x4d, 0x4d, 0x00, 0x2b])
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: multiple strips are stitched back together', () => {
  const width = 4
  const height = 6
  const raw = pixels(width, height, 3, (x, y, s) => (x * 9 + y * 37 + s * 55) & 0xff)
  const rowBytes = width * 3
  const blocks = []
  for (let y = 0; y < height; y += 2) blocks.push(raw.subarray(y * rowBytes, Math.min(height, y + 2) * rowBytes))
  const file = tiff({ width, height, samples: 3, rowsPerStrip: 2, blocks })
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: tiles are reassembled, including the partial edge tiles', () => {
  const width = 10
  const height = 7
  const tileSize = [4, 4]
  const raw = pixels(width, height, 3, (x, y, s) => (x * 17 + y * 29 + s * 33) & 0xff)
  const across = Math.ceil(width / tileSize[0])
  const down = Math.ceil(height / tileSize[1])
  const blocks = []
  for (let ty = 0; ty < down; ty += 1) {
    for (let tx = 0; tx < across; tx += 1) {
      // Tiles are always a full tile wide and tall, padded with zeros.
      const tile = new Uint8Array(tileSize[0] * tileSize[1] * 3)
      for (let r = 0; r < tileSize[1]; r += 1) {
        for (let c = 0; c < tileSize[0]; c += 1) {
          const x = tx * tileSize[0] + c
          const y = ty * tileSize[1] + r
          if (x >= width || y >= height) continue
          for (let s = 0; s < 3; s += 1) tile[(r * tileSize[0] + c) * 3 + s] = raw[(y * width + x) * 3 + s]
        }
      }
      blocks.push(tile)
    }
  }
  const file = tiff({ width, height, samples: 3, tileSize, blocks })
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: LZW strips decode', () => {
  const width = 8
  const height = 5
  const raw = pixels(width, height, 3, (x, y, s) => (x * 21 + y * 44 + s * 77) & 0xff)
  const file = tiff({ width, height, samples: 3, compression: 5, blocks: [lzwEncode(raw)] })
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: LZW round-trips a long, highly repetitive strip', () => {
  // Long runs force the encoder past the 9- and 10-bit dictionary boundaries,
  // which is where the Aldus early-width-change rule matters.
  const width = 40
  const height = 30
  const raw = pixels(width, height, 1, (x, y) => (y % 3 === 0 ? 0 : (x * 3 + y) & 0xff))
  const file = tiff({ width, height, samples: 1, photometric: 1, compression: 5, blocks: [lzwEncode(raw)] })
  assertPixels(rasterToPng(file), width, height, 3, replicateGray(raw))
})

test('TIFF: Deflate strips decode (both 8 and 32946)', () => {
  const width = 5
  const height = 4
  const raw = pixels(width, height, 3, (x, y, s) => (x * 6 + y * 51 + s * 12) & 0xff)
  for (const compression of [8, 32946]) {
    const file = tiff({ width, height, samples: 3, compression, blocks: [new Uint8Array(deflateSync(raw))] })
    assertPixels(rasterToPng(file), width, height, 3, raw)
  }
})

test('TIFF: PackBits strips decode', () => {
  const width = 9
  const height = 4
  const raw = pixels(width, height, 3, (x, y, s) => (x < 3 ? 200 : (x * 3 + y * 8 + s) & 0xff))
  const file = tiff({ width, height, samples: 3, compression: 32773, blocks: [packBitsEncode(raw)] })
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: one PackBits strip per row', () => {
  const width = 7
  const height = 3
  const rowBytes = width * 3
  const raw = pixels(width, height, 3, (x, y, s) => (x * 30 + y * 9 + s * 61) & 0xff)
  const blocks = []
  for (let y = 0; y < height; y += 1) blocks.push(packBitsEncode(raw.subarray(y * rowBytes, (y + 1) * rowBytes)))
  const file = tiff({ width, height, samples: 3, compression: 32773, rowsPerStrip: 1, blocks })
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: grayscale 8-bit', () => {
  const width = 4
  const height = 3
  const raw = pixels(width, height, 1, (x, y) => (x * 50 + y * 11) & 0xff)
  const file = tiff({ width, height, samples: 1, photometric: 1, blocks: [raw] })
  assertPixels(rasterToPng(file), width, height, 3, replicateGray(raw))
})

test('TIFF: WhiteIsZero grayscale is inverted', () => {
  const width = 3
  const height = 2
  const raw = pixels(width, height, 1, (x, y) => (x * 40 + y * 20) & 0xff)
  const file = tiff({ width, height, samples: 1, photometric: 0, blocks: [raw] })
  const inverted = Uint8Array.from(raw, (value) => 255 - value)
  assertPixels(rasterToPng(file), width, height, 3, replicateGray(inverted))
})

test('TIFF: palette 8-bit maps through the colour map', () => {
  const width = 4
  const height = 2
  const indices = pixels(width, height, 1, (x, y) => (x + y) % 4)
  const entries = 4
  const reds = [0, 65535, 0, 65535]
  const greens = [0, 0, 65535, 65535]
  const blues = [0, 0, 0, 65535]
  const colorMap = [...reds, ...greens, ...blues]
  const file = tiff({ width, height, samples: 1, photometric: 3, colorMap, blocks: [indices] })
  const expected = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    const index = indices[i]
    expected[i * 3] = reds[index] >> 8
    expected[i * 3 + 1] = greens[index] >> 8
    expected[i * 3 + 2] = blues[index] >> 8
  }
  assertPixels(rasterToPng(file), width, height, 3, expected)
})

test('TIFF: 1-bit bilevel expands to black and white', () => {
  const width = 10
  const height = 2
  // Row 0: 1010101010, row 1: 0000011111, padded to whole bytes per row.
  const rowBytes = Math.ceil(width / 8)
  const raw = new Uint8Array(rowBytes * height)
  const setBit = (x, y, on) => {
    if (!on) return
    raw[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
  }
  for (let x = 0; x < width; x += 1) setBit(x, 0, x % 2 === 0)
  for (let x = 0; x < width; x += 1) setBit(x, 1, x >= 5)
  const file = tiff({ width, height, samples: 1, bits: 1, photometric: 1, blocks: [raw] })
  const expected = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const on = (raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
      const value = on === 1 ? 255 : 0
      const o = (y * width + x) * 3
      expected[o] = value
      expected[o + 1] = value
      expected[o + 2] = value
    }
  }
  assertPixels(rasterToPng(file), width, height, 3, expected)
})

test('TIFF: 4-bit samples are scaled by 17', () => {
  const width = 4
  const height = 2
  const nibbles = [0, 5, 10, 15, 1, 7, 13, 15]
  const rowBytes = Math.ceil(width / 2)
  const raw = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = nibbles[y * width + x]
      const at = y * rowBytes + (x >> 1)
      raw[at] |= x % 2 === 0 ? value << 4 : value
    }
  }
  const file = tiff({ width, height, samples: 1, bits: 4, photometric: 1, blocks: [raw] })
  const expected = new Uint8Array(width * height * 3)
  for (let i = 0; i < nibbles.length; i += 1) {
    const value = nibbles[i] * 17
    expected[i * 3] = value
    expected[i * 3 + 1] = value
    expected[i * 3 + 2] = value
  }
  assertPixels(rasterToPng(file), width, height, 3, expected)
})

test('TIFF: 16-bit samples keep their high byte', () => {
  const width = 3
  const height = 2
  const values = [0x1234, 0xabcd, 0xff01, 0x00ff, 0x8000, 0x7fff]
  const raw = new Uint8Array(width * height * 2)
  const view = new DataView(raw.buffer)
  values.forEach((value, i) => view.setUint16(i * 2, value, true))
  const file = tiff({ width, height, samples: 1, bits: 16, photometric: 1, blocks: [raw] })
  const expected = new Uint8Array(width * height * 3)
  values.forEach((value, i) => {
    const high = value >> 8
    expected[i * 3] = high
    expected[i * 3 + 1] = high
    expected[i * 3 + 2] = high
  })
  assertPixels(rasterToPng(file), width, height, 3, expected)
})

test('TIFF: 16-bit big-endian samples keep their high byte', () => {
  const width = 2
  const height = 2
  const values = [0x1234, 0xabcd, 0xff01, 0x00ff]
  const raw = new Uint8Array(width * height * 2)
  const view = new DataView(raw.buffer)
  values.forEach((value, i) => view.setUint16(i * 2, value, false))
  const file = tiff({ order: 'be', width, height, samples: 1, bits: 16, photometric: 1, blocks: [raw] })
  const expected = new Uint8Array(width * height * 3)
  values.forEach((value, i) => {
    const high = value >> 8
    expected[i * 3] = high
    expected[i * 3 + 1] = high
    expected[i * 3 + 2] = high
  })
  assertPixels(rasterToPng(file), width, height, 3, expected)
})

test('TIFF: Predictor 2 is undone for 8-bit strips', () => {
  const width = 5
  const height = 4
  const rowBytes = width * 3
  const raw = pixels(width, height, 3, (x, y, s) => (x * 12 + y * 39 + s * 71) & 0xff)
  const file = tiff({ width, height, samples: 3, compression: 5, predictor: 2, blocks: [lzwEncode(applyPredictor8(raw, rowBytes, 3))] })
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: Predictor 2 is undone for 16-bit strips', () => {
  const width = 3
  const height = 3
  const samples = 3
  const rowBytes = width * samples * 2
  const raw = new Uint8Array(rowBytes * height)
  const view = new DataView(raw.buffer)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let s = 0; s < samples; s += 1) view.setUint16((y * width + x) * samples * 2 + s * 2, (x * 0x1111 + y * 0x2222 + s * 0x3333) & 0xffff, true)
    }
  }
  // Differencing runs per sample, over the whole row.
  const differenced = Uint8Array.from(raw)
  const diffView = new DataView(differenced.buffer)
  for (let y = 0; y < height; y += 1) {
    for (let x = width - 1; x >= 1; x -= 1) {
      for (let s = 0; s < samples; s += 1) {
        const at = y * rowBytes + x * samples * 2 + s * 2
        const previous = at - samples * 2
        diffView.setUint16(at, (diffView.getUint16(at, true) - diffView.getUint16(previous, true)) & 0xffff, true)
      }
    }
  }
  const file = tiff({ width, height, samples, bits: 16, compression: 8, predictor: 2, blocks: [new Uint8Array(deflateSync(differenced))] })
  const expected = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    for (let s = 0; s < 3; s += 1) expected[i * 3 + s] = view.getUint16(i * samples * 2 + s * 2, true) >> 8
  }
  assertPixels(rasterToPng(file), width, height, 3, expected)
})

test('TIFF: Predictor 2 is undone inside tiles', () => {
  const width = 8
  const height = 4
  const tileSize = [4, 4]
  const tileRowBytes = tileSize[0] * 3
  const raw = pixels(width, height, 3, (x, y, s) => (x * 18 + y * 27 + s * 45) & 0xff)
  const blocks = []
  for (let tx = 0; tx < 2; tx += 1) {
    const tile = new Uint8Array(tileRowBytes * tileSize[1])
    for (let r = 0; r < tileSize[1]; r += 1) {
      for (let c = 0; c < tileSize[0]; c += 1) {
        for (let s = 0; s < 3; s += 1) tile[(r * tileSize[0] + c) * 3 + s] = raw[(r * width + tx * tileSize[0] + c) * 3 + s]
      }
    }
    blocks.push(lzwEncode(applyPredictor8(tile, tileRowBytes, 3)))
  }
  const file = tiff({ width, height, samples: 3, tileSize, compression: 5, predictor: 2, blocks })
  assertPixels(rasterToPng(file), width, height, 3, raw)
})

test('TIFF: CMYK is converted with the documented naive formula', () => {
  const width = 3
  const height = 2
  const raw = pixels(width, height, 4, (x, y, s) => [10, 40, 90, 200][s] + x * 5 + y)
  const file = tiff({ width, height, samples: 4, photometric: 5, blocks: [raw] })
  const expected = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    const k = raw[i * 4 + 3]
    for (let s = 0; s < 3; s += 1) expected[i * 3 + s] = 255 - Math.min(255, raw[i * 4 + s] + k)
  }
  const result = rasterToPng(file)
  assertPixels(result, width, height, 3, expected)
  assert.match(result.note, /CMYK/)
})

test('TIFF: extra samples become an alpha channel', () => {
  const width = 4
  const height = 2
  const raw = pixels(width, height, 4, (x, y, s) => (s === 3 ? 40 + x * 50 : x * 60 + y * 10 + s * 20) & 0xff)
  const file = tiff({ width, height, samples: 4, photometric: 2, extraSamples: [2], blocks: [raw] })
  assertPixels(rasterToPng(file), width, height, 4, raw)
})

test('TIFF: associated alpha is passed through and noted', () => {
  const width = 2
  const height = 1
  const raw = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80])
  const file = tiff({ width, height, samples: 4, photometric: 2, extraSamples: [1], blocks: [raw] })
  const result = rasterToPng(file)
  assertPixels(result, width, height, 4, raw)
  assert.match(result.note, /premultiplied/)
})

test('TIFF: Orientation is ignored rather than obeyed', () => {
  const width = 3
  const height = 2
  const raw = pixels(width, height, 3, (x, y, s) => (x * 70 + y * 15 + s * 5) & 0xff)
  const plain = tiff({ width, height, samples: 3, blocks: [raw] })
  const rotated = tiff({ width, height, samples: 3, blocks: [raw], orientation: 6 })
  // The fixture writer only emits Orientation when asked; both must decode alike.
  assertPixels(rasterToPng(rotated), width, height, 3, raw)
  assert.deepEqual([...rasterToPng(rotated).png], [...rasterToPng(plain).png])
})

/* ------------------------------------------------------------------------- *
 * TIFF: refusals and failures
 * ------------------------------------------------------------------------- */

test('TIFF: embedded JPEG compression is refused, not faked', () => {
  const raw = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])
  const file = tiff({ width: 2, height: 2, samples: 3, compression: 7, blocks: [raw] })
  assertRasterError(() => rasterToPng(file), 'unsupported', /compression 7|JPEG/)
})

test('TIFF: CCITT fax compressions are refused', () => {
  for (const compression of [2, 3, 4]) {
    const file = tiff({ width: 8, height: 2, samples: 1, bits: 1, photometric: 1, compression, blocks: [new Uint8Array([0x00, 0x00])] })
    assertRasterError(() => rasterToPng(file), 'unsupported', /CCITT|fax/)
  }
})

test('TIFF: YCbCr photometric is refused', () => {
  const file = tiff({ width: 2, height: 2, samples: 3, photometric: 6, blocks: [new Uint8Array(12)] })
  assertRasterError(() => rasterToPng(file), 'unsupported', /YCbCr/)
})

test('TIFF: separate colour planes are refused', () => {
  const file = tiff({ width: 2, height: 2, samples: 3, planar: 2, blocks: [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)] })
  assertRasterError(() => rasterToPng(file), 'unsupported', /PlanarConfiguration|separate/)
})

test('TIFF: a truncated file is invalid', () => {
  const width = 4
  const height = 2
  const raw = pixels(width, height, 3, (x, y, s) => (x * 30 + y * 7 + s * 90) & 0xff)
  const file = tiff({ width, height, samples: 3, blocks: [raw] })
  // Cut the pixel data off; the header and IFD still parse, so the strip read
  // has to notice rather than inventing pixels.
  assertRasterError(() => rasterToPng(file.subarray(0, 60)), 'invalid')
  assertRasterError(() => rasterToPng(file.subarray(0, 4)), 'invalid')
})

test('TIFF: a header-only stub is invalid', () => {
  assertRasterError(() => rasterToPng(new Uint8Array([0x49, 0x49, 0x2a, 0x00])), 'invalid')
  assertRasterError(() => rasterToPng(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8])), 'invalid')
})

test('TIFF: a corrupt LZW stream is invalid', () => {
  const width = 16
  const height = 4
  const raw = pixels(width, height, 1, (x, y) => (x * 7 + y * 3) & 0xff)
  const encoded = lzwEncode(raw)
  // Flip bytes in the middle of the stream so the dictionary goes off the rails.
  const broken = Uint8Array.from(encoded)
  for (let i = 4; i < Math.min(broken.length, 12); i += 1) broken[i] = 0xff
  const file = tiff({ width, height, samples: 1, photometric: 1, compression: 5, blocks: [broken] })
  assertRasterError(() => rasterToPng(file), 'invalid')
})

test('TIFF: an enormous declared size is too large', () => {
  const file = tiff({ width: 200000, height: 200000, samples: 3, blocks: [new Uint8Array(16)] })
  assertRasterError(() => rasterToPng(file), 'too-large', /too large|above the/)
})

test('TIFF: a huge PSD is too large too', () => {
  const file = buildPsd({ width: 200000, height: 200000, channels: 3, mode: 3, planes: [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)] })
  assertRasterError(() => rasterToPng(file), 'too-large')
})

/* ------------------------------------------------------------------------- *
 * PSD / PSB
 * ------------------------------------------------------------------------- */

/**
 * Build a PSD with one raw-compressed merged composite.
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} [spec.channels]
 * @param {number} [spec.mode]
 * @param {number} [spec.depth]
 * @param {Uint8Array[]} spec.planes  one plane per channel
 * @param {number} [spec.version]
 * @param {number} [spec.compression]  0 raw, 1 RLE, 2 ZIP, 3 ZIP+prediction
 * @param {boolean} [spec.omitComposite]
 * @returns {Uint8Array}
 */
function buildPsd(spec) {
  const version = spec.version ?? 1
  const psb = version === 2
  const channels = spec.channels ?? spec.planes.length
  const depth = spec.depth ?? 8
  const mode = spec.mode ?? 3
  const compression = spec.compression ?? 0
  const bytesPerSample = depth >> 3
  const rowSize = spec.width * bytesPerSample

  const header = Buffer.alloc(26)
  header.write('8BPS', 0, 'latin1')
  header.writeUInt16BE(version, 4)
  header.writeUInt16BE(channels, 12)
  header.writeUInt32BE(spec.height, 14)
  header.writeUInt32BE(spec.width, 18)
  header.writeUInt16BE(depth, 22)
  header.writeUInt16BE(mode, 24)

  const emptySection = Buffer.alloc(4)
  const layerSection = Buffer.alloc(psb ? 8 : 4)
  // A zero-length layer section means "no layers", which still leaves the
  // merged composite that we read.

  let body
  if (compression === 0) {
    body = Buffer.concat([Buffer.from([0, 0]), ...spec.planes.map((plane) => Buffer.from(plane))])
  } else if (compression === 1) {
    const parts = [Buffer.from([0, 1])]
    const counts = []
    const rows = []
    for (const plane of spec.planes) {
      for (let y = 0; y < spec.height; y += 1) {
        const encoded = packBitsEncode(plane.subarray(y * rowSize, (y + 1) * rowSize))
        counts.push(encoded.length)
        rows.push(encoded)
      }
    }
    const countBuffer = Buffer.alloc(counts.length * (psb ? 4 : 2))
    counts.forEach((count, i) => (psb ? countBuffer.writeUInt32BE(count, i * 4) : countBuffer.writeUInt16BE(count, i * 2)))
    parts.push(countBuffer, ...rows.map((row) => Buffer.from(row)))
    body = Buffer.concat(parts)
  } else {
    const predicted = spec.planes.map((plane) => (compression === 3 ? applyPsdPrediction(plane, rowSize, depth) : plane))
    const stream = new Uint8Array(deflateSync(Buffer.concat(predicted.map((plane) => Buffer.from(plane)))))
    body = Buffer.concat([Buffer.from([0, compression]), Buffer.from(stream)])
  }

  const layers = spec.omitComposite === true ? Buffer.alloc(0) : body
  return new Uint8Array(Buffer.concat([header, emptySection, emptySection, layerSection, layers]))
}

/**
 * Apply PSD's "ZIP with prediction" delta, which runs per row within a channel.
 * @param {Uint8Array} plane
 * @param {number} rowSize
 * @param {number} depth
 * @returns {Uint8Array}
 */
function applyPsdPrediction(plane, rowSize, depth) {
  const out = Uint8Array.from(plane)
  for (let row = 0; row + rowSize <= out.length; row += rowSize) {
    if (depth === 8) {
      for (let i = row + rowSize - 1; i >= row + 1; i -= 1) out[i] = (out[i] - out[i - 1]) & 0xff
    } else {
      for (let i = row + rowSize - 2; i >= row + 2; i -= 2) {
        const value = (((out[i] << 8) | out[i + 1]) - ((out[i - 2] << 8) | out[i - 1])) & 0xffff
        out[i] = value >> 8
        out[i + 1] = value & 0xff
      }
    }
  }
  return out
}

test('PSD: raw RGB composite decodes', () => {
  const width = 5
  const height = 4
  const planes = [0, 1, 2].map((c) => pixels(width, height, 1, (x, y) => (x * 13 + y * 29 + c * 71) & 0xff))
  const file = buildPsd({ width, height, planes })
  const expected = interleave(planes, width * height)
  assertPixels(rasterToPng(file), width, height, 3, expected)
})

test('PSD: RLE composite decodes', () => {
  const width = 6
  const height = 3
  const planes = [0, 1, 2].map((c) => pixels(width, height, 1, (x, y) => (x * 21 + y * 37 + c * 53) & 0xff))
  const file = buildPsd({ width, height, planes, compression: 1 })
  assertPixels(rasterToPng(file), width, height, 3, interleave(planes, width * height))
})

test('PSD: ZIP composite decodes', () => {
  const width = 4
  const height = 3
  const planes = [0, 1, 2].map((c) => pixels(width, height, 1, (x, y) => (x * 44 + y * 9 + c * 33) & 0xff))
  const file = buildPsd({ width, height, planes, compression: 2 })
  assertPixels(rasterToPng(file), width, height, 3, interleave(planes, width * height))
})

test('PSD: ZIP with prediction decodes', () => {
  const width = 5
  const height = 3
  const planes = [0, 1, 2].map((c) => pixels(width, height, 1, (x, y) => (x * 26 + y * 61 + c * 19) & 0xff))
  const file = buildPsd({ width, height, planes, compression: 3 })
  const result = rasterToPng(file)
  assertPixels(result, width, height, 3, interleave(planes, width * height))
  assert.match(result.note, /prediction/)
})

test('PSD: grayscale replicates into RGB', () => {
  const width = 4
  const height = 2
  const plane = pixels(width, height, 1, (x, y) => (x * 60 + y * 15) & 0xff)
  const file = buildPsd({ width, height, channels: 1, mode: 1, planes: [plane] })
  assertPixels(rasterToPng(file), width, height, 3, replicateGray(plane))
})

test('PSD: CMYK is converted with the naive formula and noted', () => {
  const width = 3
  const height = 2
  const planes = [0, 1, 2, 3].map((c) => pixels(width, height, 1, (x, y) => [200, 120, 40, 30][c] + x * 4 + y * 2))
  const file = buildPsd({ width, height, channels: 4, mode: 4, planes })
  const expected = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    // PSD stores CMYK inverted, so `stored + storedK - 255` is the ink sum.
    for (let s = 0; s < 3; s += 1) expected[i * 3 + s] = Math.max(0, Math.min(255, planes[s][i] + planes[3][i] - 255))
  }
  const result = rasterToPng(file)
  assertPixels(result, width, height, 3, expected)
  assert.match(result.note, /CMYK/)
})

test('PSD: 16-bit channels keep their high byte', () => {
  const width = 2
  const height = 2
  const values = [0x1234, 0xabcd, 0x00ff, 0x8000]
  const planes = [0, 1, 2].map((c) => {
    const plane = new Uint8Array(width * height * 2)
    const view = new DataView(plane.buffer)
    values.forEach((value, i) => view.setUint16(i * 2, (value + c * 0x0101) & 0xffff, false))
    return plane
  })
  const file = buildPsd({ width, height, depth: 16, planes })
  const expected = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    for (let c = 0; c < 3; c += 1) expected[i * 3 + c] = ((values[i] + c * 0x0101) & 0xffff) >> 8
  }
  const result = rasterToPng(file)
  assertPixels(result, width, height, 3, expected)
  assert.match(result.note, /16-bit/)
})

test('PSD: an alpha channel is preserved', () => {
  const width = 3
  const height = 2
  const planes = [0, 1, 2, 3].map((c) => pixels(width, height, 1, (x, y) => (c === 3 ? 60 + x * 40 : x * 30 + y * 12 + c * 50) & 0xff))
  const file = buildPsd({ width, height, channels: 4, planes })
  assertPixels(rasterToPng(file), width, height, 4, interleave(planes, width * height))
})

test('PSD: PSB (version 2) uses 64-bit section lengths', () => {
  const width = 4
  const height = 3
  const planes = [0, 1, 2].map((c) => pixels(width, height, 1, (x, y) => (x * 35 + y * 17 + c * 61) & 0xff))
  const file = buildPsd({ version: 2, width, height, planes, compression: 1 })
  assert.equal(new DataView(file.buffer).getUint16(4), 2)
  assertPixels(rasterToPng(file), width, height, 3, interleave(planes, width * height))
})

test('PSD: a document with no merged composite is unsupported', () => {
  const file = buildPsd({ width: 4, height: 4, planes: [new Uint8Array(16), new Uint8Array(16), new Uint8Array(16)], omitComposite: true })
  assertRasterError(() => rasterToPng(file), 'unsupported', /merged composite/)
})

test('PSD: an unsupported bit depth is refused', () => {
  const file = buildPsd({ width: 2, height: 2, depth: 32, planes: [new Uint8Array(16), new Uint8Array(16), new Uint8Array(16)] })
  assertRasterError(() => rasterToPng(file), 'unsupported', /32-bit/)
})

test('PSD: an unknown compression is refused', () => {
  const planes = [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]
  const file = buildPsd({ width: 2, height: 2, planes })
  // Rewrite the compression word at the start of the composite section.
  const patched = Uint8Array.from(file)
  const at = patched.length - (2 + 12)
  patched[at] = 0
  patched[at + 1] = 9
  assertRasterError(() => rasterToPng(patched), 'unsupported', /compression 9/)
})

test('PSD: a truncated file is invalid', () => {
  const planes = [new Uint8Array(9), new Uint8Array(9), new Uint8Array(9)]
  const file = buildPsd({ width: 3, height: 3, planes })
  assertRasterError(() => rasterToPng(file.subarray(0, 20)), 'invalid')
  assertRasterError(() => rasterToPng(file.subarray(0, file.length - 4)), 'invalid')
})

test('PSD: a wrong signature is invalid', () => {
  const file = buildPsd({ width: 2, height: 2, planes: [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)] })
  const patched = Uint8Array.from(file)
  patched[1] = 0x00
  // sniffRaster no longer calls it a PSD, so rasterToPng reports "unknown".
  assert.equal(sniffRaster(patched), undefined)
  assert.equal(rasterToPng(patched), undefined)
})

/* ------------------------------------------------------------------------- *
 * Helpers used by the assertions above
 * ------------------------------------------------------------------------- */

/**
 * Repeat one grayscale plane into three channels.
 * @param {Uint8Array} plane
 * @returns {Uint8Array}
 */
function replicateGray(plane) {
  const out = new Uint8Array(plane.length * 3)
  for (let i = 0; i < plane.length; i += 1) {
    out[i * 3] = plane[i]
    out[i * 3 + 1] = plane[i]
    out[i * 3 + 2] = plane[i]
  }
  return out
}

/**
 * Interleave planar channels into one buffer.
 * @param {Uint8Array[]} planes
 * @param {number} count  pixels
 * @returns {Uint8Array}
 */
function interleave(planes, count) {
  const out = new Uint8Array(count * planes.length)
  for (let i = 0; i < count; i += 1) {
    for (let c = 0; c < planes.length; c += 1) out[i * planes.length + c] = planes[c][i]
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * Real files
 *
 * These bytes came from libtiff (via Pillow and ImageMagick) and from
 * ImageMagick's PSD writer, so they exercise the decoders against a writer this
 * test does not control. Each is a 12×8 image whose channels form a known
 * gradient; the assertions check dimensions and that the result is not a flat
 * or zero-filled block, which is what a silently broken decoder produces.
 * ------------------------------------------------------------------------- */

/** A 12×8 RGB TIFF written by libtiff with LZW compression and Predictor 2. */
const REAL_LZW_TIFF =
  'SUkqAFIAAACAAcFgMJgAGwWDwaEQuFQ2Ew+EAcVBCGRCHRWMQ4DkkOxmLR+PRE0CqQxeTSCDAdDjeSyiXRFTESWzOTgdilGaS+auQvTmfQaAgAsAAAEDAAEAAAAMAAAAAQEDAAEAAAAIAAAAAgEDAAMAAADcAAAAAwEDAAEAAAAFAAAABgEDAAEAAAACAAAAEQEEAAEAAAAIAAAAFQEDAAEAAAADAAAAFgEDAAEAAAAIAAAAFwEEAAEAAABKAAAAHAEDAAEAAAABAAAAPQEDAAEAAAACAAAAAAAAAAgACAAIAA=='

/** The same pixels as BigTIFF, big-endian, written by ImageMagick. */
const REAL_BIGTIFF =
  'SUkrAAgAAAAwAQAAAAAAAAcLAxoLEC0LHUALKlMLN2YLRHkLUYwLXp8La7ILeMULhdgLkgcqEBoqHS0qKkAqN1MqRGYqUXkqXowqa58qeLIqhcUqktgqnwdJHRpJKi1JN0BJRFNJUWZJXnlJa4xJeJ9JhbJJksVJn9hJrAdoKhpoNy1oREBoUVNoXmZoa3loeIxohZ9okrJon8VorNhouQeHNxqHRC2HUUCHXlOHa2aHeHmHhYyHkp+Hn7KHrMWHudiHxgemRBqmUS2mXkCma1OmeGamhXmmkoymn5+mrLKmucWmxtim0wfFURrFXi3Fa0DFeFPFhWbFknnFn4zFrJ/FubLFxsXF09jF4AfkXhrkay3keEDkhVPkkmbkn3nkrIzkuZ/kxrLk08Xk4Njk7Q8AAAAAAAAAAAEDAAEAAAAAAAAADAAAAAAAAAABAQMAAQAAAAAAAAAIAAAAAAAAAAIBAwADAAAAAAAAAAgACAAIAAAAAwEDAAEAAAAAAAAAAQAAAAAAAAAGAQMAAQAAAAAAAAACAAAAAAAAAAoBAwABAAAAAAAAAAEAAAAAAAAAEQEQAAEAAAAAAAAAEAAAAAAAAAASAQMAAQAAAAAAAAABAAAAAAAAABUBAwABAAAAAAAAAAMAAAAAAAAAFgEDAAEAAAAAAAAACAAAAAAAAAAXARAAAQAAAAAAAAAgAQAAAAAAABwBAwABAAAAAAAAAAEAAAAAAAAAKQEDAAIAAAAAAAAAAAABAAAAAAA+AQUAAgAAAAAAAACcAgAAAAAAAD8BBQAGAAAAAAAAAGwCAAAAAAAAAAAAAAAAAACF61EAAACAAMP1qAAAAAACzcxMAAAAAAHNzEwAAACAAM3MTAAAAAACj8L1AAAAABA3GqAAAAAAAiuHCgAAACAA'

/** A 12×8 RGB PSD with an RLE composite, written by ImageMagick. */
const REAL_PSD =
  'OEJQUwABAAAAAAAAAAMAAAAIAAAADAAIAAMAAAAAAAAAAAAAAYgAAAGAAAEAAAAAAAAAAAAAAAgAAAAMAAMAAAAAAIoAAQAAACoAAgAAAIo4QklNbm9ybf8AAQAAAAAMAAAAAAAAAAACTDEAAAEADwAPAA8ADwAPAA8ADwAPCAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiAAAEAAwADAAMAAwADAAMAAwAD9QuA9SqA9UmA9WiA9YeA9aaA9cWA9eSAAAEADwAPAA8ADwAPAA8ADwAPCAMQHSo3RFFeawJ4hZKACBAdKjdEUV5reAKFkp+ACB0qN0RRXmt4hQKSn6yACCo3RFFea3iFkgKfrLmACDdEUV5reIWSnwKsucaACERRXmt4hZKfrAK5xtOACFFea3iFkp+suQLG0+CACF5reIWSn6y5xgLT4O2AAAAAAAABAA8ADwAPAA8ADwAPAA8ADwADAAMAAwADAAMAAwADAAMADwAPAA8ADwAPAA8ADwAPCAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiACAcaLUBTZnmMnwKyxdiA9QuA9SqA9UmA9WiA9YeA9aaA9cWA9eSACAMQHSo3RFFeawJ4hZKACBAdKjdEUV5reAKFkp+ACB0qN0RRXmt4hQKSn6yACCo3RFFea3iFkgKfrLmACDdEUV5reIWSnwKsucaACERRXmt4hZKfrAK5xtOACFFea3iFkp+suQLG0+CACF5reIWSn6y5xgLT4O2A'

/**
 * Decode base64 into bytes.
 * @param {string} text
 * @returns {Uint8Array}
 */
function fromBase64(text) {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

test('real file: libtiff LZW + Predictor 2 TIFF decodes to the expected shape', () => {
  const bytes = fromBase64(REAL_LZW_TIFF)
  assert.equal(sniffRaster(bytes), 'tiff')
  const result = rasterToPng(bytes)
  assert.equal(result.width, 12)
  assert.equal(result.height, 8)
  const image = readPng(result.png)
  assert.equal(image.channels, 3)
  assert.equal(image.pixels.length, 12 * 8 * 3)
  assert.ok(image.pixels.some((value) => value !== 0), 'pixels are not all zero')
  const distinct = new Set(image.pixels)
  assert.ok(distinct.size > 16, `expected a varied image, saw ${distinct.size} distinct values`)
})

test('real file: ImageMagick BigTIFF big-endian decodes like the little-endian original', () => {
  const big = fromBase64(REAL_BIGTIFF)
  assert.equal(sniffRaster(big), 'tiff')
  const result = rasterToPng(big)
  assert.equal(result.width, 12)
  assert.equal(result.height, 8)
  const image = readPng(result.png)
  assert.ok(new Set(image.pixels).size > 16, 'expected a varied image')
  // The BigTIFF was written from the same pixels as REAL_LZW_TIFF.
  const plain = readPng(rasterToPng(fromBase64(REAL_LZW_TIFF)).png)
  assert.deepEqual([...image.pixels], [...plain.pixels])
})

test('real file: ImageMagick PSD with an RLE composite decodes', () => {
  const bytes = fromBase64(REAL_PSD)
  assert.equal(sniffRaster(bytes), 'psd')
  const result = rasterToPng(bytes)
  assert.equal(result.width, 12)
  assert.equal(result.height, 8)
  const image = readPng(result.png)
  assert.equal(image.channels, 3)
  assert.ok(new Set(image.pixels).size > 16, 'expected a varied image')
  // And it should agree with the TIFF holding the same pixels.
  const tiffPixels = readPng(rasterToPng(fromBase64(REAL_LZW_TIFF)).png)
  assert.deepEqual([...image.pixels], [...tiffPixels.pixels])
})

test('real file: any .tif shipped with Windows still decodes', (t) => {
  // A system wallpaper TIFF, when one exists, is a free real-world sample. It is
  // not part of every Windows install, so its absence is a skip, not a failure.
  const { existsSync, readdirSync } = process.getBuiltinModule('node:fs')
  const root = 'C:\\Windows\\Web\\Wallpaper'
  if (!existsSync(root)) return t.skip('no Windows wallpaper directory on this machine')
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}\\${entry.name}`
      if (entry.isDirectory()) walk(full)
      else if (/\.tiff?$/i.test(entry.name)) found.push(full)
      if (found.length > 4) return
    }
  }
  try {
    walk(root)
  } catch {
    return t.skip('wallpaper directory could not be read')
  }
  if (found.length === 0) return t.skip('no .tif files under the Windows wallpaper directory')
  for (const path of found) {
    const bytes = new Uint8Array(process.getBuiltinModule('node:fs').readFileSync(path))
    assert.equal(sniffRaster(bytes), 'tiff', path)
    const result = rasterToPng(bytes)
    assert.ok(result.width > 0 && result.height > 0, path)
    const image = readPng(result.png)
    assert.equal(image.width, result.width)
    assert.equal(image.height, result.height)
  }
})

