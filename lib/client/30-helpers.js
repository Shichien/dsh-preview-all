function fileOf(address) {
  try {
    if (typeof address !== "string" || !address.startsWith(FILE_PREFIX)) return undefined;
    const end = address.search(/[?#]/);
    const parts = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end).split("/");
    const scope = parts[0];
    if (scope === "session") {
      const id = parts[1];
      const segments = parts.slice(2);
      if (id === undefined || id === "" || segments.length === 0) return undefined;
      const path = segments.map(decodeURIComponent).join("/");
      if (path === "") return undefined;
      return { scope: "session", sessionId: decodeURIComponent(id), path };
    }
    if (scope === "absolute") {
      const tail = parts.slice(1);
      const unc = tail[0] === "" && tail.length > 1;
      const segments = (unc ? tail.slice(1) : tail).map(decodeURIComponent);
      if (segments.length === 0 || segments[0] === "") return undefined;
      if (unc) return { scope: "absolute", path: `//${segments.join("/")}` };
      const path = /^[A-Za-z]:$/.test(segments[0]) ? segments.join("/") : `/${segments.join("/")}`;
      return { scope: "absolute", path };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Whether the path ends in a suffix this plugin claims. */
function hasSuffix(path) {
  const name = String(path).replaceAll("\\", "/");
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return EXTENSION_SET.has(base.slice(dot + 1).toLowerCase());
}

function basenameOfPath(path) {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function basenameOf(address) {
  const file = fileOf(address);
  return file === undefined ? String(address) : basenameOfPath(file.path);
}

function stemOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Directory base for a route, keeping any reverse-proxy prefix. */
function directoryBase(base) {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/**
 * Base the preview routes resolve against. In a browser the page base is the
 * Host itself; in the desktop shell `dsh-app://app/` forwards to the Host.
 * Staying same-origin keeps the login cookie and an untainted canvas for
 * screenshots.
 */
function pageBase() {
  return typeof document !== "undefined" && document.baseURI ? directoryBase(document.baseURI) : undefined;
}

/**
 * Build one preview URL. `sessionId` is only sent for session-scoped
 * addresses; an absolute one must stand on its own.
 */
function previewUrl(base, route, file, extra) {
  const url = new URL(ROUTES[route], base);
  if (file.sessionId !== undefined) url.searchParams.set("sessionId", file.sessionId);
  url.searchParams.set("path", file.path);
  for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value);
  return url.href;
}

function messageForStatus(status, t) {
  if (status === 401) return t("unauthorized");
  if (status === 403) return t("forbidden");
  if (status === 404) return t("notFound");
  if (status === 413) return t("tooLarge");
  return `${t("failed")} (HTTP ${status})`;
}
