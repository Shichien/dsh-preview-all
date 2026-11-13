/**
 * Fonts: a specimen sheet over a `@font-face` rule.
 *
 * The browser renders the specimen, so the Host only has to hand back the font
 * file with a content type the font loader accepts, plus the name table
 * metadata shown beside it.
 */
import { HttpError, sendBytes } from '../../shared/http.js'
import { openFile, readCapped } from '../../shared/fs.js'
import { suffixOf } from '../../kinds.js'
import { parseFontInfo, sniffFontFormat } from './parse.js'

export { parseFontInfo, sniffFontFormat } from './parse.js'

/** Cap for a font parsed on the Host. */
export const LIMIT = 64 * 1024 * 1024

/** Content types the `@font-face` loader accepts. */
const FONT_TYPES = Object.freeze({
  ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection', woff: 'font/woff', woff2: 'font/woff2',
  eot: 'application/vnd.ms-fontobject', pfb: 'application/x-font-type1',
})

export function fontTypeOf(path) {
  return FONT_TYPES[suffixOf(path)]
}

/** `GET /preview/info` payload: the name table, as far as it could be read. */
export async function describe({ ctx, target, size, path, signal }) {
  const bytes = await readCapped(ctx, target, size, LIMIT, signal, 'font')
  const format = sniffFontFormat(bytes) ?? suffixOf(path)
  const info = parseFontInfo(bytes) ?? {}
  return {
    font: {
      format,
      family: info.family,
      subfamily: info.subfamily,
      fullName: info.fullName,
      version: info.version,
      designer: info.designer,
      license: info.license,
      copyright: info.copyright,
      unitsPerEm: info.unitsPerEm,
      glyphCount: info.glyphCount,
      weight: info.weight,
      italic: info.italic,
      ascent: info.ascent,
      descent: info.descent,
      lineGap: info.lineGap,
      outline: info.outline,
      collection: info.collection,
    },
  }
}

/** `GET /preview/font`: the font file itself, for the `@font-face` rule. */
export async function serve({ ctx, req, res, sessionId, path, signal }) {
  const { target, size } = await openFile(ctx, sessionId, path, signal)
  const type = fontTypeOf(path) ?? 'application/octet-stream'
  const bytes = await readCapped(ctx, target, size, LIMIT, signal, 'font')
  sendBytes(req, res, bytes, type)
}

/** A font this plugin cannot parse still downloads under its own type. */
export function downloadTypeOf(path) {
  return fontTypeOf(path)
}

export { HttpError }
