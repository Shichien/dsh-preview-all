/**
 * Archive work that runs off the Host thread (see `lib/shared/offload.js`).
 *
 * Only for archives that have to be read whole: TAR, the compressed streams,
 * 7z and RAR. Expanding a `.tar.bz2` or `.tar.xz` takes seconds in pure
 * JavaScript. ZIP containers never come here; they are read through byte
 * ranges on the Host.
 *
 * Expected failures are returned as `{ failure: { code, message } }`.
 */
import { ArchiveError, expandedSizeOf, listArchive, readArchiveEntry } from './zip.js'

/** A compressed archive is kept, with its expanded form, when the two fit in this. */
export const KEEP_LIMIT = 64 * 1024 * 1024
/** ...and dropped once nothing has asked for it for this long. */
const KEEP_MS = 60_000

/**
 * The last compressed archive opened: `{ key, bytes }`.
 *
 * Opening one member after listing would otherwise read the file and expand
 * the stream again, seconds each time for bzip2 or xz. Only small archives are
 * kept, only one, and only for a while; a plain TAR is cheap to read again and
 * is never kept.
 */
let kept
let keptTimer

function forget() {
  clearTimeout(keptTimer)
  kept = undefined
}

function keepAlive() {
  clearTimeout(keptTimer)
  keptTimer = setTimeout(forget, KEEP_MS)
  keptTimer.unref()
}

/** Keep `bytes` under `key` if it was expanded and is small enough; otherwise keep nothing. */
function remember(key, bytes) {
  if (kept?.bytes === bytes) {
    keepAlive()
    return
  }
  forget()
  const inner = expandedSizeOf(bytes)
  if (typeof key !== 'string' || inner === undefined || bytes.length + inner > KEEP_LIMIT) return
  kept = { key, bytes }
  keepAlive()
}

function failureOf(error) {
  if (error instanceof ArchiveError) return { code: error.code, message: error.message }
  throw error
}

/** Only what the listing panel shows crosses the thread boundary. */
function slim(entry) {
  return {
    name: entry.name,
    size: entry.size,
    packed: entry.packed,
    dir: entry.dir === true,
    encrypted: entry.encrypted === true,
    modified: entry.modified,
  }
}

/**
 * List an archive.
 * @param {Uint8Array} bytes the whole file
 * @param {{ path: string, key?: string, maxEntries: number, maxOutputBytes: number }} args
 *   `key` names this exact version of the file, for `entry` to find it again
 */
export function list(bytes, { path, key, maxEntries, maxOutputBytes }) {
  try {
    const listed = listArchive(bytes, path, { maxEntries, maxOutputBytes })
    remember(key, bytes)
    return { listed: { format: listed.format, note: listed.note, entries: listed.entries.map(slim) } }
  } catch (error) {
    return { failure: failureOf(error), stage: 'list' }
  }
}

/**
 * Find one member and extract it; the stream is expanded once for both steps.
 *
 * Called without bytes it answers from the kept archive, or `{ miss: true }`
 * when that is not the file `key` names; the caller then sends the bytes.
 * @param {Uint8Array | undefined} bytes
 * @param {{ path: string, key?: string, member: string, maxEntries: number, maxBytes: number, maxOutputBytes: number }} args
 */
export function entry(bytes, { path, key, member, maxEntries, maxBytes, maxOutputBytes }) {
  if (bytes === undefined) {
    if (kept === undefined || kept.key !== key) return { miss: true }
    bytes = kept.bytes
  }
  let listed
  try {
    listed = listArchive(bytes, path, { maxEntries, maxOutputBytes })
  } catch (error) {
    return { failure: failureOf(error), stage: 'list' }
  }
  remember(key, bytes)
  const found = listed.entries.find((candidate) => candidate.name === member)
  if (found === undefined) return { missing: true }
  try {
    const data = readArchiveEntry(bytes, path, found, { maxBytes, maxOutputBytes })
    // A member is usually a slice of the archive or of its expanded form. Send
    // a copy unless the member is a whole buffer nothing here still needs:
    // moving a buffer the kept archive rests on would empty it.
    const movable = kept?.bytes !== bytes && data.byteLength === data.buffer.byteLength
    return { data: movable ? data : data.slice() }
  } catch (error) {
    return { failure: failureOf(error), stage: 'read' }
  }
}
