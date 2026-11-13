/**
 * Opening and reading a file through `ctx.fs`.
 *
 * Every read in this plugin goes through the DSH filesystem service rather than
 * `node:fs`, so the deployment's sandbox read policy and remote backends apply
 * exactly as they do for DSH's own previews.
 */
import { HttpError } from './http.js'

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
export const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/

/**
 * Resolve the `path` query parameter and stat it.
 *
 * A session-scoped address resolves relative paths against that session's
 * working directory; an absolute-scope address has no session at all, so the
 * path must already be absolute and the backend's own default cwd applies.
 */
export async function openFile(ctx, sessionId, path, signal) {
  const target = sessionId === undefined
    ? await ctx.fs.resolve(path, { signal })
    : await ctx.fs.resolve(path, { cwd: await workspaceRootOf(ctx, sessionId), signal })
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) throw new HttpError(404, 'not found')
  if (info.type !== 'file') throw new HttpError(403, 'not a regular file')
  return {
    target,
    size: typeof info.size === 'number' ? info.size : 0,
    // The service's opaque freshness token: it changes whenever the file does.
    version: info.version,
    displayPath: target.displayPath ?? path,
  }
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

/** Piece size when a whole file is read into one buffer. */
const READ_WINDOW = 4 * 1024 * 1024

/**
 * Read a whole file under a size cap into one buffer that nothing else shares.
 *
 * The buffer is filled through byte ranges rather than `ctx.fs.readBytes`: the
 * local backend's `readBytes` gathers stream chunks and then concatenates
 * them, holding the file twice for a moment. Here the cost is the file plus
 * one window, an aborted signal stops the read at the next window, and the
 * result can be handed to the parser worker without a copy.
 */
export async function readCapped(ctx, target, size, limit, signal, label) {
  if (size > limit) throw new HttpError(413, `${label} is ${formatBytes(size)}; the preview limit is ${formatBytes(limit)}`)
  const bytes = new Uint8Array(size)
  let filled = 0
  while (filled < size) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const piece = await ctx.fs.readByteRange(target, { offset: filled, length: Math.min(READ_WINDOW, size - filled) }, signal)
    // The file shrank after it was measured.
    if (piece.byteLength === 0) break
    bytes.set(new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength), filled)
    filled += piece.byteLength
  }
  return filled === size ? bytes : bytes.slice(0, filled)
}

/** Read at most `length` bytes from the start, whatever the file's size. */
export async function readHead(ctx, target, length, signal) {
  const bytes = await ctx.fs.readByteRange(target, { offset: 0, length }, signal)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Read `[offset, offset + length)`, looping over short reads. The result is
 * shorter than `length` only when the file ends first.
 */
export async function readRange(ctx, target, offset, length, signal) {
  if (length <= 0) return new Uint8Array(0)
  const first = await ctx.fs.readByteRange(target, { offset, length }, signal)
  if (first.byteLength >= length || first.byteLength === 0) {
    return new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
  }
  const out = new Uint8Array(length)
  out.set(new Uint8Array(first.buffer, first.byteOffset, first.byteLength))
  let filled = first.byteLength
  while (filled < length) {
    const next = await ctx.fs.readByteRange(target, { offset: offset + filled, length: length - filled }, signal)
    if (next.byteLength === 0) break
    out.set(new Uint8Array(next.buffer, next.byteOffset, next.byteLength), filled)
    filled += next.byteLength
  }
  return out.subarray(0, filled)
}

/** Format the leading bytes as hex + ASCII lines, the way a binary viewer shows them. */
export function hexDump(bytes, limit = 256) {
  const lines = []
  const count = Math.min(bytes.length, limit)
  for (let at = 0; at < count; at += 16) {
    const row = bytes.subarray(at, Math.min(at + 16, count))
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...row].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('')
    lines.push(`${at.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`)
  }
  return lines.join('\n')
}
