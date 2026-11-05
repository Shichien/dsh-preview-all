// Unit tests for the pure helpers in the hand-written client bundle. The bundle
// registers itself through window.__ModuleLoader__, so it is evaluated with a
// stub loader and an in-memory localStorage.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}

let mod
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({})) } } }
// eslint-disable-next-line no-eval
;(0, eval)(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))

const key = (k, extra) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, ...extra })

beforeEach(() => memory.clear())

test('keyboard shortcuts map to commands', () => {
  assert.deepEqual(mod.keyCommand(key(' ')), { cmd: 'toggle' })
  assert.deepEqual(mod.keyCommand(key('ArrowLeft')), { cmd: 'seek', arg: -5 })
  assert.deepEqual(mod.keyCommand(key('ArrowRight', { ctrlKey: true })), { cmd: 'seek', arg: 30 })
  assert.deepEqual(mod.keyCommand(key('ArrowUp')), { cmd: 'volume', arg: 0.05 })
  assert.deepEqual(mod.keyCommand(key(',')), { cmd: 'frame', arg: -1 })
  assert.deepEqual(mod.keyCommand(key('.')), { cmd: 'frame', arg: 1 })
  assert.deepEqual(mod.keyCommand(key('c')), { cmd: 'rate', arg: 0.1 })
  assert.deepEqual(mod.keyCommand(key('X')), { cmd: 'rate', arg: -0.1 })
  assert.deepEqual(mod.keyCommand(key('z')), { cmd: 'rateReset' })
  assert.deepEqual(mod.keyCommand(key('c', { ctrlKey: true })), { cmd: 'copyFrame' })
  assert.deepEqual(mod.keyCommand(key('s', { ctrlKey: true })), { cmd: 'saveFrame' })
  assert.deepEqual(mod.keyCommand(key('7')), { cmd: 'percent', arg: 70 })
  assert.deepEqual(mod.keyCommand(key('f')), { cmd: 'fullscreen' })
  assert.deepEqual(mod.keyCommand(key('?')), { cmd: 'help' })
})

test('unrelated keys pass through', () => {
  assert.equal(mod.keyCommand(key('a')), undefined)
  assert.equal(mod.keyCommand(key('Tab')), undefined)
  assert.equal(mod.keyCommand(key('v', { ctrlKey: true })), undefined)
  assert.equal(mod.keyCommand(key('ArrowLeft', { altKey: true })), undefined)
  assert.equal(mod.keyCommand(key('c', { metaKey: true })), undefined)
})

test('speed is clamped to 0.1–4 and kept free of float noise', () => {
  assert.equal(mod.clampRate(1.1 + 0.1), 1.2)
  assert.equal(mod.clampRate(0.1 - 0.1), 0.1)
  assert.equal(mod.clampRate(9), 4)
  assert.equal(mod.clampRate(Number.NaN), 1)
  assert.equal(mod.formatRate(1), '1.0×')
  assert.equal(mod.formatRate(1.5), '1.5×')
  assert.equal(mod.formatRate(1.25), '1.25×')
})

test('time formatting', () => {
  assert.equal(mod.formatTime(0), '0:00')
  assert.equal(mod.formatTime(65.4), '1:05')
  assert.equal(mod.formatTime(3725), '1:02:05')
  assert.equal(mod.formatTime(4.367, true), '0:04.367')
  assert.equal(mod.formatTime(Number.NaN), '--:--')
})

test('position keys: absolute paths are shared, relative ones are per session', () => {
  assert.equal(mod.positionKey({ sessionId: 's1', path: 'C:/Users/Me/A.mp4' }), 'abs:c:/users/me/a.mp4')
  assert.equal(mod.positionKey({ sessionId: 's2', path: 'c:/users/me/a.mp4' }), 'abs:c:/users/me/a.mp4')
  assert.equal(mod.positionKey({ sessionId: 's1', path: '/home/me/a.mp4' }), 'abs:/home/me/a.mp4')
  assert.equal(mod.positionKey({ sessionId: 's1', path: 'samples/a.mp4' }), 'rel:s1:samples/a.mp4')
})

test('resume position is stored mid-video and forgotten near either end', () => {
  mod.storePosition('k', 125.37, 600)
  assert.equal(mod.loadPosition('k'), 125.4)
  mod.storePosition('k', 595, 600)
  assert.equal(mod.loadPosition('k'), undefined)
  mod.storePosition('k', 300, 600)
  mod.storePosition('k', 2, 600)
  assert.equal(mod.loadPosition('k'), undefined)
})

test('resume store keeps only the newest 200 files', () => {
  const realNow = Date.now
  try {
    for (let i = 0; i < 205; i++) {
      Date.now = () => 1_000_000 + i
      mod.storePosition(`f${i}`, 60, 600)
    }
  } finally {
    Date.now = realNow
  }
  const all = JSON.parse(memory.get('dsh-video-preview:positions'))
  assert.equal(Object.keys(all).length, 200)
  assert.equal(mod.loadPosition('f0'), undefined)
  assert.equal(mod.loadPosition('f204'), 60)
})

test('corrupt storage is ignored', () => {
  memory.set('dsh-video-preview:positions', '{not json')
  assert.equal(mod.loadPosition('k'), undefined)
  mod.storePosition('k', 60, 600)
  assert.equal(mod.loadPosition('k'), 60)
})
