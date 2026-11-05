// Drives the host route over a real HTTP server with stub services: the
// filesystem stub reads through node:fs the way the local backend does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { apply, ROUTE } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'video-preview-'))
const bytes = Buffer.alloc(3 * 1024 * 1024 + 123)
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
writeFileSync(join(dir, 'clip.mp4'), bytes)
writeFileSync(join(dir, 'secret.txt'), 'no')

let route
let authorized = true
const fs = {
  async resolve(path, { cwd }) {
    const abs = isAbsolute(path) ? path : resolve(cwd, path)
    return { targetKey: abs, displayPath: abs }
  },
  async stat(target) {
    try {
      const s = await stat(target.targetKey)
      return { type: s.isFile() ? 'file' : 'directory', size: s.size, version: String(s.mtimeMs) }
    } catch {
      return undefined
    }
  },
  async readByteRange(target, { offset, length }) {
    const handle = await open(target.targetKey, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, offset)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    } finally {
      await handle.close()
    }
  },
}
const ctx = {
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: { register: (r) => { route = r; return () => {} } },
  connection: { requestRejection: () => (authorized ? undefined : 401) },
  fs,
  sessions: { get: (id) => (id === 's1' ? { header: { cwd: dir } } : undefined) },
  sandboxPolicy: { workspaceRoot: dir },
}
apply(ctx)

const server = createServer((req, res) => route.handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}${ROUTE}`
const url = (path, session = 's1') => `${base}?sessionId=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`

test.after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

test('registers a prefix route', () => {
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE)
})

test('full GET streams every byte across windows', async () => {
  const res = await fetch(url('clip.mp4'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  assert.equal(res.headers.get('accept-ranges'), 'bytes')
  assert.equal(res.headers.get('content-length'), String(bytes.length))
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes))
})

test('Range GET answers 206 with the exact slice', async () => {
  const start = 1024 * 1024 - 7
  const end = 2 * 1024 * 1024 + 9
  const res = await fetch(url('clip.mp4'), { headers: { range: `bytes=${start}-${end}` } })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(start, end + 1)))
})

test('absolute paths and HEAD', async () => {
  const res = await fetch(url(join(dir, 'clip.mp4')), { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), String(bytes.length))
})

test('unsatisfiable range answers 416', async () => {
  const res = await fetch(url('clip.mp4'), { headers: { range: `bytes=${bytes.length}-` } })
  assert.equal(res.status, 416)
  assert.equal(res.headers.get('content-range'), `bytes */${bytes.length}`)
})

test('download=1 adds an attachment disposition', async () => {
  const res = await fetch(`${url('clip.mp4')}&download=1`, { method: 'HEAD' })
  assert.match(res.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''clip\.mp4$/)
})

test('refusals', async () => {
  assert.equal((await fetch(url('secret.txt'))).status, 415)
  assert.equal((await fetch(url('missing.mp4'))).status, 404)
  assert.equal((await fetch(`${base}?path=clip.mp4`)).status, 400)
  assert.equal((await fetch(url('clip.mp4'), { method: 'POST' })).status, 405)
  authorized = false
  try {
    assert.equal((await fetch(url('clip.mp4'))).status, 401)
  } finally {
    authorized = true
  }
})
