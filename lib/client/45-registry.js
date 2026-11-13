/** Sidebar suffixes are derived from the same format catalog the Host classifies with. */
const EXTENSIONS = [...new Set(FORMAT_DEFINITIONS.flatMap(({ extensions, unclaimedExtensions = [] }) =>
  extensions.filter(extension => !unclaimedExtensions.includes(extension))))].sort();
const EXTENSION_SET = new Set(EXTENSIONS);
const PATTERNS = [`dsh-resource://file/**/*.{${EXTENSIONS.join(',')}}`];

const KINDS = new Set(FORMAT_DEFINITIONS.map(({ kind }) => kind));
/** Kinds whose panel draws its own header instead of the shared name/size/download bar. */
const OWN_CHROME = new Set(FORMAT_DEFINITIONS.filter(({ ownChrome }) => ownChrome === true).map(({ kind }) => kind));
const KIND_BY_EXTENSION = new Map(FORMAT_DEFINITIONS.flatMap(({ kind, extensions }) =>
  extensions.map(extension => [extension, kind])));

/**
 * The kind a path's suffix implies. Only a hint for which panel to start
 * fetching: the Host has the final say and may answer with another kind.
 */
function kindHint(path) {
  const dot = String(path).lastIndexOf(".");
  return dot === -1 ? undefined : KIND_BY_EXTENSION.get(String(path).slice(dot + 1).toLowerCase());
}
