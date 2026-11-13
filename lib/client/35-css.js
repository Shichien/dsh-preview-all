const CSS = `
.dpa-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;font-size:13px;color:inherit}
.dpa-bar{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;padding:7px 12px;border-bottom:1px solid rgba(128,128,128,.22)}
.dpa-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%}
.dpa-size{opacity:.6;font-variant-numeric:tabular-nums;font-size:12px}
.dpa-grow{flex:1 1 auto}
.dpa-link{background:none;border:none;padding:0;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;opacity:.85}
.dpa-link:hover{opacity:1}
.dpa-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;box-sizing:border-box}
.dpa-notice{margin:0 0 10px;padding:8px 10px;border-radius:6px;background:rgba(214,158,46,.14);border:1px solid rgba(214,158,46,.42);line-height:1.6}
.dpa-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;box-sizing:border-box;text-align:center;line-height:1.65;opacity:.85}
.dpa-button{padding:4px 12px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:rgba(128,128,128,.12);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dpa-button:hover{background:rgba(128,128,128,.22)}
.dpa-list{display:flex;flex-direction:column}
.dpa-row{display:flex;gap:8px;align-items:baseline;width:100%;padding:4px 6px;border:none;border-radius:4px;background:none;color:inherit;font:inherit;text-align:left;cursor:default}
.dpa-row[data-open]{cursor:pointer}
.dpa-row[data-open]:hover{background:rgba(128,128,128,.16)}
.dpa-row-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dpa-row-size{flex:0 0 auto;opacity:.55;font-variant-numeric:tabular-nums;font-size:11.5px}
.dpa-tag{flex:0 0 auto;font-size:10.5px;padding:0 5px;border-radius:4px;background:rgba(128,128,128,.2);opacity:.85}
.dpa-filter{width:100%;box-sizing:border-box;margin:0 0 8px;padding:5px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font:inherit;font-size:12.5px}
.dpa-pre{margin:0;padding:10px;border-radius:6px;background:rgba(128,128,128,.12);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.5;overflow:auto;white-space:pre}
.dpa-text{margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.dpa-image{display:block;max-width:100%;height:auto;margin:0 auto 10px}
.dpa-frame{display:block;width:100%;height:100%;border:none;background:transparent}
.dpa-frame-wrap{flex:1 1 auto;min-height:0}
.dpa-dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 12px;margin:0 0 10px;font-size:12.5px;align-items:baseline}
.dpa-dl dt{opacity:.6;white-space:nowrap}
.dpa-dl dd{margin:0;overflow-wrap:anywhere}
.dpa-section{margin:14px 0 6px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;opacity:.55}
.dpa-specimen{padding:12px 14px;margin-bottom:10px;border-radius:8px;border:1px solid rgba(128,128,128,.25)}
.dpa-specimen p{margin:0 0 10px;line-height:1.28;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dpa-specimen p:last-child{margin-bottom:0}
.dpa-empty{padding:16px 4px;text-align:center;opacity:.6;line-height:1.6}
.dpa-summary{margin:0 0 10px;font-weight:600}
.dpa-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:8px}
.dpa-sub{opacity:.6;font-size:12px}
`;
