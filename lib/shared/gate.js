/**
 * A FIFO concurrency gate for work that holds a whole file in memory.
 *
 * A restored session can ask for several previews at once. Each archive,
 * font, raster or document parse buffers its file, so running them side by
 * side multiplies the peak; queueing them bounds it to `limit` files. The
 * parsers are synchronous CPU work on one thread anyway, so nothing is lost.
 *
 * A request that is aborted while it waits leaves the queue without running.
 */
export function createGate(limit) {
  let active = 0
  const waiting = []

  function admit() {
    while (active < limit && waiting.length > 0) {
      active += 1
      waiting.shift().enter()
    }
  }

  /**
   * @template T
   * @param {AbortSignal | undefined} signal
   * @param {() => Promise<T> | T} task
   * @returns {Promise<T>}
   */
  return async function run(signal, task) {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      const ticket = {
        enter() {
          signal?.removeEventListener('abort', leave)
          resolve()
        },
      }
      function leave() {
        const at = waiting.indexOf(ticket)
        if (at !== -1) waiting.splice(at, 1)
        reject(signal.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', leave, { once: true })
      waiting.push(ticket)
      admit()
    })
    try {
      return await task()
    } finally {
      active -= 1
      admit()
    }
  }
}
