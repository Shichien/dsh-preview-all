/**
 * Host half of dsh-preview-all-in-one.
 *
 * One prefix route serves every preview DSH's builtin document preview does not
 * handle. The Sidebar tab asks `/preview/info` what a file is, then pulls the
 * bytes it needs from the matching sub-route:
 *
 * - `/preview/stream`   video and audio, with HTTP Range support for seeking.
 * - `/preview/info`     JSON: classification, file info, archive listing, font
 *                       metadata, rendered document HTML.
 * - `/preview/entry`    one archive member, for in-place preview of text/images.
 * - `/preview/raster`   TIFF/PSD/camera raw decoded to PNG on this side.
 * - `/preview/font`     the font file itself, for the `@font-face` specimen.
 * - `/preview/picture`  an AVIF/HEIC/JXL container the browser may decode itself.
 * - `/preview/download` the original bytes as an attachment, since every panel
 *                       shows a rendering rather than the file the user opened.
 *
 * Layout: this file only wires the plugin into cordis. `server.js` is the route
 * dispatcher, `shared/` is transport and filesystem plumbing, `kinds.js` is the
 * single classification table, and `formats/<group>/` holds one module per
 * previewable group. Adding a suffix means touching `kinds.js`, the matching
 * `formats/<group>/`, and the client body — see README.
 *
 * Cross-cutting rules, matching the GUI's own routes:
 * - Authentication: `ctx.connection.requestRejection`, i.e. the login cookie.
 * - Reads: through `ctx.fs`, so the deployment's sandbox read policy and remote
 *   backends apply exactly as they do for DSH's own previews. Relative paths
 *   resolve against the session's working directory.
 * - Memory: media streams in 1 MiB windows with backpressure, so a multi-GB
 *   file costs constant memory and a seek stops the read loop. Parsers get the
 *   whole file but only under a hard size cap.
 */
import { ROUTE, handle } from './server.js'
import { stopWorker } from './shared/offload.js'

export const name = 'dsh-preview-all-in-one'
export const inject = ['webServer', 'connection', 'fs', 'sessions', 'sandboxPolicy']

export { ROUTE }
export { handle }

// Kept on the package's public surface: the route tests and any host-side
// consumer import these from the entry point.
export { MEDIA_EXTENSIONS, mediaKindOf, mediaTypeOf, extensionOf } from './formats/media/format.js'
export { parseRange } from './formats/media/format.js'
export { formatBytes, hexDump } from './shared/fs.js'
export { kindOf, suffixOf, isPreviewable, EXTENSIONS } from './kinds.js'
export { loadFormat, loadedKinds } from './formats/index.js'

/** @param {any} ctx Host plugin context. */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    // Last-resort guard: a throw that escapes handle() must not leave the request open.
    handler: (req, res) => handle(ctx, req, res).catch(() => res.destroy()),
  }), 'dsh-preview-all-in-one: preview routes')
  // The parser worker starts on first use; unloading the plugin must not leave it behind.
  ctx.effect(() => stopWorker, 'dsh-preview-all-in-one: parser worker')
}
