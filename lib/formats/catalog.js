/** Pure-data format catalog; the sole ordered list of supported format groups. */
import media from './media/manifest.js';
import archive from './archive/manifest.js';
import font from './font/manifest.js';
import raster from './raster/manifest.js';
import picture from './picture/manifest.js';
import document from './document/manifest.js';
import binary from './binary/manifest.js';

export const FORMAT_DEFINITIONS = Object.freeze([media, archive, font, raster, picture, document, binary]);

/** Optional switches a manifest may set; anything else under these names is a typo. */
const FLAGS = ['buffersWholeFile', 'ownChrome'];

/** Reject ambiguous ownership and unsafe module/route names before importing host handlers or panels. */
export function validateFormatDefinitions(definitions) {
  const kinds = new Set();
  const suffixes = new Set();
  const routes = new Set(['info', 'download']);
  for (const definition of definitions) {
    const { kind, extensions, compoundExtensions = [], unclaimedExtensions = [], routes: handlers } = definition;
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(kind) || kinds.has(kind)) throw new TypeError('Invalid or duplicate format kind: ' + kind);
    // The kind names the panel chunk `client.<kind>.js`, and the Host never serves `client.node.js`.
    if (kind === 'node') throw new TypeError('Reserved format kind: ' + kind);
    kinds.add(kind);
    for (const flag of FLAGS) {
      if (definition[flag] !== undefined && typeof definition[flag] !== 'boolean') throw new TypeError('Invalid ' + flag + ': ' + kind);
    }
    if (!Array.isArray(extensions) || !Array.isArray(compoundExtensions) || !Array.isArray(unclaimedExtensions)) throw new TypeError('Invalid suffix lists: ' + kind);
    for (const suffix of [...extensions, ...compoundExtensions]) {
      if (typeof suffix !== 'string' || !/^[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(suffix) || suffixes.has(suffix)) throw new TypeError('Invalid or duplicate suffix: ' + suffix);
      suffixes.add(suffix);
    }
    for (const suffix of unclaimedExtensions) {
      if (!extensions.includes(suffix)) throw new TypeError('Unclaimed suffix must be recognized: ' + suffix);
    }
    if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) throw new TypeError('Invalid routes: ' + kind);
    for (const route of Object.keys(handlers)) {
      if (!/^[a-z][a-z0-9-]*$/.test(route) || routes.has(route)) throw new TypeError('Invalid or duplicate route: ' + route);
      routes.add(route);
    }
  }
}

validateFormatDefinitions(FORMAT_DEFINITIONS);

