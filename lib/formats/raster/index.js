/**
 * Rasters: TIFF, PSD and camera raw, which no browser decodes.
 *
 * The pixels are decoded and re-encoded as a PNG, so the panel shows the image
 * itself rather than a hex dump. Only the header is read for the info payload;
 * the pixels are fetched lazily when the image element asks for them, and
 * decoded on a worker thread (`./tasks.js`): a large image takes seconds.
 */
import { HttpError, sendBytes } from '../../shared/http.js'
import { openFile, readCapped, readHead } from '../../shared/fs.js'
import { runTask } from '../../shared/offload.js'
import { suffixOf } from '../../kinds.js'
import { inspectBinary } from '../binary/inspect.js'

export { RasterError, rasterToPng, sniffRaster } from './decode.js'

/** Cap for a raster decoded on the Host. */
export const LIMIT = 96 * 1024 * 1024
/** Bytes read to describe a raster without decoding it. */
export const INFO_LIMIT = 256 * 1024

/** `GET /preview/info` payload: format and dimensions from the header only. */
export async function describe({ ctx, target, suffix, signal }) {
  const head = await readHead(ctx, target, INFO_LIMIT, signal)
  const info = inspectBinary(head, suffix)
  return { raster: { format: info.summary, details: info.details } }
}

/** `GET /preview/raster`: the decoded pixels as PNG. */
export async function serve({ ctx, req, res, sessionId, path, signal }) {
  const { target, size } = await openFile(ctx, sessionId, path, signal)
  const bytes = await readCapped(ctx, target, size, LIMIT, signal, 'image')
  const decoded = await runTask('raster', 'png', bytes, {}, signal)
  if (decoded.failure !== undefined) throw new HttpError(422, decoded.failure.message)
  if (decoded.unknown === true) throw new HttpError(415, 'not a raster image this server can decode')
  sendBytes(req, res, decoded.png, 'image/png', {
    'x-image-width': String(decoded.width),
    'x-image-height': String(decoded.height),
  })
}

export { suffixOf }
