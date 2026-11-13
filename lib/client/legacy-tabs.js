/**
 * Rewrite legacy tab kinds without depending on the client bundle's scope.
 * The build injects this function via toString(), so keep every dependency inside it.
 */
export default function migrateLegacyTabs(storage, newKind = 'preview-all-in-one') {
  // This is a private sidebar persistence format, not its public tabs API.
  // Only the exact v1 prefix/layout below is understood; future versions must
  // be reviewed explicitly rather than swept into this migration.
  const prefix = 'dsh.sidebar-right.v1.';
  // No completion marker: scan each initialization, writing only changed records.
  // Ignore (and preserve) the old dsh-video-preview:tabs-migrated marker so failed
  // writes and legacy records restored after a successful run remain retryable.
  try {
    const length = storage.length;
    for (let index = 0; index < length; index += 1) {
      try {
        const key = storage.key(index);
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        const state = JSON.parse(storage.getItem(key));
        let changed = false;
        for (const session of Object.values(state?.bySession ?? {})) {
          for (const tab of Object.values(session?.layout?.tabs ?? {})) {
            if (tab?.kind === 'video-preview' && tab.kind !== newKind) {
              tab.kind = newKind;
              changed = true;
            }
          }
        }
        if (changed) storage.setItem(key, JSON.stringify(state));
      } catch {
        // A malformed/denied record must not block the other sessions. Leave its
        // stored value intact and retry on the next initialization.
      }
    }
  } catch {
    // Storage itself (including length access) may be unavailable or restricted.
  }
}
