/**
 * Raster work that runs off the Host thread (see `lib/shared/offload.js`):
 * decoding a TIFF or PSD and encoding the PNG takes seconds for a large image.
 */
import { RasterError, rasterToPng } from './decode.js'

/** Decode to PNG. `{ unknown: true }` when the bytes are not a raster this module reads. */
export function png(bytes) {
  let decoded
  try {
    decoded = rasterToPng(bytes)
  } catch (error) {
    if (error instanceof RasterError) return { failure: { code: error.code, message: error.message } }
    throw error
  }
  if (decoded === undefined) return { unknown: true }
  return { png: decoded.png, width: decoded.width, height: decoded.height }
}
