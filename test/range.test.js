import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRange, videoTypeOf } from '../lib/index.js'

test('no or malformed Range sends the full file', () => {
  assert.deepEqual(parseRange(undefined, 100), { kind: 'full' })
  assert.deepEqual(parseRange('', 100), { kind: 'full' })
  assert.deepEqual(parseRange('items=0-1', 100), { kind: 'full' })
  assert.deepEqual(parseRange('bytes=-', 100), { kind: 'full' })
  assert.deepEqual(parseRange('bytes=9-3', 100), { kind: 'full' })
})

test('open, closed and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-', 100), { kind: 'partial', start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=10-19', 100), { kind: 'partial', start: 10, end: 19 })
  assert.deepEqual(parseRange('bytes=90-500', 100), { kind: 'partial', start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-30', 100), { kind: 'partial', start: 70, end: 99 })
  assert.deepEqual(parseRange('bytes=-300', 100), { kind: 'partial', start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=0-0, 5-9', 100), { kind: 'partial', start: 0, end: 0 })
})

test('unsatisfiable ranges', () => {
  assert.deepEqual(parseRange('bytes=100-', 100), { kind: 'unsatisfiable' })
  assert.deepEqual(parseRange('bytes=-0', 100), { kind: 'unsatisfiable' })
  assert.deepEqual(parseRange('bytes=0-', 0), { kind: 'unsatisfiable' })
})

test('video types by extension, case-insensitive', () => {
  assert.equal(videoTypeOf('a/B.MP4'), 'video/mp4')
  assert.equal(videoTypeOf('clip.webm'), 'video/webm')
  assert.equal(videoTypeOf('x.mov'), 'video/mp4')
  assert.equal(videoTypeOf('notes.txt'), undefined)
  assert.equal(videoTypeOf('mp4'), undefined)
})
