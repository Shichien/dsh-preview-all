/**
 * Which archive members preview in place, and under what content type.
 *
 * Kept apart from the parsers on purpose: the download route consults these
 * types for any file, and must not pull the ZIP/7z/decompression code into
 * memory just to answer with a MIME type.
 */
import { extensionOf } from '../../shared/path.js'

/** Content types for members previewed in place. */
const ENTRY_TYPES = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
  js: 'text/plain; charset=utf-8', ts: 'text/plain; charset=utf-8', css: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8', toml: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
})

export function entryTypeOf(name) {
  return ENTRY_TYPES[extensionOf(name)]
}

/** Files whose bytes are text even without a listed content type. */
const TEXTISH = new Set([
  'txt', 'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'xml',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'sh', 'bat', 'ps1', 'py', 'rb', 'go',
  'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sql', 'gradle', 'properties', 'gitignore', 'env',
  'license', 'readme', 'lua', 'kt', 'swift', 'pl', 'r', 'm', 'vue', 'svelte', 'lock',
])

export function isTextish(name) {
  return TEXTISH.has(extensionOf(name))
}
