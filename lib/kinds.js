/** Classification and sidebar claims derived from the shared format catalog. */
import { FORMAT_DEFINITIONS } from './formats/catalog.js';
import { extensionOf } from './shared/path.js';

export const RECOGNIZED_EXTENSIONS = Object.freeze([...new Set(FORMAT_DEFINITIONS.flatMap(({ extensions }) => extensions))].sort());
export const CLAIMED_EXTENSIONS = Object.freeze([...new Set(FORMAT_DEFINITIONS.flatMap(({ extensions, unclaimedExtensions = [] }) => extensions.filter(extension => !unclaimedExtensions.includes(extension))))].sort());
/** Compatibility name: suffixes claimed by the sidebar. */
export const EXTENSIONS = CLAIMED_EXTENSIONS;
const KIND_OF = new Map();
const COMPOUND = [];
for (const { kind, extensions, compoundExtensions = [] } of FORMAT_DEFINITIONS) {
  for (const suffix of [...extensions, ...compoundExtensions]) KIND_OF.set(suffix, kind);
  COMPOUND.push(...compoundExtensions);
}
COMPOUND.sort((a, b) => b.length - a.length);

export function suffixOf(path) {
  const base = String(path).replaceAll('\\', '/').split('/').pop().toLowerCase();
  for (const compound of COMPOUND) {
    if (base.endsWith('.' + compound)) return compound;
  }
  return extensionOf(path);
}

export function kindOf(path) {
  return KIND_OF.get(suffixOf(path));
}

export function isPreviewable(path) {
  return kindOf(path) !== undefined;
}
