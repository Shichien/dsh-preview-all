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

// `mod` is the entry bundle; `media` is the player runtime, which lives in the
// lazily loaded media chunk rather than in the entry.
let mod
let media
globalThis.window = {
  __ModuleLoader__: {
    load: ({ chunk, factory }) => {
      const exports = factory(() => ({}))
      if (chunk === undefined) mod = exports
      else if (chunk === 'client.media.js') media = exports.runtime
    },
  },
}
for (const name of ['client.js', 'client.media.js']) {
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'))
}

const key = (k, extra) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, ...extra })

beforeEach(() => memory.clear())

test('keyboard shortcuts map to commands', () => {
  assert.deepEqual(media.keyCommand(key(' ')), { cmd: 'toggle' })
  assert.deepEqual(media.keyCommand(key('ArrowLeft')), { cmd: 'seek', arg: -5 })
  assert.deepEqual(media.keyCommand(key('ArrowRight', { ctrlKey: true })), { cmd: 'seek', arg: 30 })
  assert.deepEqual(media.keyCommand(key('ArrowUp')), { cmd: 'volume', arg: 0.05 })
  assert.deepEqual(media.keyCommand(key(',')), { cmd: 'frame', arg: -1 })
  assert.deepEqual(media.keyCommand(key('.')), { cmd: 'frame', arg: 1 })
  assert.deepEqual(media.keyCommand(key('c')), { cmd: 'rate', arg: 0.1 })
  assert.deepEqual(media.keyCommand(key('X')), { cmd: 'rate', arg: -0.1 })
  assert.deepEqual(media.keyCommand(key('z')), { cmd: 'rateReset' })
  assert.deepEqual(media.keyCommand(key('c', { ctrlKey: true })), { cmd: 'copyFrame' })
  assert.deepEqual(media.keyCommand(key('s', { ctrlKey: true })), { cmd: 'saveFrame' })
  assert.deepEqual(media.keyCommand(key('7')), { cmd: 'percent', arg: 70 })
  assert.deepEqual(media.keyCommand(key('f')), { cmd: 'fullscreen' })
  assert.deepEqual(media.keyCommand(key('?')), { cmd: 'help' })
})

test('unrelated keys pass through', () => {
  assert.equal(media.keyCommand(key('a')), undefined)
  assert.equal(media.keyCommand(key('Tab')), undefined)
  assert.equal(media.keyCommand(key('v', { ctrlKey: true })), undefined)
  assert.equal(media.keyCommand(key('ArrowLeft', { altKey: true })), undefined)
  assert.equal(media.keyCommand(key('c', { metaKey: true })), undefined)
})

test('speed is clamped to 0.1–4 and kept free of float noise', () => {
  assert.equal(media.clampRate(1.1 + 0.1), 1.2)
  assert.equal(media.clampRate(0.1 - 0.1), 0.1)
  assert.equal(media.clampRate(9), 4)
  assert.equal(media.clampRate(Number.NaN), 1)
  assert.equal(media.formatRate(1), '1.0×')
  assert.equal(media.formatRate(1.5), '1.5×')
  assert.equal(media.formatRate(1.25), '1.25×')
})

test('time formatting', () => {
  assert.equal(media.formatTime(0), '0:00')
  assert.equal(media.formatTime(65.4), '1:05')
  assert.equal(media.formatTime(3725), '1:02:05')
  assert.equal(media.formatTime(4.367, true), '0:04.367')
  assert.equal(media.formatTime(Number.NaN), '--:--')
})

test('position keys: absolute paths are shared, relative ones are per session', () => {
  assert.equal(media.positionKey({ sessionId: 's1', path: 'C:/Users/Me/A.mp4' }), 'abs:c:/users/me/a.mp4')
  assert.equal(media.positionKey({ sessionId: 's2', path: 'c:/users/me/a.mp4' }), 'abs:c:/users/me/a.mp4')
  assert.equal(media.positionKey({ sessionId: 's1', path: '/home/me/a.mp4' }), 'abs:/home/me/a.mp4')
  assert.equal(media.positionKey({ sessionId: 's1', path: 'samples/a.mp4' }), 'rel:s1:samples/a.mp4')
})

test('resume position is stored mid-video and forgotten near either end', () => {
  media.storePosition('k', 125.37, 600)
  assert.equal(media.loadPosition('k'), 125.4)
  media.storePosition('k', 595, 600)
  assert.equal(media.loadPosition('k'), undefined)
  media.storePosition('k', 300, 600)
  media.storePosition('k', 2, 600)
  assert.equal(media.loadPosition('k'), undefined)
})

test('resume store keeps only the newest 200 files', () => {
  const realNow = Date.now
  try {
    for (let i = 0; i < 205; i++) {
      Date.now = () => 1_000_000 + i
      media.storePosition(`f${i}`, 60, 600)
    }
  } finally {
    Date.now = realNow
  }
  const all = JSON.parse(memory.get('dsh-preview-all:positions'))
  assert.equal(Object.keys(all).length, 200)
  assert.equal(media.loadPosition('f0'), undefined)
  assert.equal(media.loadPosition('f204'), 60)
})

test('corrupt storage is ignored', () => {
  memory.set('dsh-preview-all:positions', '{not json')
  assert.equal(media.loadPosition('k'), undefined)
  media.storePosition('k', 60, 600)
  assert.equal(media.loadPosition('k'), 60)
})

test('session and absolute addresses both parse', () => {
  const prefix = 'dsh-resource://file/'
  assert.deepEqual(mod.fileOf(`${prefix}session/s1/clip.mp4`), { scope: 'session', sessionId: 's1', path: 'clip.mp4' })
  assert.deepEqual(
    mod.fileOf(`${prefix}session/abc%20123/C:/Users/me/My%20Clips/%E8%A7%86%E9%A2%91.mov`),
    { scope: 'session', sessionId: 'abc 123', path: 'C:/Users/me/My Clips/视频.mov' },
  )
  assert.deepEqual(mod.fileOf(`${prefix}absolute/C:/x/a.mp4`), { scope: 'absolute', path: 'C:/x/a.mp4' })
  assert.deepEqual(mod.fileOf(`${prefix}absolute//host/share/a.zip`), { scope: 'absolute', path: '//host/share/a.zip' })
  assert.deepEqual(mod.fileOf(`${prefix}absolute/home/me/a.zip`), { scope: 'absolute', path: '/home/me/a.zip' })
  // A query or fragment never becomes part of the path.
  assert.deepEqual(mod.fileOf(`${prefix}session/s1/a.zip?x=1`), { scope: 'session', sessionId: 's1', path: 'a.zip' })
  assert.equal(mod.fileOf('https://example.com/a.zip'), undefined)
  assert.equal(mod.fileOf(`${prefix}session/s1`), undefined)
  assert.equal(mod.fileOf(`${prefix}elsewhere/s1/a.zip`), undefined)
})

test('only suffixes this plugin claims pass hasSuffix', () => {
  assert.equal(mod.hasSuffix('C:/x/clip.mkv'), true)
  assert.equal(mod.hasSuffix('C:\\x\\CLIP.MP4'), true)
  assert.equal(mod.hasSuffix('bundle.zip'), true)
  assert.equal(mod.hasSuffix('song.flac'), true)
  assert.equal(mod.hasSuffix('font.woff2'), true)
  assert.equal(mod.hasSuffix('report.rtf'), true)
  // Builtin renderers own these; claiming them would shadow a better preview.
  assert.equal(mod.hasSuffix('a.png'), false)
  assert.equal(mod.hasSuffix('a.pdf'), false)
  assert.equal(mod.hasSuffix('a.docx'), false)
  assert.equal(mod.hasSuffix('a.xlsx'), false)
  assert.equal(mod.hasSuffix('a.ts'), false)
  assert.equal(mod.hasSuffix('a.md'), false)
  assert.equal(mod.hasSuffix('no-suffix'), false)
})

test('preview URLs carry the session only when there is one', () => {
  const base = 'http://127.0.0.1:43120/'
  assert.equal(
    mod.previewUrl(base, 'info', { scope: 'session', sessionId: 's 1', path: 'a b/c.zip' }),
    'http://127.0.0.1:43120/preview/info?sessionId=s+1&path=a+b%2Fc.zip',
  )
  assert.equal(
    mod.previewUrl(base, 'stream', { scope: 'absolute', path: 'C:/x/a.mp4' }),
    'http://127.0.0.1:43120/preview/stream?path=C%3A%2Fx%2Fa.mp4',
  )
  assert.equal(
    mod.previewUrl(base, 'download', { scope: 'absolute', path: 'a.zip' }),
    'http://127.0.0.1:43120/preview/download?path=a.zip',
  )
})

test('sizes and the document shell', () => {
  assert.equal(mod.formatSize(0), '0 B')
  assert.equal(mod.formatSize(999), '999 B')
  assert.equal(mod.formatSize(1536), '1.5 KB')
  assert.equal(mod.formatSize(20 * 1024 * 1024), '20 MB')
  assert.equal(mod.formatSize(Number.NaN), '')
  const html = mod.documentHtml('<p>hi &amp; bye</p>', 'a <b>.rtf')
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('<p>hi &amp; bye</p>'))
  assert.ok(html.includes('a &lt;b&gt;.rtf'))
  assert.ok(html.includes("default-src 'none'"))
})
