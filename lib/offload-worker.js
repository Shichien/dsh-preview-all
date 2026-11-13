/**
 * Worker-thread entry: runs a format's CPU-heavy, pure parsing tasks.
 *
 * The Host shares its event loop with the rest of DSH, so a decoder that runs
 * for seconds there freezes the whole application. Here it only keeps this
 * thread busy, and the Host can end it by terminating the worker.
 *
 * A task is a named export of `lib/formats/<kind>/tasks.js`:
 * `(bytes, args) => result`. It sees no Host services, only bytes.
 */
import { parentPort } from 'node:worker_threads'
import { postWithTransfer } from './shared/transfer.js'

const KIND = /^[a-z][a-z0-9-]*$/
const modules = new Map()

parentPort.on('message', async ({ id, kind, name, bytes, args }) => {
  try {
    if (typeof kind !== 'string' || !KIND.test(kind)) throw new TypeError(`invalid task kind: ${kind}`)
    let tasks = modules.get(kind)
    if (tasks === undefined) {
      tasks = await import(`./formats/${kind}/tasks.js`)
      modules.set(kind, tasks)
    }
    if (typeof name !== 'string' || !Object.hasOwn(tasks, name) || typeof tasks[name] !== 'function') {
      throw new TypeError(`unknown task: ${kind}.${name}`)
    }
    const result = await tasks[name](bytes, args ?? {})
    postWithTransfer(parentPort, { id, ...result })
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { message: String(error?.message ?? error), stack: error?.stack, code: error?.code },
    })
  }
})

// Reaching this line means every import above resolved: the Host waits for it
// before sending work, and parses on its own thread if it never arrives.
parentPort.postMessage({ ready: true })
