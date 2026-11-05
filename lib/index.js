/**
 * Host half of dsh-video-preview.
 *
 * Registers `GET|HEAD /video-preview/stream?sessionId=<id>&path=<path>`, which
 * serves one video file with HTTP Range support so the browser's <video>
 * element can seek without downloading the whole file.
 *
 * - Authentication: the same connection fence the GUI's own routes use
 *   (`ctx.connection.requestRejection`), i.e. the browser login cookie.
 * - Reads: through the composed filesystem service `ctx.fs`, so the
 *   deployment's sandbox read policy and remote backends apply exactly as they
 *   do for DSH's own document preview. Relative paths resolve against the
 *   session's working directory.
 * - Scope: only video extensions are served; any other file gets 415.
 * - Memory: bytes are copied in 1 MiB windows with backpressure, so a
 *   multi-GB file costs constant memory, and a seek (the browser abandons
 *   the old request) stops the read loop.
 */
import { basename, extname } from 'node:path'

export const name = 'dsh-video-preview'
export const inject = ['webServer', 'connection', 'fs', 'sessions', 'sandboxPolicy']

/** Route path; the client resolves it against the page base. */
export const ROUTE = '/video-preview/stream'

/** Bytes read from the filesystem per window. */
const WINDOW_BYTES = 1024 * 1024

/**
 * Content types by extension. `.mov` is announced as MP4 because Chromium
 * plays QuickTime files whose codecs it supports, but refuses `video/quicktime`.
 */
export const VIDEO_TYPES = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
})

/** @param {string} path @returns {string | undefined} */
export function videoTypeOf(path) {
  return VIDEO_TYPES[extname(path).toLowerCase()]
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

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Status codes for the filesystem service's typed errors. */
const FS_STATUSES = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_ABORTED: 499,
}

const BASE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
  'referrer-policy': 'no-referrer',
}

/** The base directory relative paths resolve against, mirroring the Sidebar's own rule. */
async function workspaceRootOf(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) {
    const cwd = ctx.get('workingDirectory')?.get?.(live) ?? live.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    return ctx.sandboxPolicy.workspaceRoot
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    let stored
    try {
      stored = await persistence.stat(sessionId)
    } catch {
      stored = undefined
    }
    if (stored?.header === undefined) throw new HttpError(404, 'unknown session')
    if (typeof stored.header.cwd === 'string' && stored.header.cwd !== '') return stored.header.cwd
  }
  return ctx.sandboxPolicy.workspaceRoot
}

/** Write one buffer, waiting for `drain` when the socket buffer is full. */
function writeChunk(res, chunk) {
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

function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

async function handle(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    sendError(res, rejection, 'unauthorized')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  if (url.pathname !== ROUTE) {
    sendError(res, 404, 'not found')
    return
  }
  const sessionId = url.searchParams.get('sessionId')
  const path = url.searchParams.get('path')
  if (sessionId === null || sessionId === '' || path === null || path === '' || path.includes('\0')) {
    sendError(res, 400, 'sessionId and path are required')
    return
  }
  if (videoTypeOf(path) === undefined) {
    sendError(res, 415, 'not a supported video file')
    return
  }

  const controller = new AbortController()
  res.on('close', () => controller.abort())
  const { signal } = controller

  try {
    const root = await workspaceRootOf(ctx, sessionId)
    const target = await ctx.fs.resolve(path, { cwd: root, signal })
    // Re-check after resolution so a link cannot point the route at a non-video file.
    const type = videoTypeOf(target.displayPath ?? path) ?? videoTypeOf(path)
    if (type === undefined) throw new HttpError(415, 'not a supported video file')
    const info = await ctx.fs.stat(target, signal)
    if (info === undefined) throw new HttpError(404, 'not found')
    if (info.type !== 'file') throw new HttpError(403, 'not a regular file')
    if (typeof info.size !== 'number') throw new HttpError(500, 'file size unavailable')
    const size = info.size

    const headers = { ...BASE_HEADERS, 'content-type': type, 'accept-ranges': 'bytes' }
    if (url.searchParams.get('download') === '1') {
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(target.displayPath ?? path))}`
    }

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

    let offset = start
    while (offset <= end) {
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
  } catch (error) {
    if (signal.aborted) {
      res.destroy()
      return
    }
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    const code = typeof error === 'object' && error !== null ? error.code : undefined
    const status = typeof code === 'string' ? FS_STATUSES[code] : undefined
    if (status !== undefined) {
      sendError(res, status, code)
      return
    }
    ctx.logger?.('video-preview')?.warn?.(error)
    sendError(res, 500, 'read failed')
  }
}

/** @param {any} ctx Host plugin context. */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => handle(ctx, req, res),
  }), 'dsh-video-preview: stream route')
}
