// Checks the client half against the real tab-registry ranking rules:
// picomatch with { nocase, dot } on whole addresses, highest band first, then
// longest matching pattern. Run from the repo root with NODE_PATH pointing at a
// directory that contains picomatch.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(process.env.PICOMATCH_FROM)
const picomatch = require('picomatch')

let mod
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ createElement() {}, useEffect() {}, useMemo() {}, useRef() {}, useState() {} })) } } }
// eslint-disable-next-line no-eval
;(0, eval)(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))

const types = [
  { id: 'better-sidebar', band: 3, patterns: ['dsh-resource://file/**'] },
  { id: 'video', band: 3, patterns: mod.PATTERNS, canOpen: (a) => { const f = mod.sessionFileOf(a); return f !== undefined && mod.isVideoPath(f.path) } },
  { id: 'documentpreview', band: 1, patterns: ['dsh-resource://file/[\\s\\S]+'] },
]
function winner(address) {
  const ranked = []
  for (const type of types) {
    let length = -1
    for (const p of type.patterns) if (picomatch(p, { nocase: true, dot: true })(address) && p.length > length) length = p.length
    if (length < 0 || (type.canOpen && !type.canOpen(address))) continue
    ranked.push({ id: type.id, band: type.band, length })
  }
  ranked.sort((a, b) => b.band - a.band || b.length - a.length)
  return ranked[0]?.id
}

const s = 'dsh-resource://file/session/abc%20123/'
const cases = [
  [`${s}videos/demo.mp4`, 'video'],
  [`${s}VIDEOS/Demo.MP4`, 'video'],
  [`${s}C:/Users/me/My%20Clips/%E8%A7%86%E9%A2%91.mov`, 'video'],
  [`${s}/home/me/.cache/a.webm`, 'video'],
  [`${s}clip.mkv`, 'video'],
  [`${s}src/index.ts`, 'better-sidebar'],
  [`${s}notes.mp4.txt`, 'better-sidebar'],
  ['dsh-resource://file/absolute/C:/x/a.mp4', 'better-sidebar'],
]
for (const [address, expected] of cases) {
  assert.equal(winner(address), expected, address)
  console.log('ok', expected.padEnd(15), address)
}
assert.deepEqual(mod.sessionFileOf(`${s}C:/Users/me/My%20Clips/%E8%A7%86%E9%A2%91.mov`), { sessionId: 'abc 123', path: 'C:/Users/me/My Clips/视频.mov' })
console.log('ok sessionFileOf decodes')
