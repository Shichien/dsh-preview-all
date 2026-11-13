import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FORMAT_DEFINITIONS } from '../lib/formats/catalog.js';
import { ROUTE_NAMES, loadFormat, loadRoute } from '../lib/formats/index.js';
import { CLAIMED_EXTENSIONS, RECOGNIZED_EXTENSIONS, kindOf, suffixOf } from '../lib/kinds.js';
import { buildChunk, buildClient, validateFormatDefinitions } from '../scripts/build-client.mjs';
import createMediaRuntime from '../lib/formats/media/client-runtime.js';
import createImageBody from '../lib/client/image.js';

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: initial => ({ current: initial }),
  useMemo: fn => fn(), useCallback: fn => fn,
  useEffect: () => {}, useLayoutEffect: () => {},
};
function clientApi() {
  let api;
  vm.runInNewContext(buildClient(), {
    window: { __ModuleLoader__: { load: ({ factory }) => { api = factory(() => React); } } },
    URL,
  });
  return api;
}

test('catalog maps every recognized suffix and host handler without duplicate ownership', async () => {
  const kinds = new Set();
  const suffixes = new Set();
  const routes = new Set(['info', 'download']);
  for (const definition of FORMAT_DEFINITIONS) {
    assert.ok(!kinds.has(definition.kind));
    kinds.add(definition.kind);
    const format = await loadFormat(definition.kind);
    assert.equal(typeof format.describe, 'function');
    assert.equal(format.definition, definition);
    assert.deepEqual(Object.keys(format.routes).sort(), Object.keys(definition.routes).sort());
    for (const suffix of [...definition.extensions, ...(definition.compoundExtensions ?? [])]) {
      assert.ok(!suffixes.has(suffix), 'duplicate suffix ' + suffix);
      suffixes.add(suffix);
      assert.equal(kindOf('FILE.' + suffix.toUpperCase()), definition.kind);
    }
    for (const route of Object.keys(definition.routes)) {
      assert.ok(!routes.has(route), 'duplicate route ' + route);
      routes.add(route);
      const loaded = await loadRoute(route);
      assert.equal(loaded.format, format);
      assert.equal(typeof loaded.handler, 'function');
    }
    for (const excluded of definition.unclaimedExtensions ?? []) {
      assert.ok(definition.extensions.includes(excluded));
    }
  }
  assert.deepEqual([...ROUTE_NAMES].sort(), [...routes].filter(route => !['info','download'].includes(route)).sort());
  assert.equal(await loadRoute('no-such-route'), undefined);
  await assert.rejects(loadFormat('no-such-kind'), TypeError);
});

test('sidebar claims and routes match catalog while ts/mts remain host-recognized', () => {
  const api = clientApi();
  assert.deepEqual(Array.from(api.EXTENSIONS), CLAIMED_EXTENSIONS);
  for (const extension of CLAIMED_EXTENSIONS) assert.equal(api.hasSuffix('file.' + extension), true);
  for (const extension of ['ts', 'mts']) {
    assert.ok(RECOGNIZED_EXTENSIONS.includes(extension));
    assert.ok(!CLAIMED_EXTENSIONS.includes(extension));
    assert.equal(kindOf('file.' + extension), 'media');
    assert.equal(api.hasSuffix('file.' + extension), false);
    assert.ok(!api.PATTERNS[0].slice(api.PATTERNS[0].indexOf('{') + 1, -1).split(',').includes(extension));
  }
  assert.deepEqual(Object.keys(api.ROUTES).sort(), ['info','download', ...ROUTE_NAMES].sort());
  for (const [route, path] of Object.entries(api.ROUTES)) assert.equal(path, 'preview/' + route);
});

test('compound archive suffixes classify before final extension on both path styles', () => {
  const archive = FORMAT_DEFINITIONS.find(({ kind }) => kind === 'archive');
  for (const suffix of archive.compoundExtensions) {
    for (const path of ['C:\\folder\\FILE.' + suffix.toUpperCase(), '/folder/file.' + suffix]) {
      assert.equal(suffixOf(path), suffix);
      assert.equal(kindOf(path), 'archive');
    }
  }
  assert.equal(kindOf('/folder.tar.gz/plain.txt'), undefined);
  assert.equal(kindOf('plain.unknown'), undefined);
});

test('all catalog panels import natively and render from isolated serialized factories', async () => {
  const revive = factory => vm.runInNewContext('(' + factory.toString() + ')');
  const services = {
    React, previewUrl: (_base, route) => 'https://example.test/' + route,
    messageForStatus: String, statusPanel: text => text, detailList: rows => rows,
    formatSize: String, documentHtml: html => html, basenameOfPath: path => path.split('/').pop(), stemOf: name => name,
    runtime: revive(createMediaRuntime)(),
  };
  services.ImageBody = revive(createImageBody)(services);
  const props = { tab: {}, file: { path: 'test.mp4' }, base: 'https://example.test/', info: {}, t: key => key };
  assert.ok(services.ImageBody({ ...props, route: 'raster', detailsKey: 'raster', failureKey: 'rasterFailed' }));
  for (const { kind } of FORMAT_DEFINITIONS) {
    const { default: factory } = await import('../lib/formats/' + kind + '/client.js');
    assert.equal(typeof factory, 'function');
    for (const create of [factory, revive(factory)]) assert.ok(create(services)(props));
  }
  assert.equal(services.runtime.clampRate(99), 4);
  assert.equal(services.runtime.formatTime(3661), '1:01:01');
  assert.equal(services.runtime.keyCommand({ key: 'ArrowLeft', ctrlKey: true }).arg, -30);
});

/**
 * Evaluate the generated bundles under a stand-in for the DSH loader: the
 * entry's `require.async("./client.<kind>.js")` evaluates that chunk on demand
 * and records the request.
 */
function lazyClient({ failing = new Set() } = {}) {
  const requested = [];
  const registered = new Map();
  const loader = { load: (registration) => registered.set(registration.chunk ?? 'entry', registration) };
  const sandbox = { window: { __ModuleLoader__: loader }, URL };
  const require = () => React;
  require.async = async (spec) => {
    requested.push(spec);
    const name = spec.slice(2);
    if (failing.has(name)) throw new Error('chunk unavailable');
    const kind = name.slice('client.'.length, -'.js'.length);
    vm.runInNewContext(buildChunk(kind), sandbox);
    return registered.get(name).factory(() => { throw new Error('a chunk must not require modules'); });
  };
  vm.runInNewContext(buildClient(), sandbox);
  return { api: registered.get('entry').factory(require), requested, failing };
}

test('panels load on demand: nothing at startup, one chunk per kind, fetched once', async () => {
  const { api, requested } = lazyClient();
  assert.deepEqual(requested, [], 'materialising the entry must not fetch a panel');
  const props = { tab: {}, file: { path: 'a.zip' }, base: 'https://example.test/', info: {}, t: key => key };

  const Archive = await api.loadPanel('archive');
  assert.deepEqual(requested, ['./client.archive.js']);
  assert.ok(Archive(props));
  assert.equal(await api.loadPanel('archive'), Archive, 'a loaded panel is reused');
  assert.deepEqual(requested, ['./client.archive.js']);

  // Concurrent tabs of one kind share a single request.
  const [first, second] = await Promise.all([api.loadPanel('media'), api.loadPanel('media')]);
  assert.equal(first, second);
  assert.deepEqual(requested, ['./client.archive.js', './client.media.js']);

  // A kind the catalog does not know renders as the binary card.
  assert.equal(await api.loadPanel('mystery'), await api.loadPanel('binary'));
  assert.deepEqual(requested.slice(2), ['./client.binary.js']);
});

test('a panel that fails to load is retried on the next request', async () => {
  const { api, requested, failing } = lazyClient({ failing: new Set(['client.font.js']) });
  await assert.rejects(api.loadPanel('font'), /chunk unavailable/);
  failing.clear();
  assert.equal(typeof await api.loadPanel('font'), 'function');
  assert.deepEqual(requested, ['./client.font.js', './client.font.js']);
});

test('the suffix hint names the chunk to prefetch for every claimed suffix', () => {
  const { api } = lazyClient();
  for (const extension of CLAIMED_EXTENSIONS) {
    assert.equal(api.kindHint('C:/dir.v2/FILE.' + extension.toUpperCase()), kindOf('file.' + extension));
  }
  assert.equal(api.kindHint('backup.tar.gz'), 'archive');
  assert.equal(api.kindHint('no-suffix'), undefined);
  assert.equal(api.kindHint('plain.unknown'), undefined);
});


test('catalog validation rejects unsafe names, collisions and unknown exclusions', () => {
  const valid = { kind: 'example', extensions: ['example'], routes: { example: 'serve' } };
  assert.doesNotThrow(() => validateFormatDefinitions([valid]));
  for (const patch of [
    { kind: '../example' }, { routes: { '../example': 'serve' } },
    { routes: { info: 'serve' } }, { unclaimedExtensions: ['unknown'] },
    { compoundExtensions: ['example'] },
    { kind: 'node' }, { ownChrome: 'yes' }, { buffersWholeFile: 1 },
  ]) assert.throws(() => validateFormatDefinitions([{ ...valid, ...patch }]), TypeError);
  assert.throws(() => validateFormatDefinitions([valid, { ...valid }]), TypeError);
  assert.throws(() => validateFormatDefinitions([valid, { ...valid, kind: 'other', routes: {} }]), TypeError);
});
