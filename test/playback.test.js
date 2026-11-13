// When playback stops. The tab type is kept mounted, so:
//   - switching away (another tab, collapsed sidebar, another session) keeps playing;
//   - closing the tab stops it and releases the media element.
// The panel is driven by a minimal hook runtime: state and refs persist across
// renders, effects are collected and run on demand.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import createPanel from '../lib/formats/media/client.js'
import createMediaRuntime from '../lib/formats/media/client-runtime.js'

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}
const listeners = { addEventListener() {}, removeEventListener() {} }
globalThis.window = { ...listeners }
globalThis.document = { ...listeners, fullscreenElement: null }

beforeEach(() => memory.clear())

/** Mount the media panel under a hook runtime small enough to read in one go. */
function mountPlayer() {
  const slots = []
  let cursor = 0
  let effects = []
  const slot = (create) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = create()
    return slots[index]
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [slot(() => (typeof initial === 'function' ? initial() : initial)), () => {}],
    useRef: (initial) => slot(() => ({ current: initial })),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (fn) => effects.push(fn),
    useLayoutEffect: (fn) => effects.push(fn),
  }
  const runtime = createMediaRuntime()
  const Panel = createPanel({
    React,
    runtime,
    previewUrl: (_base, route) => `https://example.test/${route}`,
    messageForStatus: String,
    basenameOfPath: (path) => path.split('/').pop(),
    stemOf: (name) => name,
  })
  const find = (node, type) => {
    if (node === null || typeof node !== 'object') return undefined
    if (node.type === type) return node
    for (const child of node.children ?? []) {
      const found = find(child, type)
      if (found !== undefined) return found
    }
    return undefined
  }
  return {
    runtime,
    /** Render once and run every effect, as a commit would. Returns the media element's props. */
    commit(tab) {
      cursor = 0
      effects = []
      const tree = Panel({
        tab,
        file: { scope: 'absolute', path: 'C:/x/a.mp4' },
        base: 'https://example.test/',
        info: { name: 'a.mp4', media: { kind: 'video' } },
        t: (key) => key,
      })
      for (const effect of effects) effect()
      return find(tree, 'video').props
    },
  }
}

/** A stand-in media element that records what is done to it. */
function fakeVideo() {
  const calls = []
  return {
    calls,
    readyState: 4,
    currentTime: 100,
    duration: 600,
    volume: 1,
    muted: false,
    pause: () => calls.push('pause'),
    load: () => calls.push('load'),
    removeAttribute: (name) => calls.push(`removeAttribute:${name}`),
  }
}

test('switching away keeps playing and only saves the position', () => {
  const player = mountPlayer()
  const closing = new AbortController()
  const video = fakeVideo()
  player.commit({ visible: true, signal: closing.signal }).ref(video)

  // Another tab selected, the sidebar collapsed, or the session switched.
  player.commit({ visible: false, signal: closing.signal })
  assert.deepEqual(video.calls, [], 'a hidden tab must not pause or release the element')
  assert.equal(player.runtime.loadPosition('abs:c:/x/a.mp4'), 100, 'the position is saved when the tab is hidden')

  // Coming back changes nothing either.
  player.commit({ visible: true, signal: closing.signal })
  assert.deepEqual(video.calls, [])
})

test('closing the tab stops playback', () => {
  const player = mountPlayer()
  const closing = new AbortController()
  const video = fakeVideo()
  player.commit({ visible: true, signal: closing.signal }).ref(video)
  assert.deepEqual(video.calls, [])

  video.currentTime = 250
  closing.abort()
  assert.deepEqual(video.calls, ['pause'], 'the tab signal stops playback')
  assert.equal(player.runtime.loadPosition('abs:c:/x/a.mp4'), 250)
})

test('a tab that is already closed never keeps playing', () => {
  const player = mountPlayer()
  const closing = new AbortController()
  closing.abort()
  const video = fakeVideo()
  player.commit({ visible: true, signal: closing.signal }).ref(video)
  player.commit({ visible: true, signal: closing.signal })
  assert.deepEqual(video.calls, ['pause'])
})

test('unmounting releases the media element so its buffers are freed', () => {
  const player = mountPlayer()
  const video = fakeVideo()
  const props = player.commit({ visible: true })
  props.ref(video)
  // React detaches the ref when the tab body unmounts.
  props.ref(null)
  assert.deepEqual(video.calls, ['pause', 'removeAttribute:src', 'load'])
  assert.equal(player.runtime.loadPosition('abs:c:/x/a.mp4'), 100)
})
