/**
 * HTTP plumbing shared by every preview route.
 *
 * Nothing here knows about a file format: it is the transport layer the
 * per-format handlers in `lib/formats/<group>/` build on.
 */

/** A failure that maps to one HTTP status. Anything else becomes a 500. */
export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Headers on every response.
 *
 * `sandbox` CSP plus `nosniff` means a hostile archive member or document can
 * never execute in the GUI's origin; `no-store` keeps file bytes out of caches.
 */
export const BASE_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
  'referrer-policy': 'no-referrer',
})

/** Write one buffer, waiting for `drain` when the socket buffer is full. */
export function writeChunk(res, chunk) {
  if (res.write(chunk)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('connection closed'))
    }
    res.on('drain', onDrain)
    res.on('close', onClose)
  })
}

export function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

export function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

/** A whole body with a declared type, honouring `HEAD`. */
export function sendBytes(req, res, bytes, type, extra) {
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': type, 'content-length': String(bytes.byteLength), ...extra })
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** `attachment; filename*=UTF-8''…`, correct for non-ASCII names. */
export function attachment(name) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
}
