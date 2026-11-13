/**
 * Binaries: everything else the user opened — executables, disk images,
 * databases, PostScript, and any archive or document whose bytes did not match
 * its suffix.
 *
 * The panel shows what the header sniffing found, a hex dump of the first
 * bytes, and a download link. It is the fallback every other format degrades to.
 */
import { hexDump, readHead } from '../../shared/fs.js'
import { inspectBinary } from './inspect.js'

/** Bytes read to describe a binary. */
export const INFO_LIMIT = 256 * 1024

/** `GET /preview/info` payload: sniffed format, details and the hex dump. */
export async function describe({ ctx, target, suffix, signal }) {
  const head = await readHead(ctx, target, INFO_LIMIT, signal)
  return { binary: inspectBinary(head, suffix), hex: hexDump(head) }
}
