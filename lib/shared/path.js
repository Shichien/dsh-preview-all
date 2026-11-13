/** Lowercased final extension, supporting either path separator. */
export function extensionOf(path) {
  const name = String(path).replaceAll('\\', '/').split('/').pop();
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}
