/**
 * Documents: OpenDocument, RTF and the StarOffice formats, rendered to HTML.
 *
 * The Sidebar shows the result in a `sandbox=""` iframe, so a document's own
 * markup can never run script in the GUI's origin. Rendering fails softly: a
 * broken file falls back to the binary info card rather than an error page.
 *
 * Rendering runs on a worker thread (`./tasks.js`), and a long document is cut
 * after about a million characters of HTML: the panel is a preview, and the
 * whole answer becomes one iframe document.
 */
import { readCapped } from '../../shared/fs.js'
import { runTask } from '../../shared/offload.js'

/** Cap for a document rendered on the Host. */
export const LIMIT = 96 * 1024 * 1024
/** How much HTML the panel receives; longer documents are cut after a block and flagged. */
const HTML_LIMIT = 1024 * 1024

/** `GET /preview/info` payload: the rendered HTML, or a fallback card. */
export async function describe({ ctx, target, size, path, signal }) {
  const bytes = await readCapped(ctx, target, size, LIMIT, signal, 'document')
  const rendered = await runTask('document', 'html', bytes, { path, maxHtmlChars: HTML_LIMIT }, signal)
  if (rendered.failure !== undefined) return { kind: 'binary', notice: rendered.failure.message }
  return {
    document: { title: rendered.title, html: rendered.html, ...(rendered.truncated ? { truncated: true } : {}) },
  }
}
