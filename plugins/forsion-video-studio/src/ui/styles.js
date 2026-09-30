// Studio styles. Scoped under .fvs-studio / .fvs-embed; colours come from the host's tokens so any
// theme and light or dark mode work. Only the timeline's status colours are our own.
export const CSS = `
.fvs-studio{--fv-bg:var(--bg,#161616);--fv-card:var(--bg-card,#1f1f1f);--fv-text:var(--text,#ececec);--fv-muted:var(--text-muted,#9a9a9a);--fv-line:var(--border,#333);--fv-accent:var(--accent,#d9825b);--fv-ok:#35b37e;--fv-warn:#e0a13a;--fv-bad:#e5534b;--fv-hit:#ff6a13;
  position:relative;height:100%;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--fv-bg);color:var(--fv-text);font:13px/1.45 var(--font-ui,system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif);overflow:hidden}
.fvs-studio *{box-sizing:border-box}
.fvs-studio button,.fvs-studio input,.fvs-studio select,.fvs-studio textarea{font:inherit;color:inherit}
.fvs-studio button{cursor:pointer}
.fvs-studio :focus-visible{outline:2px solid var(--fv-accent);outline-offset:1px}
.fvs-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--fv-line);min-width:0;flex-wrap:wrap}
.fvs-bar .fvs-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:34ch}
.fvs-bar .fvs-status{color:var(--fv-muted);font-size:12px;white-space:nowrap}
.fvs-bar .fvs-grow{flex:1}
.fvs-btn{height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--fv-line);background:var(--fv-card);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.fvs-btn:hover{border-color:var(--fv-muted)}
.fvs-btn[disabled]{opacity:.45;cursor:default}
.fvs-btn.primary{background:var(--fv-accent);border-color:var(--fv-accent);color:#fff}
.fvs-btn.icon{width:28px;padding:0;justify-content:center}
.fvs-time{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;color:var(--fv-muted);min-width:15ch;text-align:center}
.fvs-main{display:grid;grid-template-columns:minmax(0,1fr) 340px;min-height:0}
.fvs-studio.narrow .fvs-main{grid-template-columns:1fr;grid-template-rows:minmax(160px,1fr) minmax(0,1fr)}
.fvs-view{position:relative;min-height:0;min-width:0;background:#101010}
.fvs-view iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#141414}
.fvs-view iframe.fvs-pending{visibility:hidden}
.fvs-gate{position:absolute;inset:0;display:grid;place-items:center;background:#111;color:#ddd;padding:24px;text-align:center}
.fvs-gate > div{max-width:420px;display:grid;gap:12px;justify-items:center}
.fvs-gate h3{margin:0;font-size:16px}
.fvs-gate p{margin:0;color:#aaa}
.fvs-errs{position:absolute;left:8px;right:8px;bottom:8px;max-height:40%;overflow:auto;background:rgba(40,10,10,.92);color:#ffb4a8;border:1px solid #7a2d2d;border-radius:6px;padding:8px 10px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap}
.fvs-inline{position:absolute;z-index:5;min-width:160px;display:grid;gap:4px}
.fvs-inline textarea{width:100%;resize:none;border:2px solid var(--fv-hit);border-radius:6px;background:#0d0d0d;color:#fff;padding:6px 8px;font-size:14px;line-height:1.4;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.fvs-inline small{color:#bbb;text-shadow:0 1px 2px #000}
.fvs-side{border-left:1px solid var(--fv-line);display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0;min-width:0}
.fvs-studio.narrow .fvs-side{border-left:0;border-top:1px solid var(--fv-line)}
.fvs-tabs{display:flex;border-bottom:1px solid var(--fv-line)}
.fvs-tabs button{flex:1;height:34px;border:0;background:none;color:var(--fv-muted);border-bottom:2px solid transparent}
.fvs-tabs button[aria-selected=true]{color:var(--fv-text);border-bottom-color:var(--fv-accent)}
.fvs-panel{overflow:auto;padding:12px;display:grid;gap:14px;align-content:start}
.fvs-panel h4{margin:0;font-size:12px;font-weight:600;color:var(--fv-muted);letter-spacing:.02em;display:flex;align-items:center;gap:8px}
.fvs-panel h4 .fvs-grow{flex:1}
.fvs-panel .fvs-hint{margin:0;color:var(--fv-muted);font-size:12px}
.fvs-field{display:grid;gap:4px}
.fvs-field > span{font-size:12px;color:var(--fv-muted)}
.fvs-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.fvs-row > .fvs-field{flex:1;min-width:90px}
.fvs-input{width:100%;height:30px;border:1px solid var(--fv-line);border-radius:6px;background:var(--fv-card);padding:0 8px}
textarea.fvs-input{height:auto;min-height:30px;padding:6px 8px;resize:vertical;line-height:1.45}
.fvs-code{width:100%;min-height:180px;border:1px solid var(--fv-line);border-radius:6px;background:var(--fv-card);padding:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;white-space:pre;tab-size:2}
.fvs-list{display:grid;gap:6px}
.fvs-text-item{display:grid;gap:4px;padding:6px;border-radius:6px;border:1px solid transparent}
.fvs-text-item:hover,.fvs-text-item.on{border-color:var(--fv-line);background:var(--fv-card)}
.fvs-text-item .fvs-meta{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--fv-muted)}
.fvs-text-item .fvs-meta .fvs-grow{flex:1}
.fvs-link{border:0;background:none;color:var(--fv-accent);padding:0;font-size:12px}
.fvs-suggest{border:1px dashed var(--fv-accent);border-radius:6px;padding:6px 8px;display:grid;gap:6px}
.fvs-timed{display:grid;grid-template-columns:minmax(0,1fr) 70px 70px 76px;gap:4px;align-items:center;font-size:12px}
.fvs-timed .fvs-input{height:26px;padding:0 6px}
.fvs-timed .lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fvs-problems{display:grid;gap:4px;font:12px/1.45 ui-monospace,monospace}
.fvs-problems .e{color:var(--fv-bad)} .fvs-problems .w{color:var(--fv-warn)}
.fvs-banner{position:absolute;left:50%;top:44px;transform:translateX(-50%);z-index:20;background:var(--fv-card);border:1px solid var(--fv-line);border-radius:8px;padding:8px 12px;display:flex;gap:10px;align-items:center;box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:min(640px,94%)}
.fvs-pop{position:absolute;z-index:30;background:var(--fv-card);border:1px solid var(--fv-line);border-radius:10px;padding:12px;box-shadow:0 12px 40px rgba(0,0,0,.4);display:grid;gap:10px;width:min(460px,92vw)}
.fvs-pop h3{margin:0;font-size:14px}
.fvs-pop textarea{min-height:90px}
.fvs-chips{display:flex;flex-wrap:wrap;gap:6px}
.fvs-chips button{border:1px solid var(--fv-line);background:none;border-radius:999px;padding:3px 10px;font-size:12px}
.fvs-chips button:hover{border-color:var(--fv-accent)}
.fvs-menu{position:absolute;z-index:30;background:var(--fv-card);border:1px solid var(--fv-line);border-radius:8px;padding:4px;box-shadow:0 12px 40px rgba(0,0,0,.4);display:grid;min-width:240px}
.fvs-menu button{display:grid;text-align:left;border:0;background:none;padding:7px 10px;border-radius:6px;gap:1px}
.fvs-menu button:hover,.fvs-menu button:focus-visible{background:var(--fv-bg)}
.fvs-menu small{color:var(--fv-muted)}
/* timeline */
.fvs-tl{border-top:1px solid var(--fv-line);display:grid;grid-template-rows:auto auto;min-width:0;user-select:none}
.fvs-tl-bar{display:flex;gap:6px;align-items:center;padding:4px 10px;font-size:12px;color:var(--fv-muted)}
.fvs-tl-bar select{height:24px;border:1px solid var(--fv-line);border-radius:5px;background:var(--fv-card)}
.fvs-tl-bar .fvs-btn{height:24px;padding:0 8px}
.fvs-tl-scroll{position:relative;overflow-x:auto;overflow-y:hidden;height:152px}
.fvs-tl-inner{position:relative;height:100%}
.fvs-tl canvas{position:absolute;left:0;display:block}
.fvs-tl-ruler{top:0;height:22px;cursor:ew-resize}
.fvs-tl-scenes{position:absolute;left:0;top:24px;height:62px;right:0}
.fvs-clip{position:absolute;top:0;height:62px;border-radius:6px;background:color-mix(in srgb,var(--fv-accent) 16%,var(--fv-card));border:1px solid color-mix(in srgb,var(--fv-accent) 40%,var(--fv-line));cursor:pointer}
.fvs-clip.alt{background:color-mix(in srgb,var(--fv-accent) 9%,var(--fv-card))}
.fvs-clip.on{border-color:var(--fv-accent);box-shadow:inset 0 0 0 1px var(--fv-accent)}
.fvs-clip.err{border-color:var(--fv-bad)}
.fvs-clip .nm{position:absolute;left:6px;top:3px;right:10px;overflow:hidden;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.fvs-clip .nm b{font-weight:600;margin-right:6px}
.fvs-clip .lane{position:absolute;left:0;right:0;bottom:4px;height:22px}
.fvs-clip .edge{position:absolute;right:-1px;top:0;bottom:0;width:8px;cursor:col-resize;border-radius:0 6px 6px 0;z-index:2}
.fvs-clip .edge:hover,.fvs-clip .edge.drag{background:color-mix(in srgb,var(--fv-accent) 55%,transparent)}
.fvs-hitm{position:absolute;top:3px;width:12px;height:16px;margin-left:-6px;cursor:grab;z-index:1}
.fvs-hitm::before{content:'';position:absolute;left:1px;top:3px;width:10px;height:10px;transform:rotate(45deg);background:var(--fv-hit);border-radius:1px}
.fvs-hitm.ok::before{background:var(--fv-ok)} .fvs-hitm.weak::before{background:var(--fv-warn)} .fvs-hitm.quiet::before{background:#8aa4ff}
.fvs-hitm.on::before{box-shadow:0 0 0 2px var(--fv-text)}
.fvs-tl-audio{top:90px;height:58px}
.fvs-tl-head{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--fv-hit);pointer-events:none;z-index:4}
.fvs-tl-head::before{content:'';position:absolute;left:-5px;top:0;border:6px solid transparent;border-top-color:var(--fv-hit)}
.fvs-tl-ghost{position:absolute;top:24px;height:62px;border:2px dashed var(--fv-accent);border-radius:6px;pointer-events:none;z-index:3}
.fvs-tl-empty{position:absolute;left:10px;top:30px;color:var(--fv-muted)}
@media (prefers-reduced-motion: reduce){.fvs-studio *{transition:none!important}}
/* note embeds */
.fvs-embed{position:relative;border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;background:#111}
.fvs-embed iframe{display:block;width:100%;border:0;aspect-ratio:16/9;background:#111}
.fvs-embed .bar{display:flex;gap:8px;align-items:center;padding:6px 10px;font-size:12px;color:var(--text-muted,#999);background:var(--bg-card,#1b1b1b)}
.fvs-embed .bar b{color:var(--text,#eee);font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fvs-embed button{font:inherit;border:1px solid var(--border,#333);background:none;color:inherit;border-radius:5px;padding:2px 8px;cursor:pointer}
`;

let injected = false;
export function injectCss() {
  if (injected || typeof document === 'undefined') return;
  const s = document.createElement('style');
  s.setAttribute('data-fvs-studio', '');
  s.textContent = CSS;
  document.head.append(s);
  injected = true;
}
