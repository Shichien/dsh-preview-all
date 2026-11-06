/**
 * Host half of dsh-preview-all-in-one.
 *
 * One prefix route serves every preview DSH's builtin document preview does not
 * handle. The Sidebar tab asks `/preview/info` what a file is, then pulls the
 * bytes it needs from the matching sub-route:
 *
 * - `/preview/stream`  video and audio, with HTTP Range support for seeking.
 * - `/preview/info`    JSON: classification, file info, archive listing, font
 *                      metadata, rendered document HTML.
 * - `/preview/entry`   one archive member, for in-place preview of text/images.
 * - `/preview/raster`  TIFF/PSD/camera raw decoded to PNG on this side.
 * - `/preview/font`    the font file itself, for the `@font-face` specimen.
 * - `/preview/picture` an AVIF/HEIC/JXL container the browser may decode itself.
 * - `/preview/download` the original bytes as an attachment, since every panel
 *                      shows a rendering rather than the file the user opened.
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
import { basename } from 'node:path'
import { MEDIA_EXTENSIONS, extensionOf, mediaKindOf, mediaTypeOf, parseRange } from './media.js'
import { kindOf, suffixOf } from './kinds.js'
import { ArchiveError, listArchive, readArchiveEntry } from './archive.js'
import { RasterError, rasterToPng } from './raster.js'
import { parseFontInfo, sniffFontFormat } from './font.js'
import { documentToHtml } from './document.js'
import { inspectBinary } from './binary.js'

export const name = 'dsh-preview-all-in-one'
export const inject = ['webServer', 'connection', 'fs', 'sessions', 'sandboxPolicy']

/** Route prefix; every sub-route below hangs off it. */
export const ROUTE = '/preview'

/** Bytes read from the filesystem per window while streaming media. */
const WINDOW_BYTES = 1024 * 1024

/** Size caps for the parsers. Beyond these the panel shows file info only. */
const LIMITS = Object.freeze({
  archive: 192 * 1024 * 1024,
  entry: 16 * 1024 * 1024,
  raster: 96 * 1024 * 1024,
  font: 64 * 1024 * 1024,
  document: 96 * 1024 * 1024,
  info: 256 * 1024,
})

/** Content types for archive members previewed in place. */
const ENTRY_TYPES = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
  js: 'text/plain; charset=utf-8', ts: 'text/plain; charset=utf-8', css: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8', toml: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
})

/** Content types for the font binary handed to `@font-face`. */
const FONT_TYPES = Object.freeze({
  ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection', woff: 'font/woff', woff2: 'font/woff2',
  eot: 'application/vnd.ms-fontobject', pfb: 'application/x-font-type1',
})

/** Content types for images handed to `<img>` untouched. */
const PICTURE_TYPES = Object.freeze({
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', hif: 'image/heif', jxl: 'image/jxl',
})

export { MEDIA_EXTENSIONS, mediaTypeOf, parseRange }

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Status codes for the filesystem service's typed errors. Aborts never reach this table. */
const FS_STATUSES = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_TOO_LARGE: 413,
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

/** Absolute paths need no session: they are resolved as written. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/

/**
 * Resolve the `path` query parameter and stat it.
 *
 * A session-scoped address resolves relative paths against that session's
 * working directory; an absolute-scope address has no session at all, so the
 * path must already be absolute and the backend's own default cwd applies.
 */
async function openFile(ctx, sessionId, path, signal) {
  const target = sessionId === undefined
    ? await ctx.fs.resolve(path, { signal })
    : await ctx.fs.resolve(path, { cwd: await workspaceRootOf(ctx, sessionId), signal })
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) throw new HttpError(404, 'not found')
  if (info.type !== 'file') throw new HttpError(403, 'not a regular file')
  return { target, size: typeof info.size === 'number' ? info.size : 0, displayPath: target.displayPath ?? path }
}

/** Read a whole file under a cap, turning the service's size error into a friendly one. */
async function readCapped(ctx, target, size, limit, signal, label) {
  if (size > limit) throw new HttpError(413, `${label} is ${formatBytes(size)}; the preview limit is ${formatBytes(limit)}`)
  const bytes = await ctx.fs.readBytes(target, signal, limit)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Read at most `length` bytes from the start; unlike `readBytes` this never rejects a large file. */
async function readHead(ctx, target, length, signal) {
  const bytes = await ctx.fs.readByteRange(target, { offset: 0, length }, signal)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Format the leading bytes as hex + ASCII lines, the way a binary viewer shows them. */
export function hexDump(bytes, limit = 256) {
  const lines = []
  const count = Math.min(bytes.length, limit)
  for (let at = 0; at < count; at += 16) {
    const row = bytes.subarray(at, Math.min(at + 16, count))
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...row].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('')
    lines.push(`${at.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`)
  }
  return lines.join('\n')
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

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

/** Human-readable byte count. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

// ---- media ----------------------------------------------------------------

async function serveMedia(ctx, req, res, url, sessionId, path, signal) {
  const type = mediaTypeOf(path)
  if (type === undefined) throw new HttpError(415, 'not a supported media file')
  const { target, size, displayPath } = await openFile(ctx, sessionId, path, signal)
  const headers = { ...BASE_HEADERS, 'content-type': type, 'accept-ranges': 'bytes' }
  if (url.searchParams.get('download') === '1') {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(displayPath))}`
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
}

// ---- info -----------------------------------------------------------------

/** Font specimen payload. */
function fontPayload(bytes, name) {
  const format = sniffFontFormat(bytes) ?? suffixOf(name)
  const info = parseFontInfo(bytes) ?? {}
  return {
    format,
    family: info.family,
    subfamily: info.subfamily,
    fullName: info.fullName,
    version: info.version,
    designer: info.designer,
    license: info.license,
    copyright: info.copyright,
    unitsPerEm: info.unitsPerEm,
    glyphCount: info.glyphCount,
    weight: info.weight,
    italic: info.italic,
    ascent: info.ascent,
    descent: info.descent,
    lineGap: info.lineGap,
    outline: info.outline,
    collection: info.collection,
  }
}

/** Build the JSON description of one file. */
async function describe(ctx, url, sessionId, path, signal) {
  const kind = kindOf(path)
  const { target, size, displayPath } = await openFile(ctx, sessionId, path, signal)
  const suffix = suffixOf(path)
  const base = {
    name: basename(displayPath),
    path,
    size,
    sizeLabel: formatBytes(size),
    suffix,
    kind: kind ?? 'binary',
  }

  if (kind === 'media') {
    return {
      ...base,
      media: { kind: mediaKindOf(path), type: mediaTypeOf(path), playable: isPlayable(path) },
    }
  }

  if (kind === 'archive') {
    const bytes = await readCapped(ctx, target, size, LIMITS.archive, signal, 'archive')
    try {
      const listed = listArchive(bytes, path, { maxEntries: 5000 })
      return {
        ...base,
        archive: {
          format: listed.format,
          note: listed.note,
          entries: listed.entries.map((entry) => ({
            name: entry.name,
            size: entry.size,
            packed: entry.packed,
            dir: entry.dir === true,
            encrypted: entry.encrypted === true,
            modified: entry.modified,
            previewable: !entry.dir && (ENTRY_TYPES[extensionOf(entry.name)] !== undefined || isTextish(entry.name)),
            image: !entry.dir && ENTRY_TYPES[extensionOf(entry.name)]?.startsWith('image/') === true,
          })),
        },
      }
    } catch (error) {
      if (error instanceof ArchiveError) {
        return { ...base, kind: 'binary', notice: error.message, binary: inspectBinary(bytes.subarray(0, LIMITS.info), suffix) }
      }
      throw error
    }
  }

  if (kind === 'font') {
    const bytes = await readCapped(ctx, target, size, LIMITS.font, signal, 'font')
    return { ...base, font: fontPayload(bytes, path) }
  }

  if (kind === 'raster') {
    // Only the header is needed to describe it; the pixels are fetched lazily.
    const head = await readHead(ctx, target, LIMITS.info, signal)
    const info = inspectBinary(head, suffix)
    return { ...base, raster: { format: info.summary, details: info.details } }
  }

  if (kind === 'picture') {
    return { ...base, picture: true }
  }

  if (kind === 'document') {
    const bytes = await readCapped(ctx, target, size, LIMITS.document, signal, 'document')
    try {
      const rendered = documentToHtml(bytes, path)
      return { ...base, document: { title: rendered.title, html: rendered.html } }
    } catch (error) {
      return { ...base, kind: 'binary', notice: error?.message ?? 'could not render this document', binary: inspectBinary(bytes.subarray(0, LIMITS.info), suffix) }
    }
  }

  // Opaque binaries: sniff the header and show what we found, plus a hex dump.
  const head = await readHead(ctx, target, LIMITS.info, signal)
  return {
    ...base,
    binary: inspectBinary(head, suffix),
    hex: hexDump(head),
  }
}

/**
 * Whether Chromium can actually decode the container. The player opens for
 * every media file; the ones listed here get an explicit "unsupported" notice
 * instead of a silent failure.
 */
function isPlayable(path) {
  return ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'oga', 'ogg', 'opus', 'mp3', 'wav', 'flac', 'm4a', 'm4b', 'aac', 'weba', 'mka'].includes(extensionOf(path))
}

/** Files whose bytes are text even without a listed content type. */
function isTextish(name) {
  const suffix = extensionOf(name)
  return ['txt', 'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'xml',
    'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'sh', 'bat', 'ps1', 'py', 'rb', 'go',
    'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sql', 'gradle', 'properties', 'gitignore', 'env',
    'license', 'readme', 'lua', 'kt', 'swift', 'pl', 'r', 'm', 'vue', 'svelte', 'lock'].includes(suffix)
}

// ---- binary sub-routes ----------------------------------------------------

async function serveRaster(ctx, req, res, sessionId, path, signal) {
  const { target, size } = await openFile(ctx, sessionId, path, signal)
  const bytes = await readCapped(ctx, target, size, LIMITS.raster, signal, 'image')
  let decoded
  try {
    decoded = rasterToPng(bytes)
  } catch (error) {
    if (error instanceof RasterError) throw new HttpError(422, error.message)
    throw error
  }
  if (decoded === undefined) throw new HttpError(415, 'not a raster image this server can decode')
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': 'image/png',
    'content-length': String(decoded.png.byteLength),
    'x-image-width': String(decoded.width),
    'x-image-height': String(decoded.height),
  })
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(decoded.png.buffer, decoded.png.byteOffset, decoded.png.byteLength))
}

async function serveFont(ctx, req, res, sessionId, path, signal) {
  const { target, size } = await openFile(ctx, sessionId, path, signal)
  const type = FONT_TYPES[suffixOf(path)] ?? 'application/octet-stream'
  const bytes = await readCapped(ctx, target, size, LIMITS.font, signal, 'font')
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': type, 'content-length': String(bytes.byteLength) })
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** Serve a picture container the browser may decode itself (AVIF, HEIC). */
async function servePicture(ctx, req, res, url, sessionId, path, signal) {
  const type = PICTURE_TYPES[suffixOf(path)] ?? 'application/octet-stream'
  const { target, size, displayPath } = await openFile(ctx, sessionId, path, signal)
  const headers = { ...BASE_HEADERS, 'content-type': type, 'accept-ranges': 'bytes' }
  if (url.searchParams.get('download') === '1') {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(displayPath))}`
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  for (let offset = 0; offset < size;) {
    if (signal.aborted) return
    const data = await ctx.fs.readByteRange(target, { offset, length: Math.min(WINDOW_BYTES, size - offset) }, signal)
    if (data.byteLength === 0) break
    await writeChunk(res, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    offset += data.byteLength
  }
  res.end()
}

/**
 * Serve the original bytes as an attachment.
 *
 * Every panel offers this, including the ones that render something else: the
 * document panel shows HTML, the raster panel shows a PNG, the archive panel
 * shows a listing — none of them gives back the file the user opened.
 */
async function serveDownload(ctx, req, res, sessionId, path, signal) {
  const { target, size, displayPath } = await openFile(ctx, sessionId, path, signal)
  const suffix = suffixOf(path)
  const type = mediaTypeOf(path) ?? FONT_TYPES[suffix] ?? PICTURE_TYPES[suffix] ?? ENTRY_TYPES[suffix] ?? 'application/octet-stream'
  const headers = {
    ...BASE_HEADERS,
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(displayPath))}`,
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

async function serveEntry(ctx, req, res, url, sessionId, path, signal) {
  const member = url.searchParams.get('entry')
  if (member === null || member === '') throw new HttpError(400, 'entry is required')
  const { target, size } = await openFile(ctx, sessionId, path, signal)
  const bytes = await readCapped(ctx, target, size, LIMITS.archive, signal, 'archive')
  let listed
  try {
    listed = listArchive(bytes, path, { maxEntries: 200000 })
  } catch (error) {
    if (error instanceof ArchiveError) throw new HttpError(415, error.message)
    throw error
  }
  const entry = listed.entries.find((candidate) => candidate.name === member)
  if (entry === undefined) throw new HttpError(404, 'no such entry')
  let data
  try {
    data = readArchiveEntry(bytes, path, entry, { maxBytes: LIMITS.entry })
  } catch (error) {
    if (error instanceof ArchiveError) throw new HttpError(error.code === 'too-large' ? 413 : 415, error.message)
    throw error
  }
  const type = ENTRY_TYPES[extensionOf(member)] ?? 'application/octet-stream'
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': type, 'content-length': String(data.byteLength) })
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(data.buffer, data.byteOffset, data.byteLength))
}

// ---- dispatch -------------------------------------------------------------

/** Route handlers by sub-path. */
const ROUTES = {
  '/preview/stream': 'stream',
  '/preview/info': 'info',
  '/preview/entry': 'entry',
  '/preview/raster': 'raster',
  '/preview/font': 'font',
  '/preview/picture': 'picture',
  '/preview/download': 'download',
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
    switch (action) {
      case 'stream':
        await serveMedia(ctx, req, res, url, sessionId, path, signal)
        return
      case 'info': {
        const described = await describe(ctx, url, sessionId, path, signal)
        sendJson(res, described)
        return
      }
      case 'entry':
        await serveEntry(ctx, req, res, url, sessionId, path, signal)
        return
      case 'raster':
        await serveRaster(ctx, req, res, sessionId, path, signal)
        return
      case 'font':
        await serveFont(ctx, req, res, sessionId, path, signal)
        return
      case 'picture':
        await servePicture(ctx, req, res, url, sessionId, path, signal)
        return
      case 'download':
        await serveDownload(ctx, req, res, sessionId, path, signal)
        return
      default:
        sendError(res, 404, 'not found')
    }
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

/** @param {any} ctx Host plugin context. */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    // Last-resort guard: a throw that escapes handle() must not leave the request open.
    handler: (req, res) => handle(ctx, req, res).catch(() => res.destroy()),
  }), 'dsh-preview-all-in-one: preview routes')
}
