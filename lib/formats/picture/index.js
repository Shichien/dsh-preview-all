/**
 * Pictures: AVIF, HEIC, HEIF and JXL — containers the browser may decode itself.
 *
 * They are handed to `<img>` untouched, with the right content type. When the
 * browser cannot decode one, the panel falls back to the binary info card.
 */
import { basename } from 'node:path'
import { attachment, BASE_HEADERS, writeChunk } from '../../shared/http.js'
import { openFile, readHead } from '../../shared/fs.js'
import { suffixOf } from '../../kinds.js'
import { inspectBinary } from '../binary/inspect.js'

/** Content types for images handed to `<img>` untouched. */
const PICTURE_TYPES = Object.freeze({
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', hif: 'image/heif', jxl: 'image/jxl',
})

function pictureTypeOf(path) {
  return PICTURE_TYPES[suffixOf(path)]
}

/** `GET /preview/info` payload: the picture needs no parsing, only a card. */
export async function describe({ ctx, target, suffix, signal }) {
  const head = await readHeadSafe(ctx, target, signal)
  const info = inspectBinary(head, suffix)
  return { picture: true, raster: { format: info.summary, details: info.details } }
}

/** Only the summary matters here; a failed header read must not fail the panel. */
async function readHeadSafe(ctx, target, signal) {
  try {
    return await readHead(ctx, target, 256 * 1024, signal)
  } catch {
    return new Uint8Array(0)
  }
}

/** `GET /preview/picture`: the original container bytes. */
export async function serve({ ctx, req, res, url, sessionId, path, signal }) {
  const type = pictureTypeOf(path) ?? 'application/octet-stream'
  const { target, size, displayPath } = await openFile(ctx, sessionId, path, signal)
  const headers = { ...BASE_HEADERS, 'content-type': type, 'accept-ranges': 'bytes' }
  if (url.searchParams.get('download') === '1') headers['content-disposition'] = attachment(basename(displayPath))
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  for (let offset = 0; offset < size;) {
    if (signal.aborted) return
    const data = await ctx.fs.readByteRange(target, { offset, length: Math.min(1024 * 1024, size - offset) }, signal)
    if (data.byteLength === 0) break
    await writeChunk(res, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    offset += data.byteLength
  }
  res.end()
}

export function downloadTypeOf(path) {
  return pictureTypeOf(path)
}
