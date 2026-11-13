/**
 * Media: video and audio, played by a native `<video>` / `<audio>` element over
 * the byte-range route.
 *
 * Everything Chromium cannot decode still opens the player — the container is
 * announced by its own MIME type and the panel shows an explicit "unsupported"
 * notice with a download link rather than failing silently.
 */
import { basename } from 'node:path'
import { attachment, BASE_HEADERS, HttpError, writeChunk } from '../../shared/http.js'
import { openFile } from '../../shared/fs.js'
import { extensionOf, mediaKindOf, mediaTypeOf, parseRange } from './format.js'

/** Bytes read from the filesystem per window while streaming. */
const WINDOW_BYTES = 1024 * 1024

/**
 * Containers Chromium actually decodes. The player opens for every media file;
 * the ones missing here get an explicit "unsupported" notice instead of a
 * silent failure.
 */
const PLAYABLE = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'oga', 'ogg', 'opus', 'mp3', 'wav', 'flac', 'm4a', 'm4b', 'aac', 'weba', 'mka',
])

function isPlayable(path) {
  return PLAYABLE.has(extensionOf(path))
}

/** `GET /preview/info` payload for a media file. */
export function describe({ path }) {
  return { media: { kind: mediaKindOf(path), type: mediaTypeOf(path), playable: isPlayable(path) } }
}

/**
 * `GET /preview/stream`: the file itself, with Range support so the player can
 * seek without downloading everything first.
 */
export async function serve({ ctx, req, res, url, sessionId, path, signal }) {
  const type = mediaTypeOf(path)
  if (type === undefined) throw new HttpError(415, 'not a supported media file')
  const { target, size, displayPath } = await openFile(ctx, sessionId, path, signal)
  const headers = { ...BASE_HEADERS, 'content-type': type, 'accept-ranges': 'bytes' }
  if (url.searchParams.get('download') === '1') headers['content-disposition'] = attachment(basename(displayPath))

  const range = parseRange(req.headers.range, size)
  if (range.kind === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }
  const start = range.kind === 'partial' ? range.start : 0
  const end = range.kind === 'partial' ? range.end : size - 1
  const length = size === 0 ? 0 : end - start + 1
  if (range.kind === 'partial') headers['content-range'] = `bytes ${start}-${end}/${size}`
  headers['content-length'] = String(length)
  res.writeHead(range.kind === 'partial' ? 206 : 200, headers)
  if (req.method === 'HEAD' || length === 0) {
    res.end()
    return
  }

  for (let offset = start; offset <= end;) {
    if (signal.aborted) return
    const want = Math.min(WINDOW_BYTES, end - offset + 1)
    const data = await ctx.fs.readByteRange(target, { offset, length: want }, signal)
    if (data.byteLength === 0) {
      // The file shrank under us; the promised length can no longer be met.
      res.destroy()
      return
    }
    await writeChunk(res, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    offset += data.byteLength
  }
  res.end()
}
