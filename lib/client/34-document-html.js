function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/** A standalone document around the Host's HTML fragment, for `srcDoc`. */
const DOCUMENT_CSS = `:root{color-scheme:light dark}
body{margin:0;padding:16px 18px;font:14px/1.7 -apple-system,"Segoe UI",system-ui,"Noto Sans CJK SC",sans-serif;color:#1c1c1e;background:#fff;overflow-wrap:break-word}
@media (prefers-color-scheme:dark){body{color:#e9e9ec;background:#1b1b1d}}
h1,h2,h3,h4{line-height:1.3;margin:1.1em 0 .5em}
h1{font-size:1.6em}h2{font-size:1.35em}h3{font-size:1.15em}
p{margin:.6em 0}
a{color:#2f7de1}
table{border-collapse:collapse;margin:.6em 0;max-width:100%}
td,th{border:1px solid rgba(128,128,128,.35);padding:4px 8px;vertical-align:top}
img{max-width:100%;height:auto}
pre{overflow:auto;padding:8px 10px;border-radius:6px;background:rgba(128,128,128,.15);font-size:12px}
blockquote{margin:.6em 0;padding:.1em 0 .1em 12px;border-left:3px solid rgba(128,128,128,.4);opacity:.9}
ul,ol{padding-left:1.4em}`;

function documentHtml(body, title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`
    + `<title>${escapeHtml(title)}</title><style>${DOCUMENT_CSS}</style></head>`
    + `<body>${body ?? ""}</body></html>`;
}

// ---- styles -------------------------------------------------------------
