// Page bootstrap for the three page modes (see lib/compile.js buildHtml).
import { mount, timeExpr } from './player.js';
import { EASE, prog, rng, createStage } from './engine.js';

const PLAYER_CSS = `
html,body{margin:0;background:#0b0b0b;color:#e8e6e1;font:14px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif}
.fvs-app{max-width:1200px;margin:0 auto;padding:24px 16px 48px;display:grid;gap:14px}
.fvs-app h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.02em}
.fvs-frame{position:relative;width:100%;overflow:hidden;background:#000;border-radius:6px;box-shadow:0 0 0 1px #262626;cursor:pointer}
.fvs-frame .fvs-stage{position:absolute;left:0;top:0}
.fvs-bar{display:flex;gap:10px;align-items:center}
.fvs-bar button{font:600 14px inherit;font-family:inherit;color:#0b0b0b;background:#e8e6e1;border:0;border-radius:6px;height:36px;min-width:84px;cursor:pointer}
.fvs-bar button:focus-visible,.fvs-bar input:focus-visible,.fvs-chapters button:focus-visible{outline:2px solid #ff6a13;outline-offset:2px}
.fvs-bar input{flex:1;min-width:0;accent-color:#ff6a13}
.fvs-bar output{font:12px ui-monospace,monospace;color:#9a948d;font-variant-numeric:tabular-nums;min-width:12ch;text-align:right}
.fvs-chapters{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;padding:0;list-style:none;font-size:13px;color:#9a948d}
.fvs-chapters button{font:inherit;color:inherit;background:none;border:0;padding:2px 0;cursor:pointer}
.fvs-chapters button:hover,.fvs-chapters button.on{color:#e8e6e1}
.fvs-chapters b{font:600 12px ui-monospace,monospace;color:#ff6a13;margin-right:6px}
.fvs-err{font:12px ui-monospace,monospace;color:#ff8a65;white-space:pre-wrap;margin:0}
.fvs-credit{font-size:12px;color:#6f6a64;margin:0}
`;

const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function payloadFromPage() {
  const el = document.getElementById('fvs-data');
  return JSON.parse(el.textContent);
}

/** A clock that runs on its own and keeps the audio tracks in step with it. */
function makeClock(P, audios, length, onEnd) {
  let playing = false, base = 0, startedAt = 0;
  const now = () => (playing ? Math.min(length, base + (performance.now() - startedAt) / 1000) : base);
  const sync = force => {
    const t = now();
    for (const { el, at } of audios) {
      const want = t - at;
      if (!playing || want < 0 || want > (el.duration || Infinity)) { if (!el.paused) el.pause(); if (want < 0 && el.currentTime) el.currentTime = 0; continue; }
      if (force || Math.abs(el.currentTime - want) > .08) el.currentTime = want;
      if (el.paused) el.play().catch(() => {});
    }
  };
  return {
    now, sync, get playing() { return playing; },
    play() { if (base >= length) base = 0; playing = true; startedAt = performance.now(); sync(true); },
    pause() { base = now(); playing = false; sync(); },
    seek(t) { base = Math.max(0, Math.min(length, t)); startedAt = performance.now(); sync(true); },
    tick() { if (playing && now() >= length) { base = length; playing = false; sync(); onEnd && onEnd(); } else if (playing) sync(); },
  };
}

function fit(stage, frame, P) {
  const f = () => { stage.root.style.transform = `scale(${frame.clientWidth / P.width})`; };
  new ResizeObserver(f).observe(frame); f();
}

function bootPlayer(P) {
  const style = document.createElement('style'); style.textContent = PLAYER_CSS; document.head.append(style);
  const app = document.createElement('main'); app.className = 'fvs-app';
  app.innerHTML = `<h1></h1><div class="fvs-frame" role="img"></div>
    <div class="fvs-bar" role="group" aria-label="Playback"><button type="button" class="fvs-play">▶ 播放</button><input type="range" min="0" step="0.01" value="0" aria-label="进度"><output></output></div>
    <ol class="fvs-chapters" aria-label="章节"></ol><pre class="fvs-err" hidden></pre><p class="fvs-credit">Made with Forsion Video Studio</p>`;
  document.body.append(app);
  app.querySelector('h1').textContent = P.title || '';
  const frame = app.querySelector('.fvs-frame');
  frame.style.aspectRatio = `${P.width} / ${P.height}`;
  // the whole frame and the transport fit the window: a portrait video must not push the controls away
  frame.style.maxWidth = `calc((100vh - 200px) * ${P.width / P.height})`;
  frame.style.margin = '0 auto';
  frame.setAttribute('aria-label', P.title || 'video');
  const stage = mount(P, frame);
  fit(stage, frame, P);
  const audios = P.audio.map(a => { const el = new Audio(a.url); el.preload = 'auto'; el.volume = Math.min(1, 10 ** ((a.gain || 0) / 20)); return { el, at: a.at || 0 }; });
  const btn = app.querySelector('.fvs-play'), seekEl = app.querySelector('input'), out = app.querySelector('output');
  seekEl.max = P.length;
  const clock = makeClock(P, audios, P.length);
  const chapters = app.querySelector('.fvs-chapters');
  chapters.innerHTML = P.scenes.map(s => `<li><button type="button" data-t="${s.t0}"><b>${s.t0.toFixed(1)}</b></button></li>`).join('');
  [...chapters.querySelectorAll('button')].forEach((b, i) => b.append(P.scenes[i].title || P.scenes[i].id));
  const chapterBtns = [...chapters.querySelectorAll('button')];
  if (stage.errors.length) { const e = app.querySelector('.fvs-err'); e.hidden = false; e.textContent = stage.errors.map(x => `${x.scene}${x.line ? `:${x.line}` : ''} ${x.message}`).join('\n'); }
  const toggle = () => (clock.playing ? clock.pause() : clock.play());
  btn.addEventListener('click', toggle);
  frame.addEventListener('click', toggle);
  seekEl.addEventListener('input', () => clock.seek(+seekEl.value));
  chapterBtns.forEach(b => b.addEventListener('click', () => { clock.seek(+b.dataset.t); if (!clock.playing) clock.play(); }));
  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input,button,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    if (e.code === 'ArrowRight') clock.seek(clock.now() + 2);
    if (e.code === 'ArrowLeft') clock.seek(clock.now() - 2);
  });
  let last = -1;
  const poster = P.scenes.length ? Math.min(P.length, (P.scenes[Math.min(1, P.scenes.length - 1)].t0 + .8)) : 0;
  let started = false;
  const loop = () => {
    clock.tick();
    const t = started || clock.playing ? clock.now() : poster;
    if (clock.playing) started = true;
    if (t !== last) { stage.seek(t); last = t; }
    seekEl.value = t; out.textContent = `${fmt(t)} / ${fmt(P.length)}`;
    btn.textContent = clock.playing ? '❚❚ 暂停' : '▶ 播放';
    chapterBtns.forEach((b, i) => b.classList.toggle('on', t >= P.scenes[i].t0 && t < P.scenes[i].t1));
    requestAnimationFrame(loop);
  };
  seekEl.addEventListener('input', () => { started = true; });
  requestAnimationFrame(loop);
  window.__fvs = { stage, clock };
}

function bootCapture(P) {
  document.documentElement.style.background = '#000';
  document.body.style.margin = '0';
  const stage = mount(P, document.body);
  stage.root.style.transform = 'none';
  stage.seek(0);
  window.__stage = {
    w: P.width, h: P.height, dur: P.length, fps: P.fps, errors: stage.errors, audio: P.audio,
    seek: t => stage.seek(t),
    ready: () => document.fonts.ready.then(() => Promise.all([...document.images].map(i => (i.complete ? 0 : i.decode().catch(() => 0))))),
  };
}

const RAW_PARENT = /^(SCRIPT|STYLE|TEXTAREA|TITLE)$/i;

/**
 * The Studio's preview: a sandboxed iframe (no same-origin), driven over postMessage.
 *   in:  { fvs: 'seek', t } · { fvs: 'outline', scene, text?, img? } · { fvs: 'mode', edit }
 *   out: { fvs: 'ready', length, errors, texts: {scene: n}, imgs: {scene: n} } · { fvs: 'pick', scene, text?, img?, rect, dbl }
 * Text runs are numbered right after each scene's markup is parsed, before its script runs, in the same
 * order lib/html.js scans the source, so a pick names a run the Studio can rewrite in the file.
 */
function bootEmbed(P) {
  document.documentElement.style.cssText = 'background:#141414;height:100%;overflow:hidden';
  document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;display:grid;place-items:center';
  const frame = document.createElement('div');
  frame.style.cssText = `position:relative;overflow:hidden;background:#000;aspect-ratio:${P.width}/${P.height};width:min(100vw, calc(100vh * ${P.width / P.height}))`;
  document.body.append(frame);
  const index = {};
  const nodeOf = new WeakMap(), elOf = new WeakMap(), imgOf = new WeakMap();
  const onScene = sc => {
    const texts = [], imgs = [...sc.el.querySelectorAll('img')];
    const w = document.createTreeWalker(sc.el, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (!/\S/.test(n.data) || (n.parentElement && RAW_PARENT.test(n.parentElement.tagName))) continue;
      nodeOf.set(n, texts.length);
      const el = n.parentElement;
      if (!elOf.has(el)) elOf.set(el, []);
      elOf.get(el).push(texts.length);
      texts.push({ node: n, el });
    }
    imgs.forEach((im, k) => imgOf.set(im, k));
    index[sc.id] = { texts, imgs };
  };
  const stage = mount(P, frame, { onScene });
  const fit = () => { stage.root.style.transform = `scale(${frame.clientWidth / P.width})`; };
  new ResizeObserver(fit).observe(frame); fit();
  const post = m => parent.postMessage({ fvs: m.type, ...m, type: undefined }, '*');
  let now = 0;
  stage.seek(0);

  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;pointer-events:none;border:2px solid #ff6a13;border-radius:3px;box-shadow:0 0 0 9999px rgba(0,0,0,.18);display:none;z-index:10';
  frame.append(box);
  // rects travel in the iframe's viewport pixels, which are the Studio's preview pixels
  const rel = r => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const show = r => { if (!r) { box.style.display = 'none'; return; } const f = frame.getBoundingClientRect(); Object.assign(box.style, { display: '', left: `${r.x - f.left - 3}px`, top: `${r.y - f.top - 3}px`, width: `${r.w + 6}px`, height: `${r.h + 6}px` }); };
  const sceneOf = el => { const s = el && el.closest && el.closest('[data-scene]'); return s ? s.dataset.scene : null; };

  function pick(e, dbl) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const scene = sceneOf(target);
    if (!scene || !index[scene]) { post({ type: 'pick', scene: null, dbl }); return; }
    if (target.tagName === 'IMG' && imgOf.has(target)) { post({ type: 'pick', scene, img: imgOf.get(target), rect: rel(target.getBoundingClientRect()), dbl }); return; }
    let text = null;
    const range = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
    if (range && range.startContainer.nodeType === 3 && nodeOf.has(range.startContainer)) text = nodeOf.get(range.startContainer);
    for (let el = target; text === null && el && el !== frame; el = el.parentElement) if (elOf.has(el)) text = elOf.get(el)[0];
    if (text === null) { post({ type: 'pick', scene, dbl }); return; }
    const t = index[scene].texts[text];
    const r = t.node.isConnected ? (() => { const g = document.createRange(); g.selectNodeContents(t.node); return g.getBoundingClientRect(); })() : t.el.getBoundingClientRect();
    post({ type: 'pick', scene, text, rect: rel(r.width ? r : t.el.getBoundingClientRect()), dbl });
  }
  frame.addEventListener('click', e => pick(e, false));
  frame.addEventListener('dblclick', e => { e.preventDefault(); pick(e, true); });

  window.addEventListener('message', e => {
    const m = e.data || {};
    if (m.fvs === 'seek') { now = m.t; stage.seek(m.t); }
    else if (m.fvs === 'outline') {
      const ix = index[m.scene];
      const el = !ix ? null : m.img != null ? ix.imgs[m.img] : m.text != null && ix.texts[m.text] ? ix.texts[m.text].el : null;
      show(el && el.isConnected && el.getClientRects().length ? rel(el.getBoundingClientRect()) : null);
    }
  });
  const counts = k => Object.fromEntries(Object.entries(index).map(([id, v]) => [id, v[k].length]));
  post({ type: 'ready', length: P.length, errors: stage.errors, texts: counts('texts'), imgs: counts('imgs') });
  window.__fvs = { stage, seek: t => stage.seek(t) };
}

export function boot(mode) {
  const P = payloadFromPage();
  const m = (typeof window !== 'undefined' && window.FVS_MODE) || mode || new URLSearchParams(location.search).get('mode') || (new URLSearchParams(location.search).has('capture') ? 'capture' : 'player');
  if (m === 'capture') bootCapture(P); else if (m === 'embed') bootEmbed(P); else bootPlayer(P);
}

export { mount, timeExpr, EASE, prog, rng, createStage };
