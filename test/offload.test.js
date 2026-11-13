// The parser worker: results come back, expected failures come back as data,
// and a closed tab stops work that is still running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { offloadState, runTask, stopWorker } from '../lib/shared/offload.js'
import { ownsBuffer, transferListOf } from '../lib/shared/transfer.js'

test.after(stopWorker)

/** A single-strip, deflate-compressed, all-black RGB TIFF, optionally followed by unused bytes. */
function blankTiff(width, height, padding = 0) {
  const strip = deflateSync(Buffer.alloc(width * height * 3))
  const entries = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 3, 0], [259, 3, 1, 8], [262, 3, 1, 2],
    [273, 4, 1, 0], [277, 3, 1, 3], [278, 4, 1, height], [279, 4, 1, strip.length],
  ]
  const bitsAt = 8 + 2 + entries.length * 12 + 4
  const stripAt = bitsAt + 6
  entries[2][3] = bitsAt
  entries[5][3] = stripAt
  const head = Buffer.alloc(stripAt)
  head.write('II', 0, 'latin1')
  head.writeUInt16LE(42, 2)
  head.writeUInt32LE(8, 4)
  head.writeUInt16LE(entries.length, 8)
  entries.forEach(([tag, type, count, value], index) => {
    const at = 10 + index * 12
    head.writeUInt16LE(tag, at)
    head.writeUInt16LE(type, at + 2)
    head.writeUInt32LE(count, at + 4)
    if (type === 3 && count === 1) head.writeUInt16LE(value, at + 8)
    else head.writeUInt32LE(value, at + 8)
  })
  for (let index = 0; index < 3; index++) head.writeUInt16LE(8, bitsAt + index * 2)
  // A fresh allocation, so the view owns its whole buffer.
  return new Uint8Array(Buffer.concat([head, strip, Buffer.alloc(padding)]))
}

test('a task runs on the worker and its result comes back', async () => {
  const decoded = await runTask('raster', 'png', blankTiff(64, 48), {})
  assert.equal(decoded.width, 64)
  assert.equal(decoded.height, 48)
  assert.deepEqual([...decoded.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.deepEqual(offloadState(), { inline: false, workerRunning: true }, 'the task must not have run on this thread')
})

test('expected failures come back as data, not as exceptions', async () => {
  const listing = await runTask('archive', 'list', new Uint8Array([1, 2, 3, 4]), { path: 'broken.7z', maxEntries: 10, maxOutputBytes: 1024 })
  assert.equal(listing.stage, 'list')
  assert.equal(typeof listing.failure.message, 'string')
  const document = await runTask('document', 'html', new Uint8Array([1, 2, 3, 4]), { path: 'broken.odt', maxHtmlChars: 1000 })
  assert.match(document.failure.message, /content\.xml/)
  assert.equal((await runTask('raster', 'png', new Uint8Array(64), {})).unknown, true)
})

test('an unknown task is refused', async () => {
  await assert.rejects(runTask('raster', 'constructor', new Uint8Array(4), {}), /unknown task/)
  await assert.rejects(runTask('../shared', 'png', new Uint8Array(4), {}), /invalid task kind/)
})

test('large inputs are moved to the worker, not copied', async () => {
  // An all-black image deflates to almost nothing; pad it past the size worth moving.
  const bytes = blankTiff(512, 512, 128 * 1024)
  assert.ok(ownsBuffer(bytes))
  await runTask('raster', 'png', bytes, {})
  assert.equal(bytes.byteLength, 0, 'the buffer was handed over')
  // A slice of a bigger buffer, or a small pooled one, must never be moved.
  const whole = new Uint8Array(256 * 1024)
  assert.deepEqual(transferListOf({ bytes: whole.subarray(16) }), [])
  assert.deepEqual(transferListOf({ bytes: new Uint8Array(100) }), [])
  assert.deepEqual(transferListOf({ bytes: whole }), [whole.buffer])
})

test('closing the tab stops a task that is still running', async () => {
  // Warm, so the abort lands in the decoder rather than in worker start-up.
  await runTask('raster', 'png', blankTiff(8, 8), {})
  const slow = blankTiff(8192, 4096)
  const closing = new AbortController()
  const started = performance.now()
  const pending = runTask('raster', 'png', slow, {}, closing.signal)
  setTimeout(() => closing.abort(new Error('tab closed')), 40)
  await assert.rejects(pending, /tab closed/)
  const waited = performance.now() - started
  assert.equal(offloadState().workerRunning, false, 'the worker is terminated, which is what stops the decoder')

  // The same image decoded to the end takes far longer than the abort took.
  const full = performance.now()
  const decoded = await runTask('raster', 'png', blankTiff(8192, 4096), {})
  assert.equal(decoded.width, 8192)
  assert.ok(waited < (performance.now() - full) / 2, `abort returned after ${waited.toFixed(0)} ms`)
})

test('a signal that is already aborted never starts the task', async () => {
  const closed = new AbortController()
  closed.abort(new Error('already closed'))
  await assert.rejects(runTask('raster', 'png', blankTiff(8, 8), {}, closed.signal), /already closed/)
})
