const inject = ["slots", "locale", "sidebarRightTabs"];

function apply(ctx) {
  try {
    migrateLegacyTabs(globalThis.localStorage);
  } catch {
    // Accessing localStorage itself can throw; tab registration must still run.
  }
  const t = ctx.locale.bind(NS);
  ctx.effect(() => {
    // One stylesheet for every preview tab, removed when the plugin unloads.
    // It starts with the shared rules; each panel chunk appends its own.
    const style = document.createElement("style");
    style.dataset.dshPreviewAllInOne = "";
    style.textContent = CSS + chunkStyles.join("");
    document.head.appendChild(style);
    styleElement = style;
    return () => {
      style.remove();
      if (styleElement === style) styleElement = undefined;
    };
  }, "dsh-preview-all-in-one: styles");
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-preview-all-in-one: dictionaries");
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: KIND,
    patterns: PATTERNS,
    priority: "extension",
    canOpen: (address) => {
      const file = fileOf(address);
      return file !== undefined && hasSuffix(file.path);
    },
    title: basenameOf,
    keepMounted: true,
  }), "dsh-preview-all-in-one: tab type");
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: ID,
    locale: NS,
    inject: () => ({ t }),
  }, PreviewBody)), "dsh-preview-all-in-one: tab body");
}
