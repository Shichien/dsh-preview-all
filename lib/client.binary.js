// GENERATED FILE — edit the sources, then run npm run build.
// Lazy chunk: fetched by lib/client.js the first time a binary file is opened.
window.__ModuleLoader__.load({
  id: "dsh-preview-all-in-one",
  chunk: "client.binary.js",
  factory: (require) => {
    // Source: lib/formats/binary/client.js
    const createPanel = function createPanel(services) {
      const { React, detailList } = services;
      const { createElement: h } = React;

      // ---- binary -------------------------------------------------------------

      function BinaryBody({ info, t }) {
        const binary = info.binary ?? {};
        return h("div", { className: "dpa-body" },
          info.notice ? h("p", { className: "dpa-notice" }, info.notice) : null,
          binary.summary ? h("p", { className: "dpa-summary" }, binary.summary) : h("p", { className: "dpa-empty" }, t("binaryUnviewable")),
          detailList([
            [t("binaryInfo"), binary.format],
            [t("fontFormat"), binary.kind],
            [t("binarySize"), info.sizeLabel],
            ...(binary.details ?? []),
          ]),
          info.hex ? h("div", { className: "dpa-section" }, t("binaryHex")) : null,
          info.hex ? h("pre", { className: "dpa-pre" }, info.hex) : null);
      }

      return BinaryBody;
    };

    return {
      kind: "binary",
      createPanel,
    };
  },
});
