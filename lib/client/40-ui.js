// ---- shared panel pieces ------------------------------------------------

function statusPanel(text, action) {
  return h("div", { className: "dpa-status" },
    h("p", { style: { margin: 0 } }, text),
    action ?? null);
}

function detailList(rows) {
  const shown = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (shown.length === 0) return null;
  return h("dl", { className: "dpa-dl" },
    ...shown.flatMap(([label, value]) => [
      h("dt", { key: `t-${label}` }, label),
      h("dd", { key: `d-${label}` }, String(value)),
    ]));
}

function headerBar(info, file, base, t, onReload) {
  return h("div", { className: "dpa-bar" },
    h("span", { className: "dpa-name", title: info.path ?? info.name }, info.name ?? ""),
    info.sizeLabel === undefined ? null : h("span", { className: "dpa-size" }, info.sizeLabel),
    h("span", { className: "dpa-grow" }),
    h("button", { type: "button", className: "dpa-link", onClick: onReload }, t("reload")),
    h("a", { className: "dpa-link", href: previewUrl(base, "download", file), download: info.name ?? "" }, t("download")));
}
