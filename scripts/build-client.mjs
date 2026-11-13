/**
 * Build the DSH client bundles from native factories and shared fragments.
 *
 * Output, all flat in `lib/` because that is where the DSH loader looks:
 *
 *   client.js          the entry: tab registration, the shell, shared widgets.
 *                      Loaded with the page, so it carries no panel.
 *   client.<kind>.js   one lazy chunk per format group: its panel, plus the
 *                      group's optional private runtime and styles. Fetched
 *                      by the entry the first time such a file is opened.
 *
 * A group contributes through files in `lib/formats/<kind>/`:
 *
 *   client.js           required  default export `createPanel(services)`
 *   client-runtime.js   optional  default export `() => runtime`, handed to the
 *                                 panel as `services.runtime`
 *   client-css.js       optional  default export: a CSS string
 *
 * Factories are serialised with `.toString()`, so they must not close over
 * anything outside themselves. No bundler, no dependency.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FORMAT_DEFINITIONS } from '../lib/formats/catalog.js';
export { validateFormatDefinitions } from '../lib/formats/catalog.js';
import createImageBody from '../lib/client/image.js';
import migrateLegacyTabs from '../lib/client/legacy-tabs.js';

const ID = 'dsh-preview-all';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib');
const CLIENT_DIR = join(LIB, 'client');
const ENTRY = 'client.js';
const MARKER = '// GENERATED FILE — edit the sources, then run npm run build.';
/** What the DSH loader accepts as a package-local chunk; `client.node.*` is never served. */
const CHUNK_NAME = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

/** The file name of one group's panel chunk. */
export function chunkNameOf(kind) {
  return 'client.' + kind + '.js';
}

/** Import one of a group's client modules; `undefined` when the group has no such file. */
async function importPart(kind, file, required) {
  const path = join(LIB, 'formats', kind, file);
  if (!existsSync(path)) {
    if (required) throw new TypeError(kind + ' must provide ' + file);
    return undefined;
  }
  return (await import(pathToFileURL(path).href)).default;
}

const groups = await Promise.all(FORMAT_DEFINITIONS.map(async ({ kind }) => {
  const panel = await importPart(kind, 'client.js', true);
  const runtime = await importPart(kind, 'client-runtime.js', false);
  const css = await importPart(kind, 'client-css.js', false);
  if (typeof panel !== 'function') throw new TypeError(kind + '/client.js must export a panel factory');
  if (runtime !== undefined && typeof runtime !== 'function') throw new TypeError(kind + '/client-runtime.js must export a factory');
  if (css !== undefined && typeof css !== 'string') throw new TypeError(kind + '/client-css.js must export a string');
  return { kind, panel, runtime, css };
}));

function indent(text) {
  return text.split('\n').map(line => line === '' ? '' : '    ' + line).join('\n');
}

function wrap(header, chunk, prelude, sections) {
  return [
    MARKER,
    ...header,
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(ID) + ',',
    ...(chunk === undefined ? [] : ['  chunk: ' + JSON.stringify(chunk) + ',']),
    '  factory: (require) => {',
    ...prelude,
    sections.map(indent).join('\n\n'),
    '  },',
    '});',
    '',
  ].join('\n');
}

/** The entry bundle. Deterministic and in-memory; also used by the tests. */
export function buildClient() {
  // Only numbered files are shared fragments; native ESM factory modules are imported above.
  const fragments = readdirSync(CLIENT_DIR).filter(name => /^\d+-.*\.js$/.test(name)).sort();
  const part = name => '// Source: lib/client/' + name + '\n' + readFileSync(join(CLIENT_DIR, name), 'utf8').trimEnd();
  const order = name => Number(name.split('-')[0]);
  const sections = [
    '// Source: lib/formats/catalog.js\nconst FORMAT_DEFINITIONS = ' + JSON.stringify(FORMAT_DEFINITIONS, null, 2) + ';',
    ...fragments.filter(name => order(name) < 45).map(part),
    '// Source: lib/client/image.js\nconst ImageBody = (' + createImageBody.toString() + ')({ React, previewUrl, detailList });',
    '// What every panel factory receives. A chunk adds its own `runtime`.\nconst services = { React, previewUrl, messageForStatus, statusPanel, detailList, formatSize, documentHtml, ImageBody, basenameOfPath, stemOf };',
    part('45-registry.js'),
    '// Source: lib/client/legacy-tabs.js\n' + migrateLegacyTabs.toString(),
    ...fragments.filter(name => order(name) > 45).map(part),
  ];
  return wrap(
    ['// Entry bundle: no panel lives here; each one is a lazy chunk, client.<kind>.js.'],
    undefined,
    [
      '    const React = require("react");',
      '    const h = React.createElement;',
      '    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;',
    ],
    sections,
  );
}

/** One group's lazy chunk: self-contained, and handed the entry's services when its panel is created. */
export function buildChunk(kind) {
  const group = groups.find(candidate => candidate.kind === kind);
  if (group === undefined) throw new TypeError('Unknown format kind: ' + kind);
  const source = 'lib/formats/' + kind + '/';
  const sections = [];
  if (group.css !== undefined) sections.push('// Source: ' + source + 'client-css.js\nconst css = ' + JSON.stringify(group.css.trim()) + ';');
  if (group.runtime !== undefined) sections.push('// Source: ' + source + 'client-runtime.js\nconst runtime = (' + group.runtime.toString() + ')();');
  sections.push('// Source: ' + source + 'client.js\nconst createPanel = ' + group.panel.toString() + ';');
  sections.push('return {\n' + [
    '  kind: ' + JSON.stringify(kind) + ',',
    ...(group.css === undefined ? [] : ['  css,']),
    ...(group.runtime === undefined
      ? ['  createPanel,']
      : ['  runtime,', '  createPanel: (services) => createPanel({ ...services, runtime }),']),
  ].join('\n') + '\n};');
  return wrap(
    ['// Lazy chunk: fetched by lib/client.js the first time a ' + kind + ' file is opened.'],
    chunkNameOf(kind),
    [],
    sections,
  );
}

/** Every generated file, by its name in `lib/`. */
export function buildOutputs() {
  return Object.fromEntries([
    [ENTRY, buildClient()],
    ...groups.map(({ kind }) => [chunkNameOf(kind), buildChunk(kind)]),
  ]);
}

/** Chunks left in `lib/` by a group that no longer exists; the Host would still serve them. */
export function staleChunks(outputs = buildOutputs()) {
  return readdirSync(LIB).filter(name => CHUNK_NAME.test(name) && !name.startsWith('client.node.') && !(name in outputs));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outputs = buildOutputs();
  const stale = staleChunks(outputs);
  if (process.argv.includes('--check')) {
    const outdated = Object.entries(outputs).filter(([name, output]) => {
      try { return readFileSync(join(LIB, name), 'utf8') !== output; } catch { return true; /* Missing counts as stale. */ }
    }).map(([name]) => name);
    if (outdated.length > 0 || stale.length > 0) {
      for (const name of outdated) console.error('lib/' + name + ' is out of date');
      for (const name of stale) console.error('lib/' + name + ' belongs to no format group');
      console.error('run npm run build');
      process.exitCode = 1;
    } else console.log('client bundles are up to date (' + Object.keys(outputs).length + ' files)');
  } else {
    for (const name of stale) {
      // Only ever delete what this script wrote.
      if (!readFileSync(join(LIB, name), 'utf8').startsWith(MARKER)) {
        console.error('lib/' + name + ' belongs to no format group and was not generated here; remove it by hand');
        process.exitCode = 1;
        continue;
      }
      rmSync(join(LIB, name));
      console.log('removed lib/' + name);
    }
    for (const [name, output] of Object.entries(outputs)) {
      writeFileSync(join(LIB, name), output);
      console.log('wrote lib/' + name + ' (' + (Buffer.byteLength(output) / 1024).toFixed(1) + ' KB)');
    }
  }
}
