/**
 * Document work that runs off the Host thread (see `lib/shared/offload.js`):
 * parsing a large `content.xml` or RTF takes seconds and a lot of heap.
 */
import { documentToHtml } from './render.js'

/** Render to HTML. Any rendering error is an expected failure: the file falls back to the binary card. */
export function html(bytes, { path, maxHtmlChars }) {
  try {
    const rendered = documentToHtml(bytes, path, { maxHtmlChars })
    return { title: rendered.title, html: rendered.html, truncated: rendered.truncated === true }
  } catch (error) {
    return { failure: { message: error?.message ?? 'could not render this document' } }
  }
}
