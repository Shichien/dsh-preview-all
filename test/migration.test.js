import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import migrateLegacyTabs from '../lib/client/legacy-tabs.js'

const prefix = 'dsh.sidebar-right.v1.'
const marker = 'dsh-video-preview:tabs-migrated'
const legacy = () => ({
  activeSession: 's', extra: { keep: true },
  bySession: { s: { layout: { activeTab: 'old', tabs: {
    old: { kind: 'video-preview', address: 'file.mp4', custom: [1, 2] },
    other: { kind: 'text', address: 'file.txt' },
  } } }, empty: null },
})
const record = () => JSON.stringify(legacy())
function memoryStorage(entries) {
  const values = new Map(entries)
  const writes = []
  return {
    values, writes,
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { writes.push(key); values.set(key, String(value)) },
  }
}
function assertMigrated(storage, key, kind = 'preview-all') {
  const expected = legacy()
  expected.bySession.s.layout.tabs.old.kind = kind
  assert.deepEqual(JSON.parse(storage.values.get(key)), expected)
}

test('serialized helper is self-contained, scoped to v1, and preserves unrelated state', () => {
  const key = prefix + 'workspace'
  const storage = memoryStorage([[key, record()], ['dsh.sidebar-right.v2.workspace', record()], ['other', record()], [marker, '1']])
  const serialized = vm.runInNewContext(`(${migrateLegacyTabs.toString()})`)
  serialized(storage, 'custom-preview')
  assertMigrated(storage, key, 'custom-preview')
  assert.equal(storage.values.get('dsh.sidebar-right.v2.workspace'), record())
  assert.equal(storage.values.get('other'), record())
  assert.equal(storage.values.get(marker), '1')
  assert.deepEqual(storage.writes, [key])
})

test('malformed item does not prevent migrating a following valid item', () => {
  const bad = prefix + 'bad', good = prefix + 'good'
  const storage = memoryStorage([[bad, '{broken'], [good, record()]])
  migrateLegacyTabs(storage)
  assert.equal(storage.values.get(bad), '{broken')
  assertMigrated(storage, good)
  assert.equal(storage.values.has(marker), false)
  storage.values.set(bad, record())
  migrateLegacyTabs(storage)
  assertMigrated(storage, bad)
  assert.deepEqual(storage.writes, [good, bad])
})

test('denied getItem and key failures are isolated per item', () => {
  for (const operation of ['getItem', 'key']) {
    const bad = prefix + 'bad', good = prefix + 'good'
    const storage = memoryStorage([[bad, record()], [good, record()]])
    const original = storage[operation]
    storage[operation] = function (arg) {
      if (arg === bad || arg === 0) throw new Error('denied')
      return original.call(this, arg)
    }
    assert.doesNotThrow(() => migrateLegacyTabs(storage))
    assert.equal(storage.values.get(bad), record())
    assertMigrated(storage, good)
    assert.deepEqual(storage.writes, [good])
  }
})

test('unavailable storage and throwing storage access are tolerated', () => {
  for (const storage of [undefined, null, { get length() { throw new Error('denied') } },
    new Proxy({}, { get() { throw new Error('denied') } })]) {
    assert.doesNotThrow(() => migrateLegacyTabs(storage))
  }
})

test('partial write failure retries without rewriting successes; completed runs are idempotent', () => {
  const bad = prefix + 'bad', good = prefix + 'good'
  const storage = memoryStorage([[bad, record()], [good, record()]])
  const original = storage.setItem
  let denied = true
  storage.setItem = function (key, value) {
    if (key === bad && denied) throw new Error('quota')
    original.call(this, key, value)
  }
  migrateLegacyTabs(storage)
  assert.equal(storage.values.get(bad), record())
  assertMigrated(storage, good)
  assert.equal(storage.values.has(marker), false)
  denied = false
  migrateLegacyTabs(storage)
  migrateLegacyTabs(storage)
  assertMigrated(storage, bad)
  assert.deepEqual(storage.writes, [good, bad])
  // A backup restored after completion must still be migrated, including an
  // existing key reverted to its legacy value.
  storage.values.set(bad, record())
  storage.values.set(prefix + 'restored', record())
  migrateLegacyTabs(storage)
  assertMigrated(storage, bad)
  assertMigrated(storage, prefix + 'restored')
  assert.deepEqual(storage.writes, [good, bad, bad, prefix + 'restored'])
})

test('initialization still registers tab effects when localStorage getter throws', () => {
  const effects = []
  const context = vm.createContext({
    migrateLegacyTabs, ID: 'dsh-preview-all', NS: 'dsh-preview-all',
    get localStorage() { throw new Error('SecurityError') },
  })
  vm.runInContext(readFileSync(new URL('../lib/client/60-apply.js', import.meta.url), 'utf8'), context)
  context.apply({ locale: { bind: () => () => '' }, effect: (callback, name) => effects.push(name) })
  assert.deepEqual(effects, [
    'dsh-preview-all: styles', 'dsh-preview-all: dictionaries',
    'dsh-preview-all: tab type', 'dsh-preview-all: tab body',
  ])
})

test('every kind this plugin used before the rename is rewritten; the current one is not', () => {
  const key = prefix + 'kinds'
  const state = legacy()
  state.bySession.s.layout.tabs.old.kind = 'preview-all-in-one'
  state.bySession.s.layout.tabs.current = { kind: 'preview-all', address: 'file.mp4' }
  const storage = memoryStorage([[key, JSON.stringify(state)]])
  migrateLegacyTabs(storage)
  const tabs = JSON.parse(storage.values.get(key)).bySession.s.layout.tabs
  assert.equal(tabs.old.kind, 'preview-all')
  assert.equal(tabs.current.kind, 'preview-all')
  assert.deepEqual(storage.writes, [key])
})
