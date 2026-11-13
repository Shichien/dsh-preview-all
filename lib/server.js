/**
 * The preview route table and dispatcher.
 *
 * One prefix route serves every panel. Each sub-route delegates to a format
 * module in `lib/formats/`, so this file stays a transport concern: authenticate,
 * validate, dispatch, map errors to statuses.
 */
import { basename } from 'node:path'
import { ABSOLUTE_PATH, formatBytes, openFile } from './shared/fs.js'
import { attachment, BASE_HEADERS, HttpError, sendError, sendJson, writeChunk } from './shared/http.js'
import { createGate } from './shared/gate.js'
import { loadFormat, loadRoute, ROUTE_NAMES } from './formats/index.js'
import { mediaTypeOf, parseRange } from './formats/media/format.js'
import { entryTypeOf } from './formats/archive/entry-types.js'
import { kindOf, suffixOf } from './kinds.js'

/** Route prefix; every sub-route below hangs off it. */
export const ROUTE = '/preview'

/** Bytes read from the filesystem per window while streaming. */
const WINDOW_BYTES = 1024 * 1024

/** Status codes for the filesystem service's typed errors. Aborts never reach this table. */
const FS_STATUSES = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_TOO_LARGE: 413,
}

/** Route names by sub-path. The table comes from the catalog; no handler is loaded to build it. */
export const ROUTES = Object.freeze(Object.fromEntries(
  ['info', 'download', ...ROUTE_NAMES].map((name) => [`${ROUTE}/${name}`, name]),
))

/**
 * One whole-file parse at a time. A restored session can ask for several
 * previews at once; without the gate each archive, font, raster or document
 * would hold its file in memory side by side.
 */
const wholeFileGate = createGate(1)

/** Run `task` under the gate when the format's manifest says it buffers the file. */
function guarded(format, signal, task) {
  return format.definition.buffersWholeFile === true ? wholeFileGate(signal, task) : task()
}

/**
 * `GET /preview/info`: what the file is, and whatever its format needs to
 * render. The classification comes from `kinds.js`; the payload from the
 * matching format module, which may degrade the kind (a `.zip` whose bytes are
 * not a ZIP becomes a binary card).
 */
async function describeFile(ctx, sessionId, path, signal) {
  const kind = kindOf(path)
  const { target, size, version, displayPath } = await openFile(ctx, sessionId, path, signal)
  const suffix = suffixOf(path)
  const base = {
    name: basename(displayPath),
    path,
    size,
    sizeLabel: formatBytes(size),
    suffix,
    kind: kind ?? 'binary',
  }
  const format = await loadFormat(kind ?? 'binary')
  const options = { ctx, target, size, version, path, signal, suffix, base }
  const payload = await guarded(format, signal, () => format.describe(options))
  if (payload.kind === 'binary' && kind !== 'binary') {
    const binary = await loadFormat('binary')
    return { ...base, ...await binary.describe(options), ...payload }
  }
  return { ...base, ...payload }
}

/**
 * `GET /preview/download`: the original bytes as an attachment.
 *
 * Every panel offers this, including the ones that render something else: the
 * document panel shows HTML, the raster panel shows a PNG, the archive panel
 * shows a listing — none of them gives back the file the user opened.
 */
async function serveDownload(ctx, req, res, sessionId, path, signal) {
  const { target, size, displayPath } = await openFile(ctx, sessionId, path, signal)
  // Only a claimed kind loads its module; any other file is typed from the light tables.
  const kind = kindOf(path)
  const format = kind === undefined ? undefined : await loadFormat(kind)
  const type = format?.typeOf?.(path)
    ?? mediaTypeOf(path)
    ?? entryTypeOf(path)
    ?? 'application/octet-stream'
  const headers = {
    ...BASE_HEADERS,
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-disposition': attachment(basename(displayPath)),
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
  for (let offset = start; offset <= end;) {
    if (signal.aborted) return
    const data = await ctx.fs.readByteRange(target, { offset, length: Math.min(WINDOW_BYTES, end - offset + 1) }, signal)
    if (data.byteLength === 0) {
      res.destroy()
      return
    }
    await writeChunk(res, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    offset += data.byteLength
  }
  res.end()
}

export async function handle(ctx, req, res) {
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
  const action = ROUTES[url.pathname]
  if (action === undefined) {
    sendError(res, 404, 'not found')
    return
  }
  const rawSession = url.searchParams.get('sessionId')
  const sessionId = rawSession === null || rawSession === '' ? undefined : rawSession
  const path = url.searchParams.get('path')
  if (path === null || path === '' || path.includes('\0')) {
    sendError(res, 400, 'path is required')
    return
  }
  // Without a session the path has to stand on its own; a relative one would
  // silently resolve against whatever cwd the backend happens to carry.
  if (sessionId === undefined && !ABSOLUTE_PATH.test(path)) {
    sendError(res, 400, 'sessionId is required for a relative path')
    return
  }

  const controller = new AbortController()
  res.on('close', () => controller.abort())
  const { signal } = controller

  try {
    if (action === 'info') {
      sendJson(res, await describeFile(ctx, sessionId, path, signal))
      return
    }
    if (action === 'download') {
      await serveDownload(ctx, req, res, sessionId, path, signal)
      return
    }
    const route = await loadRoute(action)
    if (route === undefined) {
      sendError(res, 404, 'not found')
      return
    }
    await guarded(route.format, signal, () => route.handler({ ctx, req, res, url, sessionId, path, signal }))
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
    ctx.logger?.warn?.(error)
    sendError(res, 500, 'preview failed')
  }
}
