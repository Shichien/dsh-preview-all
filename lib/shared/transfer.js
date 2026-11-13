/**
 * Which buffers may be moved, rather than copied, across a worker boundary.
 *
 * A view is only moved when it owns its whole buffer: moving a buffer that
 * other views share (Node's small-allocation pool, or a slice of a larger
 * file) would empty them too. Small buffers are simply copied.
 */

/** Below this a copy is cheaper than the bookkeeping, and the buffer may be pooled. */
const MIN_TRANSFER_BYTES = 64 * 1024

/** Whether `value` is a byte view that owns its entire, reasonably large, buffer. */
export function ownsBuffer(value) {
  return value instanceof Uint8Array
    && value.buffer instanceof ArrayBuffer
    && value.byteOffset === 0
    && value.byteLength === value.buffer.byteLength
    && value.byteLength >= MIN_TRANSFER_BYTES
}

/** The transfer list for a message: the buffers of its top-level byte views that can be moved. */
export function transferListOf(message) {
  const buffers = new Set()
  for (const value of Object.values(message ?? {})) {
    if (ownsBuffer(value)) buffers.add(value.buffer)
  }
  return [...buffers]
}

/** Post `message`, moving what can be moved and copying when a buffer refuses to move. */
export function postWithTransfer(port, message) {
  const list = transferListOf(message)
  if (list.length === 0) {
    port.postMessage(message)
    return
  }
  try {
    port.postMessage(message, list)
  } catch {
    // An untransferable buffer throws before anything is moved; copying still works.
    port.postMessage(message)
  }
}
