import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { parseFontInfo, sniffFontFormat } from '../lib/formats/font/parse.js'

/** Big-endian u16 into a plain array. */
function be16(value) {
  return [(value >> 8) & 0xff, value & 0xff]
}

/** Big-endian u32 into a plain array. */
function be32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/** @param {string} text @returns {Uint8Array} */
function utf16be(text) {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    out[i * 2] = code >> 8
    out[i * 2 + 1] = code & 0xff
  }
  return out
}

/** @param {string} text @returns {Uint8Array} */
function utf16le(text) {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    out[i * 2] = code & 0xff
    out[i * 2 + 1] = code >> 8
  }
  return out
}

/**
 * Build a `name` table from `{ nameID, text, platform }` records, laid out the
 * way real fonts do it: a 6-byte header, 12-byte records, then the strings.
 */
function buildNameTable(records) {
  const entries = records.map((record) => ({
    platform: record.platform ?? 3,
    nameID: record.nameID,
    bytes: record.platform === 1 ? latin1Bytes(record.text) : utf16be(record.text),
  }))
  const stringOffset = 6 + entries.length * 12
  const table = new Uint8Array(stringOffset + entries.reduce((sum, e) => sum + e.bytes.byteLength, 0))
  const view = new DataView(table.buffer)
  view.setUint16(0, 0)
  view.setUint16(2, entries.length)
  view.setUint16(4, stringOffset)
  let cursor = stringOffset
  entries.forEach((entry, index) => {
    const at = 6 + index * 12
    view.setUint16(at, entry.platform)
    view.setUint16(at + 2, entry.platform === 3 ? 1 : 0)
    view.setUint16(at + 4, entry.platform === 3 ? 0x0409 : 0)
    view.setUint16(at + 6, entry.nameID)
    view.setUint16(at + 8, entry.bytes.byteLength)
    view.setUint16(at + 10, cursor - stringOffset)
    table.set(entry.bytes, cursor)
    cursor += entry.bytes.byteLength
  })
  return table
}

/** @param {string} text @returns {Uint8Array} */
function latin1Bytes(text) {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** head + hhea + maxp + OS/2 + name + glyf, checksums deliberately zero. */
function buildTables(options = {}) {
  const head = new Uint8Array(54)
  const headView = new DataView(head.buffer)
  headView.setUint32(0, 0x00010000)
  headView.setUint32(12, 0x5f0f3cf5)
  headView.setUint16(18, options.unitsPerEm ?? 1000)

  const hhea = new Uint8Array(36)
  const hheaView = new DataView(hhea.buffer)
  hheaView.setUint32(0, 0x00010000)
  hheaView.setInt16(4, options.ascent ?? 800)
  hheaView.setInt16(6, options.descent ?? -200)
  hheaView.setInt16(8, options.lineGap ?? 90)
  hheaView.setUint16(34, 1)

  const maxp = new Uint8Array(6)
  const maxpView = new DataView(maxp.buffer)
  maxpView.setUint32(0, 0x00005000)
  maxpView.setUint16(4, options.numGlyphs ?? 4)

  const os2 = new Uint8Array(96)
  const os2View = new DataView(os2.buffer)
  os2View.setUint16(0, 4)
  os2View.setUint16(4, options.weight ?? 400)
  os2View.setUint16(62, options.italic === true ? 0x01 : 0x40)

  const name = buildNameTable(options.names ?? [
    { nameID: 0, text: 'Copyright 2026 Example Foundry' },
    { nameID: 1, text: 'Example Sans' },
    { nameID: 2, text: 'Bold Italic' },
    { nameID: 4, text: 'Example Sans Bold Italic' },
    { nameID: 5, text: 'Version 1.234' },
    { nameID: 9, text: 'A. Designer' },
    { nameID: 13, text: 'SIL Open Font License 1.1' },
  ])

  // One empty glyph plus padding; only its presence matters to the reader.
  const glyf = new Uint8Array(16)

  return [
    { tag: 'head', data: head },
    { tag: 'hhea', data: hhea },
    { tag: 'maxp', data: maxp },
    { tag: 'OS/2', data: os2 },
    { tag: 'name', data: name },
    { tag: 'glyf', data: glyf },
  ]
}

/**
 * Assemble an sfnt file. `base` is where the table directory sits, which is
 * how a TTC addresses its first face; table offsets stay absolute.
 */
function assembleSfnt(version, tables, base = 0) {
  const headerSize = 12 + tables.length * 16
  const placed = []
  let cursor = base + headerSize
  for (const table of tables) {
    const offset = (cursor + 3) & ~3
    placed.push({ tag: table.tag, data: table.data, offset })
    cursor = offset + table.data.byteLength
  }
  const bytes = new Uint8Array((cursor + 3) & ~3)
  const view = new DataView(bytes.buffer)
  view.setUint32(base, version)
  view.setUint16(base + 4, tables.length)
  placed.forEach((entry, index) => {
    const at = base + 12 + index * 16
    for (let c = 0; c < 4; c += 1) view.setUint8(at + c, entry.tag.charCodeAt(c))
    view.setUint32(at + 8, entry.offset)
    view.setUint32(at + 12, entry.data.byteLength)
    bytes.set(entry.data, entry.offset)
  })
  return bytes
}

function buildTtf(options = {}) {
  return assembleSfnt(0x00010000, buildTables(options))
}

/** A one-face collection: 16-byte TTC header, then a normal sfnt directory. */
function buildTtc(options = {}) {
  const face = assembleSfnt(0x00010000, buildTables(options), 16)
  const view = new DataView(face.buffer)
  view.setUint32(0, 0x74746366)
  view.setUint32(4, 0x00010000)
  view.setUint32(8, 1)
  view.setUint32(12, 16)
  return face
}

/** WOFF 1.0 with every table deflated where that actually shrinks it. */
function buildWoff(tables) {
  const headerBytes = 44
  const records = []
  let cursor = headerBytes + tables.length * 20
  for (const table of tables) {
    const deflated = deflateSync(Buffer.from(table.data), { level: 9 })
    const stored = deflated.byteLength < table.data.byteLength ? new Uint8Array(deflated) : table.data
    const offset = (cursor + 3) & ~3
    records.push({ tag: table.tag, data: stored, offset, origLength: table.data.byteLength })
    cursor = offset + stored.byteLength
  }
  const bytes = new Uint8Array((cursor + 3) & ~3)
  const view = new DataView(bytes.buffer)
  for (let c = 0; c < 4; c += 1) view.setUint8(c, 'wOFF'.charCodeAt(c))
  view.setUint32(4, 0x00010000)
  view.setUint32(8, bytes.byteLength)
  view.setUint16(12, records.length)
  view.setUint16(14, 0)
  view.setUint32(16, 12 + records.length * 16)
  records.forEach((record, index) => {
    const at = headerBytes + index * 20
    for (let c = 0; c < 4; c += 1) view.setUint8(at + c, record.tag.charCodeAt(c))
    view.setUint32(at + 4, record.offset)
    view.setUint32(at + 8, record.data.byteLength)
    view.setUint32(at + 12, record.origLength)
    view.setUint32(at + 16, 0)
    bytes.set(record.data, record.offset)
  })
  return bytes
}

/** Minimal EOT v1 header: fixed fields, family name, then the style name. */
function buildEot(options = {}) {
  const family = utf16le(options.family ?? 'Eot Family')
  const style = utf16le(options.subfamily ?? 'Regular')
  const familySizeAt = 82
  const familyAt = 84
  const styleSizeAt = familyAt + family.byteLength + 2
  const styleAt = styleSizeAt + 2
  const bytes = new Uint8Array(styleAt + style.byteLength + 2)
  const view = new DataView(bytes.buffer)
  // EOT is a little-endian Windows structure.
  view.setUint32(0, bytes.byteLength, true)
  view.setUint32(4, 0, true)
  view.setUint32(8, 0x00020001, true)
  view.setUint32(12, 0, true)
  view.setUint8(27, options.italic === true ? 1 : 0)
  view.setUint32(28, options.weight ?? 700, true)
  view.setUint16(32, 4, true)
  view.setUint16(34, 0x504c, true)
  view.setUint16(80, 0, true)
  view.setUint16(familySizeAt, family.byteLength, true)
  bytes.set(family, familyAt)
  view.setUint16(familyAt + family.byteLength, 0, true)
  view.setUint16(styleSizeAt, style.byteLength, true)
  bytes.set(style, styleAt)
  return bytes
}

test('sniffFontFormat identifies each container by magic', () => {
  const ttf = buildTtf()
  assert.equal(sniffFontFormat(ttf), 'ttf')
  assert.equal(sniffFontFormat(assembleSfnt(0x4f54544f, buildTables())), 'otf')
  assert.equal(sniffFontFormat(assembleSfnt(0x74727565, buildTables())), 'ttf')
  assert.equal(sniffFontFormat(buildTtc()), 'ttc')
  assert.equal(sniffFontFormat(buildWoff(buildTables())), 'woff')
  assert.equal(sniffFontFormat(buildEot()), 'eot')
  const woff2 = new Uint8Array(48)
  woff2.set(latin1Bytes('wOF2'))
  assert.equal(sniffFontFormat(woff2), 'woff2')
})

test('sniffFontFormat rejects short and unknown input', () => {
  assert.equal(sniffFontFormat(new Uint8Array(0)), undefined)
  assert.equal(sniffFontFormat(new Uint8Array([0x00, 0x01, 0x00])), undefined)
  assert.equal(sniffFontFormat(latin1Bytes('GIF89a and a lot of trailing noise')), undefined)
  assert.equal(sniffFontFormat(latin1Bytes('this is not a font at all, just prose')), undefined)
})

test('parseFontInfo reads the core sfnt tables', () => {
  const info = parseFontInfo(buildTtf({ unitsPerEm: 2048, numGlyphs: 12, weight: 700, italic: true }))
  assert.ok(info)
  assert.equal(info.format, 'ttf')
  assert.equal(info.family, 'Example Sans')
  assert.equal(info.subfamily, 'Bold Italic')
  assert.equal(info.fullName, 'Example Sans Bold Italic')
  assert.equal(info.version, 'Version 1.234')
  assert.equal(info.designer, 'A. Designer')
  assert.equal(info.license, 'SIL Open Font License 1.1')
  assert.equal(info.copyright, 'Copyright 2026 Example Foundry')
  assert.equal(info.unitsPerEm, 2048)
  assert.equal(info.glyphCount, 12)
  assert.equal(info.weight, 700)
  assert.equal(info.italic, true)
  assert.equal(info.ascent, 800)
  assert.equal(info.descent, -200)
  assert.equal(info.lineGap, 90)
  assert.equal(info.outline, 'truetype')
  assert.equal(info.collection, undefined)
})

test('parseFontInfo honors the OS/2 italic bit', () => {
  const upright = parseFontInfo(buildTtf({ italic: false, weight: 400 }))
  assert.equal(upright.italic, false)
  assert.equal(upright.weight, 400)
})

test('parseFontInfo prefers Windows names over Macintosh ones', () => {
  const names = [
    { platform: 1, nameID: 1, text: 'Mac Family' },
    { platform: 3, nameID: 1, text: 'Win Family' },
    { platform: 1, nameID: 2, text: 'Mac Style' },
    { platform: 3, nameID: 2, text: 'Win Style' },
  ]
  const info = parseFontInfo(buildTtf({ names }))
  assert.equal(info.family, 'Win Family')
  assert.equal(info.subfamily, 'Win Style')
})

test('parseFontInfo falls back to Macintosh latin-1 names', () => {
  const names = [{ platform: 1, nameID: 1, text: 'Mac Only Family' }]
  const info = parseFontInfo(buildTtf({ names }))
  assert.equal(info.family, 'Mac Only Family')
  assert.equal(info.subfamily, undefined)
})

test('parseFontInfo reports CFF outlines for an OTTO font', () => {
  const tables = buildTables().filter((table) => table.tag !== 'glyf')
  tables.push({ tag: 'CFF ', data: new Uint8Array(32) })
  const info = parseFontInfo(assembleSfnt(0x4f54544f, tables))
  assert.equal(info.format, 'otf')
  assert.equal(info.outline, 'cff')
})

test('parseFontInfo reads the first face of a collection', () => {
  const info = parseFontInfo(buildTtc({ unitsPerEm: 1000, numGlyphs: 7 }))
  assert.equal(info.format, 'ttc')
  assert.equal(info.collection, 1)
  assert.equal(info.family, 'Example Sans')
  assert.equal(info.unitsPerEm, 1000)
  assert.equal(info.glyphCount, 7)
})

test('parseFontInfo inflates WOFF tables', () => {
  const woff = buildWoff(buildTables({ unitsPerEm: 1000, numGlyphs: 5, weight: 500, italic: false }))
  assert.equal(sniffFontFormat(woff), 'woff')
  const info = parseFontInfo(woff)
  assert.ok(info)
  assert.equal(info.format, 'woff')
  assert.equal(info.family, 'Example Sans')
  assert.equal(info.version, 'Version 1.234')
  assert.equal(info.unitsPerEm, 1000)
  assert.equal(info.glyphCount, 5)
  assert.equal(info.weight, 500)
  assert.equal(info.italic, false)
})

test('parseFontInfo identifies WOFF 2.0 without decompressing it', () => {
  const woff2 = new Uint8Array(64)
  woff2.set(latin1Bytes('wOF2'))
  woff2.set(be32(0x00010000), 4)
  woff2.set(be16(9), 12)
  const info = parseFontInfo(woff2)
  assert.deepEqual(info, { format: 'woff2' })
})

test('parseFontInfo reads EOT header names', () => {
  const info = parseFontInfo(buildEot({ family: 'Embedded Family', subfamily: 'Semibold', weight: 600, italic: true }))
  assert.ok(info)
  assert.equal(info.format, 'eot')
  assert.equal(info.family, 'Embedded Family')
  assert.equal(info.subfamily, 'Semibold')
  assert.equal(info.weight, 600)
  assert.equal(info.italic, true)
})

test('parseFontInfo degrades gracefully on a bare EOT header', () => {
  const bytes = new Uint8Array(38)
  bytes.set([0x4c, 0x50], 34)
  const info = parseFontInfo(bytes)
  assert.ok(info)
  assert.equal(info.format, 'eot')
  assert.equal(info.family, undefined)
})

test('parseFontInfo returns undefined for truncated input instead of throwing', () => {
  const ttf = buildTtf()
  for (const size of [0, 1, 3, 4, 11, 12, 13, 20, 40, 60, ttf.byteLength - 1]) {
    assert.equal(parseFontInfo(ttf.subarray(0, size)), undefined, `truncated to ${size} bytes`)
  }
  // A directory that survives truncation but whose tables no longer fit.
  const halfTables = ttf.subarray(0, ttf.byteLength - 20)
  assert.equal(parseFontInfo(halfTables), undefined)
})

test('parseFontInfo never throws on garbage', () => {
  const garbage = [
    new Uint8Array(0),
    latin1Bytes('GIF89a'),
    new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x09]),
    new Uint8Array(1024).fill(0xab),
  ]
  for (const bytes of garbage) {
    assert.doesNotThrow(() => parseFontInfo(bytes))
    assert.equal(parseFontInfo(bytes), undefined)
  }
  assert.equal(parseFontInfo(undefined), undefined)
  assert.equal(parseFontInfo('not bytes'), undefined)
})

test('parseFontInfo drops unreadable metrics instead of emitting NaN', () => {
  const tables = buildTables().filter((table) => table.tag !== 'head' && table.tag !== 'hhea')
  const info = parseFontInfo(assembleSfnt(0x00010000, tables))
  assert.ok(info)
  assert.equal(info.family, 'Example Sans')
  assert.equal(info.unitsPerEm, undefined)
  assert.equal(info.ascent, undefined)
  assert.equal(info.descent, undefined)
  for (const value of Object.values(info)) {
    assert.ok(value !== undefined, 'no field should be present but undefined')
    if (typeof value === 'number') assert.ok(Number.isFinite(value), 'numbers must be finite')
  }
})

test('parseFontInfo reads the installed Arial when present', (t) => {
  const path = 'C:\\Windows\\Fonts\\arial.ttf'
  if (!existsSync(path)) {
    t.skip('no C:\\Windows\\Fonts\\arial.ttf on this machine')
    return
  }
  const info = parseFontInfo(new Uint8Array(readFileSync(path)))
  assert.ok(info)
  assert.equal(info.format, 'ttf')
  assert.equal(typeof info.family, 'string')
  assert.ok(info.family.length > 0)
  assert.ok(info.unitsPerEm > 0)
  assert.ok(info.glyphCount > 0)
})
