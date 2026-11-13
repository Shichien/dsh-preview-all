/** Player styles. They travel in the media chunk, so no other preview pays for them. */
export default `
.dvp-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;outline:none}
.dvp-root:fullscreen{background:#000;color:#eee}
.dvp-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden}
.dvp-video{width:100%;height:100%;object-fit:contain;outline:none}
.dvp-audio{width:100%;max-width:520px;outline:none}
.dvp-notice{position:absolute;top:0;left:0;right:0;z-index:2;margin:0;padding:8px 10px;background:rgba(120,86,20,.92);color:#fff;font-size:12px;line-height:1.55}
.dvp-notice a{color:#fff}
.dvp-error{padding:16px;font-size:13px;line-height:1.6;color:#ddd;text-align:center;max-width:420px}
.dvp-osd{position:absolute;top:12px;left:12px;padding:4px 10px;border-radius:6px;background:rgba(0,0,0,.68);color:#fff;font-size:13px;pointer-events:none;font-variant-numeric:tabular-nums}
.dvp-resume{position:absolute;left:12px;bottom:64px;display:flex;gap:10px;align-items:center;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.75);color:#fff;font-size:12px}
.dvp-resume button{background:none;border:none;padding:0;color:inherit;font:inherit;cursor:pointer;text-decoration:underline}
.dvp-menu{position:absolute;z-index:5;min-width:212px;max-height:calc(100% - 8px);overflow-y:auto;padding:4px;box-sizing:border-box;border-radius:8px;background:rgba(32,32,34,.97);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.45);color:#eee;font-size:12.5px}
.dvp-item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:5px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dvp-item:hover,.dvp-item:focus-visible{background:rgba(255,255,255,.1);outline:none}
.dvp-check{flex:0 0 12px;width:12px;text-align:center}
.dvp-label{flex:1 1 auto}
.dvp-hint{opacity:.55;font-size:11.5px}
.dvp-sep{height:1px;margin:4px 6px;background:rgba(255,255,255,.12)}
.dvp-section{padding:4px 8px 2px;opacity:.65;font-size:11.5px}
.dvp-chips{display:flex;flex-wrap:wrap;gap:4px;padding:4px 6px;max-width:220px}
.dvp-chip{min-width:40px;padding:3px 6px;border-radius:5px;border:1px solid rgba(255,255,255,.16);background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer;font-variant-numeric:tabular-nums}
.dvp-chip:hover{background:rgba(255,255,255,.1)}
.dvp-chip[aria-pressed="true"]{background:rgba(90,150,255,.35);border-color:rgba(120,170,255,.75)}
.dvp-help{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)}
.dvp-help-card{max-width:calc(100% - 24px);max-height:calc(100% - 24px);overflow:auto;padding:12px 16px;box-sizing:border-box;border-radius:8px;background:rgba(32,32,34,.97);border:1px solid rgba(255,255,255,.12);color:#eee;font-size:12.5px}
.dvp-help-card table{border-collapse:collapse}
.dvp-help-card td{padding:3px 12px 3px 0;vertical-align:top}
.dvp-help-card kbd{font-family:inherit;padding:1px 6px;border-radius:4px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.06);font-size:11.5px;white-space:nowrap}
.dvp-help-card p{margin:8px 0 0;opacity:.75}
.dvp-help-card .dvp-help-actions{margin-top:10px;text-align:right;opacity:1}
.dvp-help-card .dvp-help-actions button{padding:3px 12px;border-radius:5px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dvp-help-card .dvp-help-actions button:hover{background:rgba(255,255,255,.16)}
.dvp-bar{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:6px 10px;font-size:12px;opacity:.85}
.dvp-bar button,.dvp-bar a{background:none;border:none;padding:0;color:inherit;cursor:pointer;text-decoration:underline;font:inherit}
.dvp-bar .dvp-rate{text-decoration:none;border:1px solid currentColor;border-radius:4px;padding:0 6px;font-variant-numeric:tabular-nums}
.dvp-spacer{flex:1 1 auto}
`;
