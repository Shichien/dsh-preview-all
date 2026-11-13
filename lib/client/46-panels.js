// ---- panels, loaded on demand ---------------------------------------------
//
// The entry bundle carries no panel. Each format's panel, with its private
// runtime and styles, is its own chunk `client.<kind>.js`, fetched the first
// time a file of that kind is opened and kept for the lifetime of the page.

/** kind → Promise of its panel component. */
const panelLoads = new Map();
/** Styles that arrived with chunks; `apply` puts them in the plugin's stylesheet. */
const chunkStyles = [];
/** The live stylesheet element while the plugin is applied. */
let styleElement;

/**
 * Load one kind's panel. An unknown kind gets the binary panel. A failed load
 * is forgotten, so the tab's reload button retries it.
 */
function loadPanel(kind) {
  const name = KINDS.has(kind) ? kind : "binary";
  let pending = panelLoads.get(name);
  if (pending === undefined) {
    pending = Promise.resolve()
      .then(() => require.async(`./client.${name}.js`))
      .then((chunk) => {
        if (typeof chunk.css === "string" && chunk.css !== "") {
          chunkStyles.push(chunk.css);
          if (styleElement !== undefined) styleElement.textContent += chunk.css;
        }
        return chunk.createPanel(services);
      });
    pending.catch(() => {
      if (panelLoads.get(name) === pending) panelLoads.delete(name);
    });
    panelLoads.set(name, pending);
  }
  return pending;
}
