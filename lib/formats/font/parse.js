/**
 * Font metadata reader for the Sidebar's font preview.
 *
 * Turns the bytes of one font file into the handful of fields a preview panel
 * wants: family, style, version, designer, license, metrics and the outline
 * flavour. Supported containers are the sfnt family (`ttf`, CFF-flavoured
 * `otf`, and `ttc` collections, of which only the first face is described),
 * WOFF 1.0 and EOT. WOFF 2.0 is identified but not decoded: its table
 * directory is Brotli-compressed, and decompressing it would mean shipping a
 * Brotli decoder for no dependency budget.
 *
 * Fonts in the wild are truncated, hand-patched or plainly broken, so every
 * read here is bounds-checked and `parseFontInfo` answers `undefined` rather
 * than throwing. Fields that cannot be read are omitted from the result, never
 * set to `NaN`.
 */
import { inflateSync } from 'node:zlib'

/** name table IDs mapped to the info fields they fill. */
const NAME_FIELDS = {
  0: 'copyright',
  1: 'family',
  2: 'subfamily',
  4: 'fullName',
  5: 'version',
  9: 'designer',
  13: 'license',
}

/** Bytes in a WOFF 1.0 header, i.e. where its table directory starts. */
const WOFF_HEADER_BYTES = 44

/** Bytes in one WOFF table directory record. */
const WOFF_RECORD_BYTES = 20

/** Offset of the EOT family name length field, right after Padding1. */
const EOT_FAMILY_SIZE_AT = 82

/** Offset of the EOT family name itself. */
const EOT_FAMILY_AT = 84

/**
 * @param {Uint8Array} bytes
 * @returns {DataView}
 */
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** @param {DataView} view @param {number} at @returns {number | undefined} */
function u8(view, at) {
  return at >= 0 && at + 1 <= view.byteLength ? view.getUint8(at) : undefined
}

/** @param {DataView} view @param {number} at @returns {number | undefined} */
function u16(view, at) {
  return at >= 0 && at + 2 <= view.byteLength ? view.getUint16(at) : undefined
}

/** @param {DataView} view @param {number} at @returns {number | undefined} */
function u32(view, at) {
  return at >= 0 && at + 4 <= view.byteLength ? view.getUint32(at) : undefined
}

/** @param {DataView} view @param {number} at @returns {number | undefined} */
function i16(view, at) {
  return at >= 0 && at + 2 <= view.byteLength ? view.getInt16(at) : undefined
}

/** EOT is a Windows structure, so its fields are little-endian. */
function u16le(view, at) {
  return at >= 0 && at + 2 <= view.byteLength ? view.getUint16(at, true) : undefined
}

function u32le(view, at) {
  return at >= 0 && at + 4 <= view.byteLength ? view.getUint32(at, true) : undefined
}

/** @param {DataView} view @param {number} at @returns {string | undefined} */
function tagAt(view, at) {
  if (at < 0 || at + 4 > view.byteLength) return undefined
  let tag = ''
  for (let i = 0; i < 4; i += 1) tag += String.fromCharCode(view.getUint8(at + i))
  return tag
}

/** Store a field only when it was actually read. */
function put(info, key, value) {
  if (value !== undefined) info[key] = value
}

/** Round a raw read into a usable number, or drop it. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

/** Trim the NUL padding font vendors like to leave inside name strings. */
function cleanName(text) {
  return text.replace(/\u0000+$/, '').trim()
}

/**
 * Decode UTF-16BE by hand: no TextDecoder, because Node's UTF-16 support is
 * little-endian only and the byte swap would cost a copy per name.
 * @param {Uint8Array} bytes @param {number} start @param {number} length
 */
function decodeUtf16be(bytes, start, length) {
  let text = ''
  const end = start + (length - (length % 2))
  for (let at = start; at < end; at += 2) {
    text += String.fromCharCode((bytes[at] << 8) | bytes[at + 1])
  }
  return text
}

/** @param {Uint8Array} bytes @param {number} start @param {number} length */
function decodeUtf16le(bytes, start, length) {
  let text = ''
  const end = start + (length - (length % 2))
  for (let at = start; at < end; at += 2) {
    text += String.fromCharCode(bytes[at] | (bytes[at + 1] << 8))
  }
  return text
}

/** Macintosh Roman, close enough to latin-1 for the fields we keep. */
function decodeLatin1(bytes, start, length) {
  let text = ''
  for (let at = start; at < start + length; at += 1) text += String.fromCharCode(bytes[at])
  return text
}

/**
 * Read the name table, preferring Windows (platform 3) UTF-16BE records over
 * Macintosh (platform 1) ones, and English over anything else within a
 * platform. The first record of the winning score wins, so a font that repeats
 * a name across encodings stays deterministic.
 * @param {Uint8Array} table
 * @returns {Record<string, string>}
 */
function readNames(table) {
  const names = {}
  const view = viewOf(table)
  const count = u16(view, 2)
  const stringOffset = u16(view, 4)
  if (count === undefined || stringOffset === undefined) return names
  /** @type {Map<string, { score: number, text: string }>} */
  const best = new Map()
  for (let i = 0; i < count; i += 1) {
    const record = 6 + i * 12
    if (record + 12 > view.byteLength) break
    const platformID = view.getUint16(record)
    const encodingID = view.getUint16(record + 2)
    const languageID = view.getUint16(record + 4)
    const nameID = view.getUint16(record + 6)
    const length = view.getUint16(record + 8)
    const offset = view.getUint16(record + 10)
    const field = NAME_FIELDS[nameID]
    if (field === undefined) continue
    const start = stringOffset + offset
    if (start + length > table.byteLength) continue
    let text
    let score
    if (platformID === 3) {
      text = decodeUtf16be(table, start, length)
      score = 10 + (languageID === 0x0409 ? 1 : 0)
    } else if (platformID === 1 && encodingID === 0) {
      text = decodeLatin1(table, start, length)
      score = 5 + (languageID === 0 ? 1 : 0)
    } else {
      continue
    }
    text = cleanName(text)
    if (text === '') continue
    const previous = best.get(field)
    if (previous === undefined || score > previous.score) best.set(field, { score, text })
  }
  for (const [field, entry] of best) names[field] = entry.text
  return names
}

/**
 * Read an sfnt table directory at `base`. Table offsets are absolute file
 * offsets, which is also how a TTC addresses the tables of each face.
 * @param {DataView} view
 * @param {number} base
 * @returns {Map<string, { offset: number, length: number }> | undefined}
 */
function readTableDirectory(view, base) {
  if (base < 0 || base + 12 > view.byteLength) return undefined
  const numTables = u16(view, base + 4)
  if (numTables === undefined || numTables === 0) return undefined
  // A directory that does not fit, or that points past the end of the file,
  // means the file was truncated in transit; partial metrics from such a file
  // would be misleading, so the whole read is abandoned.
  if (base + 12 + numTables * 16 > view.byteLength) return undefined
  /** @type {Map<string, { offset: number, length: number }>} */
  const tables = new Map()
  for (let i = 0; i < numTables; i += 1) {
    const record = base + 12 + i * 16
    const tag = tagAt(view, record)
    const offset = u32(view, record + 8)
    const length = u32(view, record + 12)
    if (tag === undefined || offset === undefined || length === undefined) return undefined
    if (offset + length > view.byteLength) return undefined
    if (!tables.has(tag)) tables.set(tag, { offset, length })
  }
  return tables.size === 0 ? undefined : tables
}

/**
 * Build the table accessor shared by the sfnt, TTC and WOFF paths.
 * @param {Uint8Array} bytes
 * @param {Map<string, { offset: number, length: number }>} tables
 * @returns {(tag: string) => Uint8Array | undefined}
 */
function sfntReader(bytes, tables) {
  return (tag) => {
    const entry = tables.get(tag)
    if (entry === undefined) return undefined
    const end = entry.offset + entry.length
    if (entry.offset < 0 || end > bytes.byteLength || end < entry.offset) return undefined
    return bytes.subarray(entry.offset, end)
  }
}

/**
 * Read the fields we care about through a table accessor.
 * @param {(tag: string) => Uint8Array | undefined} read
 * @returns {Record<string, unknown>}
 */
function describeSfnt(read) {
  /** @type {Record<string, unknown>} */
  const info = {}

  const head = read('head')
  if (head !== undefined) {
    const unitsPerEm = num(u16(viewOf(head), 18))
    if (unitsPerEm !== undefined && unitsPerEm > 0) info.unitsPerEm = unitsPerEm
  }

  const hhea = read('hhea')
  if (hhea !== undefined) {
    const view = viewOf(hhea)
    put(info, 'ascent', num(i16(view, 4)))
    put(info, 'descent', num(i16(view, 6)))
    put(info, 'lineGap', num(i16(view, 8)))
  }

  const maxp = read('maxp')
  if (maxp !== undefined) put(info, 'glyphCount', num(u16(viewOf(maxp), 4)))

  const os2 = read('OS/2')
  if (os2 !== undefined) {
    const view = viewOf(os2)
    const weight = num(u16(view, 4))
    // Anything outside the 1..1000 range is a broken value, not a style.
    if (weight !== undefined && weight > 0 && weight <= 1000) info.weight = weight
    const fsSelection = u16(view, 62)
    if (fsSelection !== undefined) info.italic = (fsSelection & 1) === 1
  }

  const name = read('name')
  if (name !== undefined) Object.assign(info, readNames(name))

  // CFF outlines live in `CFF ` (OTF) or `CFF2` (variable OTF); everything
  // else we understand draws with `glyf`.
  if (read('CFF ') !== undefined || read('CFF2') !== undefined) info.outline = 'cff'
  else if (read('glyf') !== undefined) info.outline = 'truetype'

  return info
}

/**
 * Describe one sfnt face at `base`.
 * @param {Uint8Array} bytes @param {DataView} view @param {number} base
 * @param {'ttf' | 'otf' | 'ttc'} format
 */
function describeFace(bytes, view, base, format) {
  const tables = readTableDirectory(view, base)
  if (tables === undefined) return undefined
  const info = describeSfnt(sfntReader(bytes, tables))
  // Nothing readable at all means the file is truncated, not merely sparse.
  if (Object.keys(info).length === 0) return undefined
  return { format, ...info }
}

/** @param {Uint8Array} bytes @param {DataView} view */
function describeCollection(bytes, view) {
  const numFonts = u32(view, 8)
  const first = u32(view, 12)
  if (numFonts === undefined || numFonts === 0 || first === undefined) return undefined
  const face = describeFace(bytes, view, first, 'ttc')
  if (face === undefined) return undefined
  return { ...face, collection: numFonts }
}

/** @param {Uint8Array} bytes @param {DataView} view */
function describeWoff(bytes, view) {
  const numTables = u16(view, 12)
  if (numTables === undefined || numTables === 0) return undefined
  if (WOFF_HEADER_BYTES + numTables * WOFF_RECORD_BYTES > view.byteLength) return undefined
  /** @type {Map<string, Uint8Array>} */
  const tables = new Map()
  for (let i = 0; i < numTables; i += 1) {
    const record = WOFF_HEADER_BYTES + i * WOFF_RECORD_BYTES
    const tag = tagAt(view, record)
    const offset = u32(view, record + 4)
    const compLength = u32(view, record + 8)
    const origLength = u32(view, record + 12)
    if (tag === undefined || offset === undefined || compLength === undefined || origLength === undefined) return undefined
    if (offset + compLength > bytes.byteLength) return undefined
    const stored = bytes.subarray(offset, offset + compLength)
    if (compLength >= origLength) {
      tables.set(tag, stored)
      continue
    }
    let inflated
    try {
      inflated = inflateSync(stored)
    } catch {
      return undefined
    }
    if (inflated.byteLength < origLength) return undefined
    tables.set(tag, inflated.byteLength === origLength ? inflated : inflated.subarray(0, origLength))
  }
  if (tables.size === 0) return undefined
  const info = describeSfnt((tag) => tables.get(tag))
  if (Object.keys(info).length === 0) return undefined
  return { format: 'woff', ...info }
}

/** @param {Uint8Array} bytes @param {DataView} view */
function describeEot(bytes, view) {
  /** @type {Record<string, unknown>} */
  const info = {}
  // Name strings only exist from EOT version 1.0 on; older headers stop at
  // the fixed fields, and a bogus version means the offsets cannot be trusted.
  const version = u32le(view, 8)
  if (version === undefined || version < 0x00010000) return { format: 'eot' }
  const familySize = u16le(view, EOT_FAMILY_SIZE_AT)
  if (familySize !== undefined && familySize > 1 && familySize % 2 === 0 && EOT_FAMILY_AT + familySize <= bytes.byteLength) {
    const family = cleanName(decodeUtf16le(bytes, EOT_FAMILY_AT, familySize))
    if (family !== '') info.family = family
    // FamilyName, then Padding2 (u16), then StyleNameSize and StyleName.
    const styleSizeAt = EOT_FAMILY_AT + familySize + 2
    const styleSize = u16le(view, styleSizeAt)
    const styleAt = styleSizeAt + 2
    if (styleSize !== undefined && styleSize > 1 && styleSize % 2 === 0 && styleAt + styleSize <= bytes.byteLength) {
      const subfamily = cleanName(decodeUtf16le(bytes, styleAt, styleSize))
      if (subfamily !== '') info.subfamily = subfamily
    }
  }
  const weight = num(u32le(view, 28))
  if (weight !== undefined && weight > 0 && weight <= 1000) info.weight = weight
  const italic = u8(view, 27)
  if (italic === 0 || italic === 1) info.italic = italic === 1
  return { format: 'eot', ...info }
}

/**
 * Read font metadata out of a whole font file.
 *
 * Never throws: malformed, truncated or unsupported input yields `undefined`.
 * Any field may be missing when its table is absent or unreadable, so callers
 * must treat every property except `format` as optional.
 * @param {Uint8Array} bytes Whole font file (fonts are small enough to read fully).
 * @returns {{ format: string, family?: string, subfamily?: string, fullName?: string,
 *   version?: string, designer?: string, license?: string, copyright?: string,
 *   unitsPerEm?: number, glyphCount?: number, weight?: number, italic?: boolean,
 *   ascent?: number, descent?: number, lineGap?: number, outline?: string,
 *   collection?: number } | undefined}
 */
export function parseFontInfo(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return undefined
    const format = sniffFontFormat(bytes)
    if (format === undefined) return undefined
    const view = viewOf(bytes)
    switch (format) {
      case 'ttf':
      case 'otf':
        return describeFace(bytes, view, 0, format)
      case 'ttc':
        return describeCollection(bytes, view)
      case 'woff':
        return describeWoff(bytes, view)
      case 'woff2':
        // The table directory is Brotli-compressed; identifying the container
        // is all we promise for WOFF 2.0.
        return { format: 'woff2' }
      case 'eot':
        return describeEot(bytes, view)
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/**
 * Identify a font container by its magic bytes alone.
 * @param {Uint8Array} bytes
 * @returns {'ttf' | 'otf' | 'ttc' | 'woff' | 'woff2' | 'eot' | undefined}
 */
export function sniffFontFormat(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) return undefined
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'ttf'
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (tag === 'OTTO') return 'otf'
  if (tag === 'true') return 'ttf'
  if (tag === 'ttcf') return 'ttc'
  if (tag === 'wOFF') return 'woff'
  if (tag === 'wOF2') return 'woff2'
  // EOT has no leading magic: the first four bytes are EOTSize, little-endian,
  // and the "LP" marker sits at offset 34. A file that starts with the marker
  // itself is the other spelling seen in the wild, so accept that too.
  if (bytes.byteLength >= 38 && bytes[34] === 0x4c && bytes[35] === 0x50) return 'eot'
  if (bytes[0] === 0x4c && bytes[1] === 0x50 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'eot'
  return undefined
}
