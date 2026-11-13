// GENERATED FILE — edit the sources, then run npm run build.
// Lazy chunk: fetched by lib/client.js the first time a document file is opened.
window.__ModuleLoader__.load({
  id: "dsh-preview-all",
  chunk: "client.document.js",
  factory: (require) => {
    // Source: lib/formats/document/client-css.js
    const css = ".dpa-doc{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}\n.dpa-doc>.dpa-notice{flex:0 0 auto;margin:8px 12px 0}";

    // Source: lib/formats/document/client.js
    const createPanel = function createPanel(services) {
      const { React, documentHtml } = services;
      const { createElement: h, useMemo } = React;

      // ---- document -----------------------------------------------------------

      function DocumentBody({ info, t }) {
        const doc = info.document ?? {};
        const title = doc.title ?? info.name ?? "";
        const src = useMemo(() => documentHtml(doc.html ?? "", title), [doc.html, title]);
        return h("div", { className: "dpa-doc" },
          // The Host cuts a very long document; the download link has the whole file.
          doc.truncated === true ? h("p", { className: "dpa-notice" }, t("documentTruncated")) : null,
          h("div", { className: "dpa-frame-wrap" },
            h("iframe", { className: "dpa-frame", sandbox: "", title, srcDoc: src })));
      }

      return DocumentBody;
    };

    return {
      kind: "document",
      css,
      createPanel,
    };
  },
});
