/**
 * Run a format's CPU-heavy parsing off the Host's thread.
 *
 * `runTask(kind, name, bytes, args, signal)` hands the bytes to a worker thread
 * and resolves with the task's result. What that buys:
 *
 *   - the Host's event loop, shared with the rest of DSH, never stalls on a
 *     decoder, however slow;
 *   - a closed tab ends the work: an aborted signal terminates the worker;
 *   - a task that runs too long, or outgrows the worker's heap, is stopped and
 *     answered with 413 instead of taking the Host down with it;
 *   - the worker is terminated once idle, which returns its memory.
 *
 * One task runs at a time. If worker threads cannot start in this runtime the
 * tasks run on the Host thread instead: slower to respond, same results.
 */
import { Worker } from 'node:worker_threads'
import { createGate } from './gate.js'
import { HttpError } from './http.js'
import { transferListOf } from './transfer.js'

const ENTRY = new URL('../offload-worker.js', import.meta.url)
/** Longest one task may run before it is stopped. */
export const TASK_TIMEOUT_MS = 30_000
/** How long an idle worker is kept before it is terminated. */
const IDLE_MS = 20_000
/** JavaScript heap ceiling of the worker; byte buffers are bounded by the formats' own caps. */
const HEAP_LIMIT_MB = 768

const gate = createGate(1)
/** The live worker, once it has come online. */
let worker
let idleTimer
/** Set when a worker could not be started; tasks then run on this thread. */
let inline = false
let nextId = 0

/** How long a new worker may take to load its modules and report ready. */
const START_TIMEOUT_MS = 10_000

/**
 * Start a worker and wait for its ready message, which it sends only after
 * its own imports resolved. Rejects when this runtime cannot run one.
 */
async function startWorker() {
  const started = new Worker(ENTRY, { resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB } })
  // Never keep the Host process alive for the worker's sake.
  started.unref()
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not become ready in time')), START_TIMEOUT_MS)
      const done = (settle, value) => {
        clearTimeout(timer)
        started.off('error', onError)
        started.off('exit', onExit)
        started.off('message', onMessage)
        settle(value)
      }
      const onError = (error) => done(reject, error)
      const onExit = (code) => done(reject, new Error(`worker exited with code ${code} before it was ready`))
      const onMessage = (message) => { if (message?.ready === true) done(resolve) }
      started.on('error', onError)
      started.on('exit', onExit)
      started.on('message', onMessage)
    })
  } catch (error) {
    started.terminate().catch(() => {})
    throw error
  }
  return started
}

/** Terminate the worker, if any. Its memory goes back to the system. */
export function stopWorker() {
  clearTimeout(idleTimer)
  idleTimer = undefined
  const stopping = worker
  worker = undefined
  if (stopping !== undefined) stopping.terminate().catch(() => {})
}

async function runInline(kind, name, bytes, args) {
  const tasks = await import(`../formats/${kind}/tasks.js`)
  return tasks[name](bytes, args ?? {})
}

async function runInWorker(kind, name, bytes, args, signal) {
  clearTimeout(idleTimer)
  if (worker === undefined) {
    try {
      worker = await startWorker()
    } catch (error) {
      inline = true
      console.warn(`[dsh-preview-all-in-one] parser worker unavailable, parsing on the Host thread: ${error?.message ?? error}`)
      return runInline(kind, name, bytes, args)
    }
  }
  const running = worker
  const id = ++nextId
  try {
    // The tab may have closed while the worker was starting.
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    return await new Promise((resolve, reject) => {
      /** Stop listening; with `kill`, also end the worker and whatever it is computing. */
      const settle = (kill) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        running.off('message', onMessage)
        running.off('error', onError)
        running.off('exit', onExit)
        if (kill && worker === running) stopWorker()
      }
      const onMessage = (message) => {
        if (message?.id !== id) return
        settle(false)
        if (message.error === undefined) {
          resolve(message)
          return
        }
        const failure = new Error(message.error.message)
        failure.stack = message.error.stack ?? failure.stack
        failure.code = message.error.code
        reject(failure)
      }
      const onError = (error) => {
        settle(true)
        reject(error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new HttpError(413, 'parsing this file needs more memory than the preview allows')
          : error)
      }
      const onExit = (code) => {
        settle(true)
        reject(new Error(`parser worker exited with code ${code}`))
      }
      const onAbort = () => {
        settle(true)
        reject(signal.reason ?? new Error('aborted'))
      }
      const timer = setTimeout(() => {
        settle(true)
        reject(new HttpError(413, `parsing this file took longer than ${TASK_TIMEOUT_MS / 1000} s and was stopped`))
      }, TASK_TIMEOUT_MS)
      running.on('message', onMessage)
      running.on('error', onError)
      running.on('exit', onExit)
      signal?.addEventListener('abort', onAbort, { once: true })
      const message = { id, kind, name, bytes, args }
      const moved = transferListOf({ bytes })
      try {
        running.postMessage(message, moved)
      } catch (error) {
        if (moved.length === 0) {
          settle(false)
          reject(error)
          return
        }
        // The buffer refused to move (nothing was moved); copy it instead.
        running.postMessage(message)
      }
    })
  } finally {
    if (worker !== undefined) {
      idleTimer = setTimeout(stopWorker, IDLE_MS)
      idleTimer.unref()
    }
  }
}

/**
 * Run one task of `lib/formats/<kind>/tasks.js` and resolve with its result.
 * The bytes are handed over: do not use them afterwards.
 * @param {string} kind format group
 * @param {string} name exported task function
 * @param {Uint8Array} bytes
 * @param {Record<string, unknown>} [args] structured-cloneable arguments
 * @param {AbortSignal} [signal] aborting it stops the work
 * @returns {Promise<any>}
 */
export function runTask(kind, name, bytes, args, signal) {
  return gate(signal, () => (inline ? runInline(kind, name, bytes, args) : runInWorker(kind, name, bytes, args, signal)))
}

/** Where tasks currently run; for tests and diagnostics. */
export function offloadState() {
  return { inline, workerRunning: worker !== undefined }
}
