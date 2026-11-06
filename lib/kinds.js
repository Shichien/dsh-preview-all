/**
 * Which preview a file gets.
 *
 * DSH's builtin document preview already renders markdown, HTML, images, PDF,
 * source code, spreadsheets and Office documents. Everything it leaves to the
 * "binary file, download" empty state lands here, and each group maps to one
 * renderer in the Sidebar:
 *
 * - `media`    — native `<video>` / `<audio>` over the byte-range route.
 * - `archive`  — entry listing, with in-place preview of text and image entries.
 * - `font`     — specimen sheet over a `@font-face` rule.
 * - `raster`   — decoded on the Host into a PNG (TIFF, PSD, camera raw).
 * - `picture`  — handed to `<img>` as-is (AVIF, HEIC); falls back to the info panel.
 * - `document` — OpenDocument / RTF, rendered to HTML on the Host.
 * - `binary`   — file info panel: format sniffing, hex dump, download.
 *
 * Macro-enabled and template Office files (`docm`, `xlsm`, `wps`, …) are ZIP
 * containers, so they get the archive listing rather than a broken layout.
 */
import { extensionOf } from './media.js'

/** Compound endings checked before the plain extension. */
const COMPOUND = Object.freeze(['tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst', 'tar.lz'])

const MEDIA = new Set([
  'mp4', 'm4v', 'mov', 'f4v', 'webm', 'ogv', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', 'm2v', 'vob',
  'ts', 'm2ts', 'mts', '3gp', '3g2', 'asf', 'rm', 'rmvb', 'divx',
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'm4b', 'aac', 'wma', 'aiff', 'aif', 'ape', 'amr',
  'mid', 'midi', 'mka', 'weba', 'ac3', 'dts', 'wv',
])

const ARCHIVE = new Set([
  'zip', 'jar', 'war', 'ear', 'apk', 'ipa', 'xpi', 'crx', 'vsix', 'whl', 'nupkg', 'epub', 'cbz',
  'sketch', 'xd', 'fig', 'kra', 'ora', 'blend1',
  'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'tbz', 'xz', 'txz', 'zst', '7z', 'rar', 'cbr', 'cab', 'lz', 'lzma', 'z',
  'docm', 'dotm', 'dotx', 'xlsm', 'xltm', 'xltx', 'pptm', 'potm', 'potx', 'ppsm', 'ppsx',
  'wps', 'et', 'dps', 'odc', 'otf2',
])

const FONT = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2', 'eot', 'pfb'])

const RASTER = new Set(['tif', 'tiff', 'psd', 'psb', 'dng', 'cr2', 'nef', 'arw', 'rw2', 'orf'])

const PICTURE = new Set(['avif', 'heic', 'heif', 'hif', 'jxl'])

const DOCUMENT = new Set(['odt', 'ods', 'odp', 'odg', 'fodt', 'fods', 'fodp', 'rtf', 'sxw', 'sxc', 'sxi'])

const BINARY = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'obj', 'a', 'lib', 'class', 'pyc', 'pyo', 'wasm',
  'dmg', 'iso', 'img', 'sqlite', 'sqlite3', 'db', 'msi', 'sys', 'pdb', 'com', 'scr', 'ocx', 'cpl',
  'efi', 'deb', 'rpm', 'dat', 'pak', 'icns', 'cur', 'crash', 'dmp', 'ai', 'eps', 'ps',
])

/** Every extension this plugin claims; the Sidebar tab glob is built from it. */
export const EXTENSIONS = Object.freeze([
  ...new Set([...MEDIA, ...ARCHIVE, ...FONT, ...RASTER, ...PICTURE, ...DOCUMENT, ...BINARY]),
].sort())

const GROUPS = [
  ['media', MEDIA],
  ['archive', ARCHIVE],
  ['font', FONT],
  ['raster', RASTER],
  ['picture', PICTURE],
  ['document', DOCUMENT],
  ['binary', BINARY],
]

/**
 * The filename suffix a path is classified by: compound endings such as
 * `tar.gz` win over the final extension.
 * @param {string} path
 * @returns {string}
 */
export function suffixOf(path) {
  const name = path.replaceAll('\\', '/').toLowerCase()
  const base = name.slice(name.lastIndexOf('/') + 1)
  for (const compound of COMPOUND) {
    if (base.endsWith(`.${compound}`)) return compound
  }
  return extensionOf(path)
}

/**
 * @param {string} path
 * @returns {'media' | 'archive' | 'font' | 'raster' | 'picture' | 'document' | 'binary' | undefined}
 */
export function kindOf(path) {
  const suffix = suffixOf(path)
  if (suffix === '') return undefined
  for (const [kind, set] of GROUPS) {
    if (set.has(suffix)) return kind
  }
  return undefined
}

/** Whether this plugin has a renderer for the path. */
export function isPreviewable(path) {
  return kindOf(path) !== undefined
}
