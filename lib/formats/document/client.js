export default function createPanel(services) {
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
}
