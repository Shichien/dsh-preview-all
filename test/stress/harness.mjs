/**
 * The Host half under load, inside one process.
 *
 * The real route handler runs behind a real HTTP server; `ctx.fs` reads from
 * disk and counts every byte, so a scenario can tell "read the central
 * directory" from "read the whole archive". Response
 * bodies are streamed and thrown away: what is measured is the Host, not a
 * client holding the answer.
 */
import { createServer } from 'node:http'
import { open, stat } from 'node:fs/promises'
import { apply, ROUTE } from '../../lib/index.js'

const MIB = 1024 * 1024
/** A JSON answer up to this size is parsed for the scenario's assertions. */
const PARSE_LIMIT = 8 * MIB

export async function createHost() {
  const handles = new Map()
  const reads = { rangedBytes: 0, rangedCalls: 0 }
  const handleOf = (path) => {
    let handle = handles.get(path)
    if (handle === undefined) {
      handle = open(path, 'r')
      handles.set(path, handle)
    }
    return handle
  }
  const fs = {
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      try {
        const info = await stat(target.targetKey)
        return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: `${info.ino}:${info.size}:${info.mtimeMs}` }
      } catch {
        return undefined
      }
    },
    async readByteRange(target, { offset, length }) {
      const handle = await handleOf(target.targetKey)
      const buffer = Buffer.allocUnsafeSlow(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      reads.rangedBytes += bytesRead
      reads.rangedCalls += 1
      return new Uint8Array(buffer.buffer, 0, bytesRead)
    },
    // The plugin reads only through ranges; the local backend's `readBytes`
    // would hold a file twice while it joins the stream's chunks.
    async readBytes() {
      throw new Error('readBytes must not be used')
    },
  }

  let route
  const warnings = []
  apply({
    effect: (fn) => fn(),
    get: () => undefined,
    logger: { warn: (value) => warnings.push(String(value?.stack ?? value)), info() {} },
    webServer: { register: (registration) => { route = registration; return () => {} } },
    connection: { requestRejection: () => undefined },
    fs,
    sessions: { get: () => undefined },
    sandboxPolicy: { workspaceRoot: process.cwd() },
  })
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const requests = []

  /**
   * One request. The body is drained and counted; `abortAfter` drops the
   * connection once that many bytes arrived, as a seek or a closed tab does.
   * @param {string} action sub-route name
   * @param {string} path absolute file path
   * @param {{ query?: Record<string, string>, headers?: Record<string, string>, abortAfter?: number, label?: string }} [options]
   */
  async function get(action, path, options = {}) {
    const url = new URL(`${origin}${ROUTE}/${action}`)
    url.searchParams.set('path', path)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    const controller = new AbortController()
    const started = performance.now()
    const record = { label: options.label ?? `${action} ${path.split(/[\\/]/).pop()}`, status: 0, bytes: 0, ms: 0 }
    requests.push(record)
    const kept = []
    try {
      const response = await fetch(url, { headers: options.headers, signal: controller.signal })
      record.status = response.status
      record.headers = Object.fromEntries(response.headers)
      for await (const chunk of response.body ?? []) {
        record.bytes += chunk.length
        if (record.bytes <= PARSE_LIMIT) kept.push(chunk)
        if (options.abortAfter !== undefined && record.bytes >= options.abortAfter) {
          record.aborted = true
          controller.abort()
          break
        }
      }
    } catch (error) {
      if (!record.aborted) record.error = String(error?.cause?.message ?? error?.message ?? error)
    }
    record.ms = Math.round(performance.now() - started)
    const type = record.headers?.['content-type'] ?? ''
    if (record.bytes <= PARSE_LIMIT && !record.aborted && /json|text\/plain/.test(type)) {
      const text = Buffer.concat(kept).toString('utf8')
      if (type.includes('json')) {
        try { record.json = JSON.parse(text) } catch { record.text = text }
      } else {
        record.text = text
      }
    } else if (type.includes('json') && kept.length > 0) {
      // Too large to parse: the classification still sits at the front.
      record.head = Buffer.concat(kept).subarray(0, 512).toString('utf8')
    }
    return record
  }

  return {
    get,
    reads,
    requests,
    warnings,
    /** Let the server notice dropped connections before counters are read. */
    settle: (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms)),
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      for (const handle of handles.values()) await (await handle).close().catch(() => {})
    },
  }
}
