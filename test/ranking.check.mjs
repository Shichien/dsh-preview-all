// Checks the client half against the real tab-registry ranking rules:
// picomatch with { nocase, dot } on whole addresses, highest band first, then
// longest matching pattern. Run from the repo root with NODE_PATH pointing at a
// directory that contains picomatch (the DSH app's node_modules).
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const require = createRequire(process.env.PICOMATCH_FROM)
const picomatch = require('picomatch')

let mod
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ createElement() {}, useEffect() {}, useMemo() {}, useRef() {}, useState() {}, useCallback() {}, useLayoutEffect() {} })) } } }
// eslint-disable-next-line no-eval
;(0, eval)(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))

const types = [
  { id: 'better-sidebar', band: 3, patterns: ['dsh-resource://file/**'] },
  { id: 'preview-all', band: 3, patterns: mod.PATTERNS, canOpen: (a) => { const f = mod.fileOf(a); return f !== undefined && mod.hasSuffix(f.path) } },
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
const ours = 'preview-all'
const cases = [
  // Media keeps working exactly as the video-only plugin did.
  [`${s}videos/demo.mp4`, ours],
  [`${s}VIDEOS/Demo.MP4`, ours],
  [`${s}C:/Users/me/My%20Clips/%E8%A7%86%E9%A2%91.mov`, ours],
  [`${s}/home/me/.cache/a.webm`, ours],
  [`${s}clip.mkv`, ours],
  [`${s}audio/song.flac`, ours],
  // The new kinds.
  [`${s}bundle.zip`, ours],
  [`${s}backup.tar.gz`, ours],
  [`${s}tools/tool.exe`, ours],
  [`${s}fonts/MyFont.woff2`, ours],
  [`${s}photos/raw.dng`, ours],
  [`${s}pics/photo.heic`, ours],
  [`${s}docs/notes.rtf`, ours],
  // An absolute address has no session to read through, so only this plugin can
  // take it: the builtin document preview's `canOpen` rejects it.
  ['dsh-resource://file/absolute/C:/x/a.mp4', ours],
  ['dsh-resource://file/absolute/C:/x/bundle.zip', ours],
  // A suffix a builtin renderer owns stays with it, even though the glob is longer.
  [`${s}src/index.ts`, 'better-sidebar'],
  [`${s}notes.mp4.txt`, 'better-sidebar'],
  [`${s}image.png`, 'better-sidebar'],
  [`${s}report.pdf`, 'better-sidebar'],
  [`${s}book.docx`, 'better-sidebar'],
  [`${s}sheet.xlsx`, 'better-sidebar'],
  [`${s}page.html`, 'better-sidebar'],
  ['dsh-resource://file/absolute/C:/x/index.ts', 'better-sidebar'],
]
for (const [address, expected] of cases) {
  assert.equal(winner(address), expected, address)
  console.log('ok', expected.padEnd(18), address)
}

// The glob has to be longer than Better Sidebar's catch-all to win the tie.
assert.ok(mod.PATTERNS[0].length > 'dsh-resource://file/**'.length)
console.log('ok glob length', mod.PATTERNS[0].length)

assert.deepEqual(mod.fileOf(`${s}C:/Users/me/My%20Clips/%E8%A7%86%E9%A2%91.mov`), { scope: 'session', sessionId: 'abc 123', path: 'C:/Users/me/My Clips/视频.mov' })
console.log('ok fileOf decodes')

// Every claimed suffix must be classified by the Host, or the tab would open and
// find nothing to draw.
const { EXTENSIONS } = await import('../lib/kinds.js')
const missing = mod.EXTENSIONS.filter((suffix) => !EXTENSIONS.includes(suffix))
assert.deepEqual(missing, [], `suffixes the Host does not classify: ${missing.join(' ')}`)
console.log('ok all', mod.EXTENSIONS.length, 'claimed suffixes are Host-classified')
