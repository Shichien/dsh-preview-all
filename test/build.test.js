import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FORMAT_DEFINITIONS } from '../lib/formats/catalog.js';
import { buildOutputs, chunkNameOf, staleChunks } from '../scripts/build-client.mjs';

const outputs = buildOutputs();
const onDisk = (name) => readFileSync(new URL('../lib/' + name, import.meta.url), 'utf8');

test('every generated bundle is up to date with its parts', () => {
  for (const [name, output] of Object.entries(outputs)) {
    assert.equal(onDisk(name), output, 'lib/' + name + ' is stale; run npm run build');
  }
  assert.deepEqual(staleChunks(outputs), [], 'chunks that belong to no format group; run npm run build');
});

test('there is one entry and one lazy chunk per format group', () => {
  assert.deepEqual(Object.keys(outputs).sort(), ['client.js', ...FORMAT_DEFINITIONS.map(({ kind }) => chunkNameOf(kind))].sort());
  // The names must satisfy the DSH loader, which also refuses `client.node.*`.
  for (const name of Object.keys(outputs)) {
    if (name === 'client.js') continue;
    assert.match(name, /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/);
    assert.ok(!name.startsWith('client.node.'));
  }
});

test('the entry carries no panel, and each chunk registers under its own name', () => {
  const entry = outputs['client.js'];
  assert.ok(!entry.includes('chunk:'), 'the entry must register as the package, not as a chunk');
  for (const { kind } of FORMAT_DEFINITIONS) {
    assert.ok(!entry.includes('lib/formats/' + kind + '/client'), kind + ' panel source leaked into the entry');
    const registrations = [];
    const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
    new Function('window', outputs[chunkNameOf(kind)])(window);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, 'dsh-preview-all');
    assert.equal(registrations[0].chunk, chunkNameOf(kind));
    // A chunk is self-contained: it must materialise without requiring anything.
    const exports = registrations[0].factory(() => { throw new Error('a chunk must not require modules'); });
    assert.equal(exports.kind, kind);
    assert.equal(typeof exports.createPanel, 'function');
  }
});

test('the entry is small because the player travels in the media chunk', () => {
  const entry = outputs['client.js'];
  const media = outputs[chunkNameOf('media')];
  assert.ok(!entry.includes('dvp-'), 'player styles belong to the media chunk');
  assert.ok(media.includes('.dvp-root'));
  assert.ok(Buffer.byteLength(entry) < 48 * 1024, 'entry grew past 48 KB: ' + Buffer.byteLength(entry));
});
