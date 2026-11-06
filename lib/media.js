/**
 * Media content types and HTTP range parsing.
 *
 * The Sidebar player points a native `<video>` or `<audio>` element at the
 * plugin's byte-range route, so the type announced by the route decides
 * whether the browser even tries to decode the file. Chromium sniffs the
 * container from the MIME type, which is why a QuickTime `.mov` is announced
 * as `video/mp4` (the container is close enough) while `video/quicktime` is
 * refused outright.
 */
import { extname } from 'node:path'

/** Video content types, including containers Chromium cannot decode but a download can. */
export const VIDEO_TYPES = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.f4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.m2v': 'video/mpeg',
  '.vob': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.asf': 'video/x-ms-asf',
  '.rm': 'application/vnd.rn-realmedia',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.divx': 'video/divx',
})

/** Audio content types. */
export const AUDIO_TYPES = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.ape': 'audio/x-ape',
  '.amr': 'audio/amr',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mka': 'audio/x-matroska',
  '.weba': 'audio/webm',
  '.ac3': 'audio/ac3',
  '.dts': 'audio/vnd.dts',
  '.wv': 'audio/x-wavpack',
})

export const MEDIA_TYPES = Object.freeze({ ...VIDEO_TYPES, ...AUDIO_TYPES })

/** Extensions handled by the media player, without the dot. */
export const MEDIA_EXTENSIONS = Object.freeze(Object.keys(MEDIA_TYPES).map((extension) => extension.slice(1)))

/** Lowercased extension of `path` without the dot, or `''` when there is none. */
export function extensionOf(path) {
  return extname(path).slice(1).toLowerCase()
}

/** @param {string} path @returns {string | undefined} */
export function mediaTypeOf(path) {
  return MEDIA_TYPES[extname(path).toLowerCase()]
}

/** @param {string} path @returns {'video' | 'audio' | undefined} */
export function mediaKindOf(path) {
  const type = mediaTypeOf(path)
  if (type === undefined) return undefined
  return type.startsWith('audio/') ? 'audio' : 'video'
}

/**
 * Interpret a `Range` header for a file of `size` bytes (RFC 9110 §14).
 * Only the first range of a multi-range request is honored, which the RFC
 * permits; media elements only ever send one.
 * @param {string | undefined} header
 * @param {number} size
 * @returns {{ kind: 'full' } | { kind: 'partial', start: number, end: number } | { kind: 'unsatisfiable' }}
 */
export function parseRange(header, size) {
  if (header === undefined || header === '') return { kind: 'full' }
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(header.trim())
  // Syntactically invalid ranges are ignored: the full representation is sent.
  if (match === null || (match[1] === '' && match[2] === '')) return { kind: 'full' }
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  if (match[2] !== '' && Number(match[2]) < start) return { kind: 'full' }
  if (start >= size) return { kind: 'unsatisfiable' }
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  return { kind: 'partial', start, end }
}
