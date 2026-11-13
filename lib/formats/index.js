/**
 * Format handlers, loaded on first use.
 *
 * The catalog is pure data, so the route table and the classification are
 * known without importing a single parser. A group's Host module — and the
 * parsers it pulls in — is imported the first time a file of that kind is
 * described or one of its routes is hit, then kept for the process lifetime.
 * Opening a video therefore never loads the 7z reader or the TIFF decoder.
 *
 * `describe` receives `{ ctx, target, size, path, signal, suffix, base }`:
 * the already-opened file and the classification its payload is merged into.
 * Route handlers receive `{ ctx, req, res, url, sessionId, path, signal }`.
 */
import { FORMAT_DEFINITIONS } from './catalog.js'

const definitions = new Map(FORMAT_DEFINITIONS.map((definition) => [definition.kind, definition]))

/** Route name → the group that owns it. Known from the catalog alone. */
const owners = new Map()
for (const { kind, routes = {} } of FORMAT_DEFINITIONS) {
  for (const route of Object.keys(routes)) owners.set(route, kind)
}

/** Every format-owned sub-route, without loading its handler. */
export const ROUTE_NAMES = Object.freeze([...owners.keys()])

/** kind → Promise of its loaded format. */
const loading = new Map()

function requireHandler(module, name, kind) {
  if (typeof module[name] !== 'function') throw new TypeError(`Format ${kind} must export ${name} as a function`)
  return module[name]
}

/**
 * Import one group's Host module and check it against its manifest.
 * @param {string} kind
 * @returns {Promise<{ kind: string, definition: any, describe: Function, typeOf?: Function, routes: Record<string, Function> }>}
 */
export function loadFormat(kind) {
  let pending = loading.get(kind)
  if (pending === undefined) {
    const definition = definitions.get(kind)
    if (definition === undefined) return Promise.reject(new TypeError(`Unknown format kind: ${kind}`))
    pending = import(`./${kind}/index.js`).then((module) => {
      const routes = Object.create(null)
      for (const [route, name] of Object.entries(definition.routes ?? {})) {
        routes[route] = requireHandler(module, name, kind)
      }
      const format = { kind, definition, describe: requireHandler(module, 'describe', kind), routes: Object.freeze(routes) }
      if (module.downloadTypeOf !== undefined) format.typeOf = requireHandler(module, 'downloadTypeOf', kind)
      return Object.freeze(format)
    })
    // A failed import must not poison the kind forever.
    pending.catch(() => loading.delete(kind))
    loading.set(kind, pending)
  }
  return pending
}

/**
 * Resolve a format-owned sub-route, loading its group on first use.
 * @param {string} name
 * @returns {Promise<{ format: any, handler: Function } | undefined>}
 */
export async function loadRoute(name) {
  const kind = owners.get(name)
  if (kind === undefined) return undefined
  const format = await loadFormat(kind)
  return { format, handler: format.routes[name] }
}

/** Kinds whose Host module has been requested so far; for tests and diagnostics. */
export function loadedKinds() {
  return [...loading.keys()]
}
