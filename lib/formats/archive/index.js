/**
 * Archives: a member listing, with in-place preview of text and image entries.
 *
 * ZIP containers — which is most of what this group claims — are read through
 * byte ranges: the central directory for a listing, one member's packed bytes
 * for a preview. Their size is irrelevant and nothing but the requested piece
 * is ever in memory.
 *
 * TAR, the compressed streams, 7z and RAR have no such index, so they are read
 * whole, capped at 192 MiB, and parsed on a worker thread (`./tasks.js`): a
 * `.tar.bz2` can take seconds to expand. A compressed stream may expand to at
 * most the same 192 MiB, and an extracted member is capped at 16 MiB. The
 * worker keeps the last small compressed archive for a minute, so opening its
 * members does not read and expand it again each time.
 */
import { HttpError, sendBytes } from '../../shared/http.js'
import { openFile, readCapped, readRange } from '../../shared/fs.js'
import { runTask } from '../../shared/offload.js'
import { entryTypeOf, isTextish } from './entry-types.js'
import { ArchiveError, isZipByRanges, listZipRanged, readZipEntryRanged } from './zip.js'

/** Size cap for an archive that has to be read whole; larger requests are rejected. */
export const LIMIT = 192 * 1024 * 1024
/** Cap for the expanded form of a compressed stream: what a plain TAR may be. */
const OUTPUT_LIMIT = LIMIT
/** Cap for one member served to the in-place preview. */
const ENTRY_LIMIT = 16 * 1024 * 1024

/** Bytes sniffed to tell the container apart; a TAR header is one 512-byte block. */
const HEAD_BYTES = 512
/** What the listing panel receives. */
const LISTING = Object.freeze({ maxEntries: 5000, maxDirectoryBytes: 8 * 1024 * 1024 })
/** What a member lookup may scan to find an entry the listing truncated. */
const LOOKUP = Object.freeze({ maxEntries: 200000, maxDirectoryBytes: 64 * 1024 * 1024 })

/**
 * A name for this exact version of a file, so the worker can tell whether the
 * archive it kept is still the one on disk. `undefined` when the filesystem
 * service gives no version: then nothing is reused.
 */
function keyOf(target, version) {
  const known = typeof version === 'string' || typeof version === 'number'
  return known && typeof target?.targetKey === 'string' ? `${target.targetKey}\n${version}` : undefined
}

/** A byte-range reader over one opened file, and whether that file is a ZIP it can serve. */
async function probe(ctx, target, size, path, signal) {
  const read = (offset, length) => readRange(ctx, target, offset, length, signal)
  const head = await read(0, Math.min(size, HEAD_BYTES))
  return { read, ranged: isZipByRanges(head, path) }
}

/**
 * `GET /preview/info` payload: the member listing.
 *
 * A file that fails to parse falls back to the binary panel instead of an
 * error, because the suffix promised an archive the bytes do not deliver.
 */
export async function describe({ ctx, target, size, version, path, signal }) {
  const { read, ranged } = await probe(ctx, target, size, path, signal)
  let listed
  if (ranged) {
    try {
      listed = await listZipRanged(read, size, LISTING)
    } catch (error) {
      if (error instanceof ArchiveError) return { kind: 'binary', notice: error.message }
      throw error
    }
  } else {
    const bytes = await readCapped(ctx, target, size, LIMIT, signal, 'archive')
    const result = await runTask('archive', 'list', bytes, {
      path, key: keyOf(target, version), maxEntries: LISTING.maxEntries, maxOutputBytes: OUTPUT_LIMIT,
    }, signal)
    if (result.failure !== undefined) return { kind: 'binary', notice: result.failure.message }
    listed = result.listed
  }
  return {
    archive: {
      format: listed.format,
      note: listed.note,
      entries: listed.entries.map((entry) => {
        const type = entry.dir ? undefined : entryTypeOf(entry.name)
        return {
          name: entry.name,
          size: entry.size,
          packed: entry.packed,
          dir: entry.dir === true,
          encrypted: entry.encrypted === true,
          modified: entry.modified,
          previewable: !entry.dir && (type !== undefined || isTextish(entry.name)),
          image: type?.startsWith('image/') === true,
        }
      }),
    },
  }
}

/** The status for a member that could not be extracted. */
const statusOf = (code) => (code === 'too-large' ? 413 : 415)

/** `GET /preview/entry`: one member, for the in-place preview. */
export async function serveEntry({ ctx, req, res, url, sessionId, path, signal }) {
  const member = url.searchParams.get('entry')
  if (member === null || member === '') throw new HttpError(400, 'entry is required')
  const { target, size, version } = await openFile(ctx, sessionId, path, signal)
  const { read, ranged } = await probe(ctx, target, size, path, signal)
  let data
  if (ranged) {
    let listed
    try {
      listed = await listZipRanged(read, size, LOOKUP)
    } catch (error) {
      if (error instanceof ArchiveError) throw new HttpError(415, error.message)
      throw error
    }
    const entry = listed.entries.find((candidate) => candidate.name === member)
    if (entry === undefined) throw new HttpError(404, 'no such entry')
    try {
      data = await readZipEntryRanged(read, entry, { maxBytes: ENTRY_LIMIT })
    } catch (error) {
      if (error instanceof ArchiveError) throw new HttpError(statusOf(error.code), error.message)
      throw error
    }
  } else {
    const key = keyOf(target, version)
    const args = { path, key, member, maxEntries: LOOKUP.maxEntries, maxBytes: ENTRY_LIMIT, maxOutputBytes: OUTPUT_LIMIT }
    // First ask the worker whether it still holds this version of the archive.
    let result = key === undefined ? { miss: true } : await runTask('archive', 'entry', undefined, args, signal)
    if (result.miss === true) {
      const bytes = await readCapped(ctx, target, size, LIMIT, signal, 'archive')
      result = await runTask('archive', 'entry', bytes, args, signal)
    }
    if (result.missing === true) throw new HttpError(404, 'no such entry')
    if (result.failure !== undefined) {
      throw new HttpError(result.stage === 'list' ? 415 : statusOf(result.failure.code), result.failure.message)
    }
    data = result.data
  }
  sendBytes(req, res, data, entryTypeOf(member) ?? 'application/octet-stream')
}
