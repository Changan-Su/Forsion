// The Video Studio editor for one .fvs.md file: preview, transport, timeline, inspector.
// The file text is the only state that matters: every edit is text → text through lib/project.js,
// undo is a stack of texts, and a change on disk (the AI editing the file) is just another text.
import * as P from '../lib/project.js';
import { compile, buildHtml, audioTracks } from '../lib/compile.js';
import { scan, replaceText, setAttr, images, timedElements } from '../lib/html.js';
import { onsetEnvelope, syncReport } from '../lib/onsets.js';
import RUNTIME from '../generated/runtime-src.js';
import { CSS as STUDIO_CSS } from './styles.js';
import { handOff, TASKS, rewrite, notify, ensureTools } from './ai.js';
import { exportHtml } from './exporter.js';

import { h, dirOf, joinPath, mimeOf, b64 } from './util.js';
export { h, dirOf, joinPath, mimeOf, b64 };

const fmtTime = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const typing = e => { const x = e.target; return x && (x.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(x.tagName)); };

/** Shared per-plugin trust list: paths whose scripts the user agreed to run. */
export async function trustList(ctx) {
  try { const d = (await ctx.loadData?.()) || {}; return Array.isArray(d.trusted) ? d.trusted : []; } catch { return []; }
}
export async function trust(ctx, path) {
  let d = {};
  try { d = (await ctx.loadData?.()) || {}; } catch { d = {}; }
  const list = new Set(Array.isArray(d.trusted) ? d.trusted : []);
  list.add(path);
  try { await ctx.saveData?.({ ...d, trusted: [...list].slice(-500) }); } catch { /* best effort */ }
}

/** Load vault files as data URLs (the sandboxed preview has no access to the vault protocol). */
export function assetLoader(ctx) {
  const cache = new Map();
  return {
    cache,
    async get(vp) {
      if (cache.has(vp)) return cache.get(vp);
      let url = null;
      try {
        if (ctx.app.readBytes) { const b = await ctx.app.readBytes(vp); if (b) url = `data:${mimeOf(vp)};base64,${b64(b instanceof Uint8Array ? b : new Uint8Array(b))}`; }
      } catch { url = null; }
      if (!url && ctx.app.assetUrl) { try { url = ctx.app.assetUrl(vp); } catch { url = null; } }
      cache.set(vp, url);
      return url;
    },
  };
}

/** Compile a project into the sandboxed preview page. */
export async function previewHtml(p, path, assets, mode = 'embed') {
  const dir = dirOf(path);
  const probe = compile(p);
  await Promise.all(Object.keys(probe.assets).map(rel => assets.get(joinPath(dir, rel))));
  const payload = compile(p, { resolve: rel => assets.cache.get(joinPath(dir, rel)) || rel });
  payload.audio = [];
  return buildHtml(payload, RUNTIME, { mode });
}

/* ───────── the editor ───────── */
export function mountStudio(ctx, el, path, t, opts = {}) {
  const app = ctx.app;
  const S = {
    path, text: '', saved: '', p: P.parseProject(''), time: 0, playing: false,
    sel: null, selText: null, selHit: null, tab: 'scene', codeScope: 'scene', allTexts: false,
    zoom: 0, snap: 'half', undo: [], redo: [], trusted: false, gen: 0,
    runtimeErrors: [], counts: null, sync: null, audioKey: '', analysis: null, disposed: false, status: 'saved',
  };
  const assets = assetLoader(ctx);
  const root = h('div', { class: 'fvs-studio', tabindex: '-1' });
  root.append(h('style', { text: STUDIO_CSS }));
  el.append(root);

  /* toolbar */
  const nameEl = h('span', { class: 'fvs-name', text: path.split('/').pop() });
  const statusEl = h('span', { class: 'fvs-status' });
  const undoBtn = h('button', { class: 'fvs-btn icon', title: `${t('undo')} (⌘Z)`, 'aria-label': t('undo'), onclick: () => undo() }, '↶');
  const redoBtn = h('button', { class: 'fvs-btn icon', title: `${t('redo')} (⇧⌘Z)`, 'aria-label': t('redo'), onclick: () => redo() }, '↷');
  const playBtn = h('button', { class: 'fvs-btn', onclick: () => toggle() }, `▶ ${t('play')}`);
  const timeEl = h('span', { class: 'fvs-time', 'aria-live': 'off' });
  const aiBtn = h('button', { class: 'fvs-btn primary', onclick: e => openAsk(e.currentTarget) }, `✦ ${t('ask-ai')}`);
  const scoreBtn = h('button', { class: 'fvs-btn', title: t('ai-chip-score'), onclick: () => handOff(ctx, S, TASKS.score(), t) }, `♪ ${t('score')}`);
  const exportBtn = h('button', { class: 'fvs-btn', 'aria-haspopup': 'menu', onclick: e => openExport(e.currentTarget) }, `${t('export')} ▾`);
  root.append(h('div', { class: 'fvs-bar' }, nameEl, statusEl, undoBtn, redoBtn, h('span', { class: 'fvs-grow' }), playBtn, timeEl, h('span', { class: 'fvs-grow' }), aiBtn, scoreBtn, exportBtn));

  /* preview + side panel */
  const view = h('div', { class: 'fvs-view' });
  const errBox = h('div', { class: 'fvs-errs', hidden: true, role: 'status' });
  view.append(errBox);
  const tabs = h('div', { class: 'fvs-tabs', role: 'tablist' });
  const panel = h('div', { class: 'fvs-panel', role: 'tabpanel' });
  for (const k of ['scene', 'text', 'code', 'project']) {
    tabs.append(h('button', { role: 'tab', 'data-tab': k, 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; renderSide(); } }, t(`tab-${k}`)));
  }
  root.append(h('div', { class: 'fvs-main' }, view, h('div', { class: 'fvs-side' }, tabs, panel)));

  /* timeline */
  const snapSel = h('select', { 'aria-label': t('snap'), onchange: e => { S.snap = e.target.value; } },
    ...['bar', 'beat', 'half', 'quarter', 'off'].map(k => h('option', { value: k, selected: S.snap === k }, t(`snap-${k}`))));
  const tlBar = h('div', { class: 'fvs-tl-bar' }, h('span', { text: t('snap') }), snapSel,
    h('button', { class: 'fvs-btn', title: t('zoom-out'), 'aria-label': t('zoom-out'), onclick: () => setZoom(S.zoom / 1.5) }, '−'),
    h('button', { class: 'fvs-btn', title: t('zoom-in'), 'aria-label': t('zoom-in'), onclick: () => setZoom(S.zoom * 1.5) }, '+'),
    h('button', { class: 'fvs-btn', onclick: () => setZoom(0) }, t('zoom-fit')),
    h('span', { class: 'fvs-grow' }), h('span', { class: 'fvs-sync-sum' }));
  const scroller = h('div', { class: 'fvs-tl-scroll' });
  const inner = h('div', { class: 'fvs-tl-inner' });
  const ruler = h('canvas', { class: 'fvs-tl-ruler' });
  const clips = h('div', { class: 'fvs-tl-scenes' });
  const wave = h('canvas', { class: 'fvs-tl-audio' });
  const head = h('div', { class: 'fvs-tl-head' });
  inner.append(ruler, clips, wave, head);
  scroller.append(inner);
  root.append(h('div', { class: 'fvs-tl', title: '' }, tlBar, scroller));

  let current = null, pending = null, pendingTimer = 0, inline = null;

  /* ───────── load, save, watch ───────── */
  async function load() {
    statusEl.textContent = t('loading');
    let text = null;
    try { text = await app.readFile(path); } catch { text = null; }
    if (S.disposed) return;
    if (text === null) {
      const noVault = app.vaultRoot && !app.vaultRoot();
      view.append(h('div', { class: 'fvs-gate' }, h('div', {}, h('p', { text: noVault ? t('no-vault') : t('cannot-read', { path }) }))));
      statusEl.textContent = '';
      return;
    }
    S.trusted = opts.trusted || (await trustList(ctx)).includes(path);
    S.text = S.saved = text;
    setStatus('saved');
    reparse();
    S.sel = S.p.scenes[0] ? S.p.scenes[0].id : null;
    S.time = Math.min(S.p.length, S.p.scenes[1] ? S.p.scenes[1].t0 + .5 : 0);
    renderAll();
    requestAnimationFrame(() => setZoom(0));
    if (S.trusted) buildPreview(); else showGate();
    loadAudio();
    watch();
  }
  function reparse() { S.p = P.parseProject(S.text); if (S.sel && !P.sceneById(S.p, S.sel)) S.sel = S.p.scenes[0] ? S.p.scenes[0].id : null; }

  let saveTimer = 0, saving = null;
  function setStatus(k, vars) { S.status = k; statusEl.textContent = t(k, vars); }
  function scheduleSave() { setStatus('unsaved'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
  async function save() {
    clearTimeout(saveTimer);
    if (S.text === S.saved) { setStatus('saved'); return; }
    const text = S.text;
    setStatus('saving');
    try {
      saving = app.writeFile(path, text);
      await saving;
      S.saved = text;
      if (!S.disposed) setStatus(S.text === S.saved ? 'saved' : 'unsaved');
    } catch (e) { if (!S.disposed) setStatus('save-failed', { msg: e && e.message || e }); }
    finally { saving = null; }
  }

  let unwatch = null, poll = 0, banner = null;
  function watch() {
    if (app.watchFile) unwatch = app.watchFile(path, () => external());
    else poll = setInterval(external, 2000);
  }
  async function external() {
    if (saving) { try { await saving; } catch { /* reported by save */ } }
    let disk = null;
    try { disk = await app.readFile(path); } catch { disk = null; }
    if (S.disposed || disk === null || disk === S.saved || disk === S.text) { if (disk === S.text) S.saved = disk; return; }
    if (S.text === S.saved) {
      S.undo.push(S.text); S.redo = [];
      S.text = S.saved = disk;
      afterChange(false);
      notify(ctx, t('external'));
    } else showConflict(disk);
  }
  function showConflict(disk) {
    if (banner) banner.remove();
    banner = h('div', { class: 'fvs-banner', role: 'alert' }, h('span', { text: t('conflict') }),
      h('button', { class: 'fvs-btn', onclick: () => { banner.remove(); banner = null; S.undo.push(S.text); S.text = S.saved = disk; afterChange(false); } }, t('conflict-load')),
      h('button', { class: 'fvs-btn primary', onclick: () => { banner.remove(); banner = null; S.saved = disk; save(); } }, t('conflict-keep')));
    root.append(banner);
  }

  /* ───────── edits ───────── */
  function commit(next) {
    if (typeof next !== 'string' || next === S.text) return;
    S.undo.push(S.text); if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
    S.text = next;
    afterChange(true);
  }
  function tryCommit(fn) {
    try { commit(fn(S.text)); return true; } catch (e) { notify(ctx, String(e && e.message || e), 'warn'); return false; }
  }
  function afterChange(save_) {
    reparse();
    if (save_) scheduleSave(); else setStatus(S.text === S.saved ? 'saved' : 'unsaved');
    renderAll();
    schedulePreview();
    const key = JSON.stringify(audioTracks(S.p.meta));
    if (key !== S.audioKey) loadAudio(); else computeSync();
  }
  function undo() { if (!S.undo.length) return; S.redo.push(S.text); S.text = S.undo.pop(); afterChange(true); }
  function redo() { if (!S.redo.length) return; S.undo.push(S.text); S.text = S.redo.pop(); afterChange(true); }

  /* ───────── preview ───────── */
  function showGate() {
    view.querySelectorAll('.fvs-gate').forEach(x => x.remove());
    view.append(h('div', { class: 'fvs-gate' }, h('div', {},
      h('h3', { text: t('trust-title') }), h('p', { text: t('trust-body') }),
      h('button', { class: 'fvs-btn primary', onclick: async () => { S.trusted = true; await trust(ctx, path); view.querySelectorAll('.fvs-gate').forEach(x => x.remove()); buildPreview(); } }, t('trust-run')))));
  }
  let previewTimer = 0;
  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(buildPreview, 220); }
  async function buildPreview() {
    if (!S.trusted || S.disposed) return;
    const gen = ++S.gen;
    const html = await previewHtml(S.p, path, assets);
    if (gen !== S.gen || S.disposed) return;
    if (pending) pending.remove();
    pending = h('iframe', { sandbox: 'allow-scripts', title: t('app'), class: current ? 'fvs-pending' : '' });
    pending.srcdoc = html;
    view.prepend(pending);
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => swap({ errors: [{ scene: '', message: 'preview did not start (see the console)' }] }), 10000);
  }
  function swap(m) {
    clearTimeout(pendingTimer);
    if (!pending) return;
    if (current) current.remove();
    current = pending; pending = null;
    current.classList.remove('fvs-pending');
    S.runtimeErrors = m.errors || [];
    S.counts = m.texts ? { texts: m.texts, imgs: m.imgs } : null;
    lastPosted = -1;
    post({ fvs: 'seek', t: S.time });
    renderErrors();
    if (S.tab === 'project') renderSide();
  }
  let lastPosted = -1;
  const post = m => { if (current && current.contentWindow) current.contentWindow.postMessage(m, '*'); };
  function onMessage(e) {
    const m = e.data || {};
    if (pending && e.source === pending.contentWindow && m.fvs === 'ready') return swap(m);
    if (!current || e.source !== current.contentWindow) return;
    if (m.fvs === 'pick') onPick(m);
  }
  window.addEventListener('message', onMessage);

  function renderErrors() {
    const errs = S.runtimeErrors;
    errBox.hidden = !errs.length;
    errBox.textContent = errs.length ? `${t('errors-runtime')}\n${errs.map(x => `${x.scene ? `[${x.scene}]` : ''}${x.line ? ` line ${x.line}` : ''} ${x.message}`).join('\n')}` : '';
    for (const c of clips.querySelectorAll('.fvs-clip')) c.classList.toggle('err', errs.some(x => x.scene === c.dataset.id) || S.p.errors.some(x => x.level === 'error' && x.scene === c.dataset.id));
  }

  /* click in the picture: select the scene and the text; double-click: edit in place */
  function textsMatch(id) {
    const s = P.sceneById(S.p, id);
    return s && S.counts && S.counts.texts[id] === scan(s.html).texts.length;
  }
  function onPick(m) {
    if (!m.scene) return;
    S.sel = m.scene;
    if (m.text != null) S.selText = { scene: m.scene, index: m.text };
    renderTimeline();
    if (!m.dbl) root.focus({ preventScroll: true }); // take the keyboard back from the preview
    if (m.dbl && m.text != null && textsMatch(m.scene)) openInline(m);
    else if (m.dbl && m.img != null) { S.tab = 'text'; renderSide(); }
    else if (S.tab === 'text' || S.tab === 'scene') renderSide();
  }
  function openInline(m) {
    closeInline();
    const s = P.sceneById(S.p, m.scene);
    const run = scan(s.html).texts[m.text];
    if (!run) return;
    const vr = view.getBoundingClientRect();
    const ta = h('textarea', { rows: Math.min(6, Math.max(1, Math.ceil(run.text.trim().length / 28))), 'aria-label': t('texts') });
    ta.value = run.text.trim();
    const box = h('div', { class: 'fvs-inline', style: { left: `${Math.max(4, Math.min(m.rect.x, vr.width - 260))}px`, top: `${Math.max(4, Math.min(m.rect.y + m.rect.h + 6, vr.height - 90))}px`, width: `${Math.max(220, Math.min(m.rect.w, 520))}px` } }, ta, h('small', { text: '↵ ✓ · Esc ✕' }));
    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      const v = ta.value; closeInline();
      if (ok && v.trim() !== run.text.trim()) tryCommit(x => P.setSceneBlock(x, m.scene, 'html', replaceText(P.sceneById(P.parseProject(x), m.scene).html, m.text, v)));
      root.focus();
    };
    ta.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    ta.addEventListener('blur', () => finish(true));
    view.append(box);
    inline = box;
    ta.focus(); ta.select();
  }
  function closeInline() { if (inline) { const x = inline; inline = null; x.remove(); } }

  /* ───────── transport ───────── */
  let audios = [];
  let clockBase = 0, clockStart = 0;
  const now = () => (S.playing ? Math.min(S.p.length, clockBase + (performance.now() - clockStart) / 1000) : S.time);
  function syncAudio(force) {
    for (const a of audios) {
      const want = S.time - a.at;
      if (!S.playing || want < 0 || (a.el.duration && want > a.el.duration)) { if (!a.el.paused) a.el.pause(); continue; }
      if (force || Math.abs(a.el.currentTime - want) > .08) a.el.currentTime = want;
      if (a.el.paused) a.el.play().catch(() => {});
    }
  }
  function toggle() {
    if (S.playing) { S.time = now(); S.playing = false; syncAudio(); }
    else { if (S.time >= S.p.length - .01) S.time = 0; S.playing = true; clockBase = S.time; clockStart = performance.now(); syncAudio(true); }
    renderTransport();
  }
  function seek(x) {
    S.time = Math.max(0, Math.min(S.p.length, x));
    clockBase = S.time; clockStart = performance.now();
    syncAudio(true);
    renderTransport();
  }
  function renderTransport() {
    playBtn.textContent = S.playing ? `❚❚ ${t('pause')}` : `▶ ${t('play')}`;
    const fps = +S.p.meta.fps || 30;
    timeEl.textContent = `${fmtTime(S.time)} / ${fmtTime(S.p.length)} · ${Math.round(S.time * fps)}`;
    timeEl.title = `${t('time')} · ${t('frames')}`;
    undoBtn.disabled = !S.undo.length; redoBtn.disabled = !S.redo.length;
  }
  let raf = 0;
  function loop() {
    if (S.disposed) return;
    if (S.playing) {
      S.time = now();
      if (S.time >= S.p.length) { S.playing = false; syncAudio(); }
      else syncAudio(false);
      renderTransport();
      const x = S.time * S.zoom;
      if (x < scroller.scrollLeft + 40 || x > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = x - 60;
    }
    if (S.time !== lastPosted) { post({ fvs: 'seek', t: S.time }); lastPosted = S.time; head.style.left = `${S.time * S.zoom}px`; }
    raf = requestAnimationFrame(loop);
  }

  /* audio: tracks to play, the first one decoded for the waveform and the accent analysis */
  async function loadAudio() {
    const tracks = audioTracks(S.p.meta);
    S.audioKey = JSON.stringify(tracks);
    for (const a of audios) { a.el.pause(); if (a.blob) URL.revokeObjectURL(a.url); }
    audios = [];
    S.analysis = null; S.sync = null;
    const dir = dirOf(path);
    for (const tr of tracks) {
      const vp = joinPath(dir, tr.src);
      let url = null, blob = false;
      try { url = app.assetUrl ? app.assetUrl(vp) : null; } catch { url = null; }
      if (!url && app.readBytes) { const b = await app.readBytes(vp).catch(() => null); if (b) { url = URL.createObjectURL(new Blob([b], { type: mimeOf(vp) })); blob = true; } }
      if (!url) continue;
      const a = new Audio(url); a.preload = 'auto'; a.volume = Math.min(1, 10 ** ((tr.gain || 0) / 20));
      audios.push({ el: a, at: tr.at || 0, url, blob, vp });
    }
    drawWave();
    if (tracks[0]) analyse(joinPath(dir, tracks[0].src), tracks[0].at || 0);
  }
  async function analyse(vp, at) {
    const key = S.audioKey;
    try {
      let bytes = null;
      if (app.readBytes) bytes = await app.readBytes(vp);
      if (!bytes && app.assetUrl) bytes = new Uint8Array(await (await fetch(app.assetUrl(vp))).arrayBuffer());
      if (!bytes) return;
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ac = new Ctx(1, 22050, 22050);
      const buf = await ac.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (S.disposed || key !== S.audioKey) return;
      const mono = new Float32Array(buf.length + Math.round(at * buf.sampleRate));
      const off = Math.round(at * buf.sampleRate);
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i + off] += d[i] / buf.numberOfChannels; }
      const bins = Math.ceil(mono.length / buf.sampleRate * 100), peaks = new Float32Array(bins);
      const per = buf.sampleRate / 100;
      for (let b = 0; b < bins; b++) { let m = 0; const a = Math.floor(b * per), e = Math.min(mono.length, Math.floor((b + 1) * per)); for (let i = a; i < e; i++) { const v = Math.abs(mono[i]); if (v > m) m = v; } peaks[b] = m; }
      S.analysis = { env: onsetEnvelope(mono, buf.sampleRate), peaks };
      computeSync(); drawWave(); renderTimeline();
    } catch (e) { /* no waveform; playback still works */ }
  }
  function computeSync() {
    S.sync = S.analysis ? syncReport(S.p.scenes, S.analysis.env) : null;
    const sum = root.querySelector('.fvs-sync-sum');
    if (!sum) return;
    if (!S.sync) { sum.textContent = ''; return; }
    const bad = S.sync.filter(r => !r.ok).length;
    sum.textContent = bad ? t('sync-bad', { n: S.sync.length, bad }).replace(/[:：]$/, '') : t('sync-ok', { n: S.sync.length });
    sum.style.color = bad ? 'var(--fv-warn)' : 'var(--fv-ok)';
  }

  /* ───────── timeline ───────── */
  const grid = () => {
    const tp = S.p.tempo;
    if (!tp) return S.snap === 'off' ? 1 / (+S.p.meta.fps || 30) : { bar: 1, beat: .5, half: .25, quarter: .1 }[S.snap] || .1;
    return { bar: tp.bar, beat: tp.beat, half: tp.beat / 2, quarter: tp.beat / 4, off: 1 / (+S.p.meta.fps || 30) }[S.snap];
  };
  const snapT = x => { const g = grid(); return Math.round(x / g) * g; };
  function setZoom(z) {
    const fit = Math.max(4, (scroller.clientWidth - 24) / Math.max(1, S.p.length));
    S.zoom = z > 0 ? Math.min(400, Math.max(fit / 2, z)) : fit;
    renderTimeline();
  }
  function renderTimeline() {
    const Z = S.zoom || 20, W = Math.ceil(S.p.length * Z) + 24;
    inner.style.width = `${W}px`;
    clips.replaceChildren();
    if (!S.p.scenes.length) clips.append(h('div', { class: 'fvs-tl-empty', text: t('scene-none') }));
    const rows = S.sync || [];
    const u = P.hitUnit(S.p.tempo);
    S.p.scenes.forEach((s, k) => {
      const clip = h('div', { class: `fvs-clip${k % 2 ? ' alt' : ''}${s.id === S.sel ? ' on' : ''}`, 'data-id': s.id, style: { left: `${s.t0 * Z}px`, width: `${Math.max(3, s.dur * Z - 2)}px` }, title: `${s.id}${s.title ? ` · ${s.title}` : ''}\n${s.t0.toFixed(2)}–${s.t1.toFixed(2)} s · ${s.meta.length ?? ''}\n${t('hit-hint')}` });
      clip.append(h('div', { class: 'nm' }, h('b', { text: s.id }), s.title || ''));
      const lane = h('div', { class: 'lane' });
      s.hitTimes.forEach((ht, i) => {
        const r = rows.find(x => x.scene === s.id && x.hit === i);
        const cls = r ? (r.quiet ? 'quiet' : r.ok ? 'ok' : 'weak') : '';
        const on = S.selHit && S.selHit.scene === s.id && S.selHit.index === i;
        const m = h('div', { class: `fvs-hitm ${cls}${on ? ' on' : ''}`, style: { left: `${(ht - s.t0) * Z}px` }, title: `h${i} · ${s.hits[i]}${S.p.tempo ? ' beats' : ' s'} · ${ht.toFixed(2)} s${r ? ` · accent ${r.strength}${r.quiet ? ' (cut to quiet)' : ''}` : ''}` });
        m.addEventListener('pointerdown', e => dragHit(e, s, i, m));
        lane.append(m);
      });
      lane.addEventListener('dblclick', e => {
        if (e.target !== lane) return;
        const x = (e.clientX - lane.getBoundingClientRect().left) / Z;
        const beats = (snapT(s.t0 + x) - s.t0) / u;
        if (beats >= 0 && beats * u <= s.dur) tryCommit(src => P.setHits(src, s.id, [...s.hits, beats]));
      });
      const edge = h('div', { class: 'edge', title: t('roll-hint') });
      edge.addEventListener('pointerdown', e => dragEdge(e, s, edge));
      clip.append(lane, edge);
      clip.addEventListener('click', e => {
        if (e.target.closest('.fvs-hitm, .edge')) return;
        const was = S.sel;
        S.sel = s.id; S.selHit = null;
        if (S.time < s.t0 || S.time >= s.t1 || was === s.id) seek(was === s.id ? s.t0 + (e.clientX - clip.getBoundingClientRect().left) / Z : s.t0);
        renderTimeline(); renderSide();
      });
      clips.append(clip);
    });
    head.style.left = `${S.time * Z}px`;
    drawRuler(); drawWave(); renderErrors();
  }
  function canvasSize(c, w, hh) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), cw = Math.min(32000, Math.ceil(w * dpr));
    c.width = cw; c.height = Math.ceil(hh * dpr); c.style.width = `${w}px`; c.style.height = `${hh}px`;
    const g = c.getContext('2d'); g.setTransform(cw / w, 0, 0, dpr, 0, 0); return g;
  }
  function css(name, fb) { return getComputedStyle(root).getPropertyValue(name).trim() || fb; }
  function drawRuler() {
    const Z = S.zoom || 20, W = Math.ceil(S.p.length * Z) + 24;
    const g = canvasSize(ruler, W, 22);
    g.clearRect(0, 0, W, 22);
    const muted = css('--fv-muted', '#999'), line = css('--fv-line', '#333');
    g.font = '10px ui-monospace, monospace'; g.textBaseline = 'top';
    const tp = S.p.tempo;
    if (tp) {
      const every = [1, 2, 4, 8, 16].find(n => n * tp.bar * Z >= 34) || 32;
      for (let b = 0; b * tp.bar <= S.p.length + 1e-6; b++) {
        const x = b * tp.bar * Z;
        g.fillStyle = b % every ? line : muted; g.fillRect(x, b % every ? 12 : 4, 1, b % every ? 10 : 18);
        if (!(b % every)) { g.fillStyle = muted; g.fillText(String(b + 1), x + 3, 3); }
        if (tp.beat * Z >= 7) for (let k = 1; k < tp.beatsPerBar; k++) { g.fillStyle = line; g.fillRect(x + k * tp.beat * Z, 17, 1, 5); }
      }
    } else {
      const step = [1, 2, 5, 10, 30, 60].find(n => n * Z >= 40) || 120;
      for (let s = 0; s <= S.p.length; s += step) { const x = s * Z; g.fillStyle = muted; g.fillRect(x, 4, 1, 18); g.fillText(`${s}s`, x + 3, 3); }
    }
  }
  function drawWave() {
    const Z = S.zoom || 20, W = Math.ceil(S.p.length * Z) + 24, H = 58;
    const g = canvasSize(wave, W, H);
    g.clearRect(0, 0, W, H);
    const muted = css('--fv-muted', '#999');
    if (!audios.length) { g.fillStyle = muted; g.font = '11px system-ui'; g.fillText(t('sync-none'), 8, 24); return; }
    if (!S.analysis) return;
    const { peaks, env } = S.analysis;
    g.fillStyle = muted; g.globalAlpha = .55;
    for (let x = 0; x < W; x++) {
      const b0 = Math.floor(x / Z * 100), b1 = Math.max(b0 + 1, Math.floor((x + 1) / Z * 100));
      let m = 0; for (let b = b0; b < b1 && b < peaks.length; b++) if (peaks[b] > m) m = peaks[b];
      const hh = Math.min(1, m) * (H - 6);
      g.fillRect(x, (H - hh) / 2, 1, Math.max(1, hh));
    }
    g.globalAlpha = 1;
    // accents: local maxima of the onset envelope above 1.2 (1 = the 95th percentile)
    g.fillStyle = css('--fv-hit', '#ff6a13');
    const e = env.env;
    for (let k = 1; k < e.length - 1; k++) if (e[k] > 1.2 && e[k] >= e[k - 1] && e[k] > e[k + 1]) {
      const x = (k * env.hop + env.offset) * Z;
      g.globalAlpha = Math.min(1, (e[k] - 1) / 2); g.fillRect(x, 0, 1.5, 7);
    }
    g.globalAlpha = 1;
  }
  function scrub(e) {
    const r = inner.getBoundingClientRect();
    const go = ev => seek((ev.clientX - r.left) / (S.zoom || 20));
    go(e);
    const move = ev => go(ev), up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  ruler.addEventListener('pointerdown', scrub);
  wave.addEventListener('pointerdown', scrub);
  function dragEdge(e, s, edge) {
    e.preventDefault(); e.stopPropagation();
    const Z = S.zoom || 20, r = inner.getBoundingClientRect();
    const ghost = h('div', { class: 'fvs-tl-ghost', style: { left: `${s.t0 * Z}px`, width: `${s.dur * Z}px` } });
    inner.append(ghost); edge.classList.add('drag');
    let len = s.dur;
    const move = ev => { len = Math.max(grid(), snapT((ev.clientX - r.left) / Z) - s.t0); ghost.style.width = `${len * Z}px`; };
    const up = ev => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      ghost.remove(); edge.classList.remove('drag');
      if (Math.abs(len - s.dur) < 1e-6) return;
      tryCommit(src => (ev.altKey || !S.p.scenes[s.index + 1] ? P.setSceneLength(src, s.id, len) : P.rollCut(src, s.id, len)));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  function dragHit(e, s, i, m) {
    e.preventDefault(); e.stopPropagation();
    S.sel = s.id; S.selHit = { scene: s.id, index: i };
    root.querySelectorAll('.fvs-hitm.on').forEach(x => x.classList.remove('on')); m.classList.add('on');
    const Z = S.zoom || 20, r = inner.getBoundingClientRect(), u = P.hitUnit(S.p.tempo);
    let at = s.hitTimes[i], moved = false;
    const move = ev => { moved = true; at = Math.max(s.t0, Math.min(s.t1, snapT((ev.clientX - r.left) / Z))); m.style.left = `${(at - s.t0) * Z}px`; };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved) { seek(s.hitTimes[i]); renderSide(); return; }
      const hits = s.hits.slice(); hits[i] = Math.round((at - s.t0) / u * 1e4) / 1e4;
      S.selHit = null;
      tryCommit(src => P.setHits(src, s.id, hits));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  /* ───────── side panel ───────── */
  const field = (label, input, hint) => h('label', { class: 'fvs-field' }, h('span', { text: label }), input, hint ? h('small', { class: 'fvs-hint', text: hint }) : null);
  const input = (key, value, onCommit, extra = {}) => {
    const el = h('input', { class: 'fvs-input', 'data-key': key, value: value ?? '', ...extra });
    el.addEventListener('change', () => onCommit(el.value));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) el.blur(); });
    return el;
  };
  function codeArea(key, value, onApply) {
    const ta = h('textarea', { class: 'fvs-code', 'data-key': key, spellcheck: 'false', rows: Math.min(28, Math.max(6, (value || '').split('\n').length + 1)) });
    ta.value = value || '';
    const apply = () => { if (ta.value !== value) onApply(ta.value); };
    ta.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); apply(); }
      if (e.key === 'Tab' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const a = ta.selectionStart; ta.setRangeText('  ', a, ta.selectionEnd, 'end'); }
    });
    ta.addEventListener('blur', apply);
    return ta;
  }
  function renderSide() {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
    const focus = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const scroll = panel.scrollTop;
    panel.replaceChildren(...({ scene: sceneTab, text: textTab, code: codeTab, project: projectTab }[S.tab])());
    panel.scrollTop = scroll;
    if (focus) { const x = panel.querySelector(`[data-key="${CSS.escape(focus)}"]`); if (x) x.focus(); }
  }
  const selScene = () => (S.sel ? P.sceneById(S.p, S.sel) : null);

  function sceneTab() {
    const s = selScene();
    if (!s) return [h('p', { class: 'fvs-hint', text: t('scene-none') })];
    const tempo = S.p.tempo;
    const out = [];
    out.push(h('div', { class: 'fvs-row' },
      field(t('scene-id'), input('sid', s.id, v => { const nid = v.trim(), old = S.sel; S.sel = nid; if (!tryCommit(src => P.renameScene(src, s.id, nid, undefined))) { S.sel = old; renderSide(); } })),
      field(t('scene-title'), input('stitle', s.title, v => tryCommit(src => P.renameScene(src, s.id, undefined, v.trim()))))));
    out.push(h('div', { class: 'fvs-row' },
      field(t('scene-length'), input('slen', s.meta.length ?? '', v => tryCommit(src => { P.parseLength(v.trim(), tempo); return P.setSceneMeta(src, s.id, { length: /^\d+(\.\d+)?$/.test(v.trim()) ? +v : v.trim() }); })), t('length-hint')),
      field(t('scene-class'), input('sclass', s.meta.class ?? '', v => tryCommit(src => P.setSceneMeta(src, s.id, { class: v.trim() || null }))))));
    out.push(field(t('scene-hits'), input('shits', s.hits.join(', '), v => tryCommit(src => P.setHits(src, s.id, v.split(/[\s,，]+/).filter(Boolean).map(Number).filter(x => isFinite(x))))), tempo ? t('scene-hits-hint') : t('scene-hits-hint-sec')));
    out.push(h('div', { class: 'fvs-row' },
      h('button', { class: 'fvs-btn', disabled: s.index === 0, onclick: () => tryCommit(src => P.moveScene(src, s.id, s.index - 1)) }, `← ${t('move-up')}`),
      h('button', { class: 'fvs-btn', disabled: s.index === S.p.scenes.length - 1, onclick: () => tryCommit(src => P.moveScene(src, s.id, s.index + 1)) }, `${t('move-down')} →`),
      h('button', { class: 'fvs-btn', onclick: () => { const id = P.freeId(S.p, s.id); if (tryCommit(src => P.duplicateScene(src, s.id, id))) { S.sel = id; renderAll(); } } }, t('duplicate')),
      h('button', { class: 'fvs-btn', onclick: () => addScene(s.id) }, `+ ${t('add-scene')}`),
      h('button', { class: 'fvs-btn', onclick: () => { if (tryCommit(src => P.deleteScene(src, s.id))) notify(ctx, t('deleted', { id: s.id })); } }, t('delete'))));
    const timed = timedElements(s.html);
    if (timed.length) {
      out.push(h('h4', {}, t('timed')), h('p', { class: 'fvs-hint', text: t('timed-hint') }));
      const setA = (tag, name, v) => tryCommit(src => P.setSceneBlock(src, s.id, 'html', setAttr(P.sceneById(P.parseProject(src), s.id).html, tag, name, v === '' ? null : v)));
      out.push(h('div', { class: 'fvs-timed' }, h('small', { text: '' }), h('small', { text: t('appear') }), h('small', { text: t('disappear') }), h('small', { text: t('effect') })));
      for (const x of timed) {
        const fx = h('select', { class: 'fvs-input', 'aria-label': t('effect'), disabled: !!x.seq && x.in === undefined, onchange: e => setA(x.tag, 'data-fx', e.target.value === 'cut' ? '' : e.target.value) },
          ...['cut', 'fade', 'up', 'down', 'left', 'right', 'pop', 'type'].map(k => h('option', { value: k, selected: (x.fx || 'cut') === k }, k)));
        out.push(h('div', { class: 'fvs-timed' },
          h('span', { class: 'lbl', title: x.label, text: x.seq !== undefined ? `⧉ ${x.label} (seq ${x.seq})` : x.label }),
          input(`tin:${s.id}:${x.tag}`, x.seq !== undefined ? x.seq : x.in ?? '', v => setA(x.tag, x.seq !== undefined ? 'data-seq' : 'data-in', v.trim()), { 'aria-label': t('appear') }),
          input(`tout:${s.id}:${x.tag}`, x.out ?? '', v => setA(x.tag, 'data-out', v.trim()), { 'aria-label': t('disappear') }),
          fx));
      }
    }
    const errs = [...S.p.errors.filter(e => e.scene === s.id), ...S.runtimeErrors.filter(e => e.scene === s.id)];
    if (errs.length) out.push(h('h4', {}, t('problems')), h('div', { class: 'fvs-problems' }, ...errs.map(e => h('div', { class: e.level === 'warning' ? 'w' : 'e', text: `${e.line ? `line ${e.line}: ` : ''}${e.message}` }))));
    return out;
  }
  function addScene(after) {
    const id = P.freeId(S.p, 'scene');
    const tp = S.p.tempo;
    if (tryCommit(src => P.insertScene(src, after, { id, title: '', meta: { length: tp ? '1 bar' : '2s', hits: [0] }, html: `<div style="position:absolute;inset:0;display:grid;place-items:center;font-size:120px;font-weight:900" data-in="h0">${t('add-scene')}</div>` }))) {
      S.sel = id; const s = P.sceneById(S.p, id); if (s) seek(s.t0); renderAll();
    }
  }

  function textTab() {
    const out = [h('div', { class: 'fvs-row' }, h('p', { class: 'fvs-hint', style: { flex: '1' }, text: t('texts-hint') }),
      h('label', { class: 'fvs-row', style: { gap: '4px' } }, (() => { const c = h('input', { type: 'checkbox', checked: S.allTexts, onchange: e => { S.allTexts = e.target.checked; renderSide(); } }); return c; })(), h('small', { text: t('all-scenes') })))];
    const scenes = S.allTexts ? S.p.scenes : [selScene()].filter(Boolean);
    if (!scenes.length) return [h('p', { class: 'fvs-hint', text: t('scene-none') })];
    for (const s of scenes) {
      const runs = scan(s.html).texts;
      if (S.allTexts) out.push(h('h4', {}, h('button', { class: 'fvs-link', onclick: () => { S.sel = s.id; seek(s.t0); renderTimeline(); } }, `${s.id}${s.title ? ` · ${s.title}` : ''}`)));
      if (!runs.length) { out.push(h('p', { class: 'fvs-hint', text: t('texts-none') })); continue; }
      const list = h('div', { class: 'fvs-list' });
      runs.forEach(run => {
        const on = S.selText && S.selText.scene === s.id && S.selText.index === run.index;
        const ta = h('textarea', { class: 'fvs-input', 'data-key': `text:${s.id}:${run.index}`, rows: Math.min(5, Math.max(1, Math.ceil(run.text.trim().length / 30))), 'aria-label': run.text.trim().slice(0, 40) });
        ta.value = run.text.trim();
        const apply = () => { if (ta.value.trim() !== run.text.trim()) tryCommit(src => P.setSceneBlock(src, s.id, 'html', replaceText(P.sceneById(P.parseProject(src), s.id).html, run.index, ta.value))); };
        ta.addEventListener('change', apply);
        ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ta.blur(); } });
        ta.addEventListener('focus', () => post({ fvs: 'outline', scene: s.id, text: run.index }));
        ta.addEventListener('blur', () => post({ fvs: 'outline', scene: s.id }));
        const item = h('div', { class: `fvs-text-item${on ? ' on' : ''}` }, ta);
        const meta = h('div', { class: 'fvs-meta' }, h('span', { text: `#${run.index}` }), h('span', { class: 'fvs-grow' }));
        if (ctx.tangu && ctx.tangu.complete) meta.append(h('button', { class: 'fvs-link', onclick: () => aiRewrite(item, s, run) }, `✦ ${t('ai-rewrite')}`));
        item.append(meta);
        list.append(item);
        if (on) requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));
      });
      out.push(list);
      const imgs = images(s.html);
      if (imgs.length) {
        out.push(h('h4', {}, t('images')));
        for (const im of imgs) {
          const vp = joinPath(dirOf(path), im.src);
          const thumb = h('img', { alt: '', style: { width: '44px', height: '44px', objectFit: 'cover', borderRadius: '4px', background: '#222' } });
          assets.get(vp).then(u => { if (u) thumb.src = u; });
          const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: e => replaceImage(s, im, e.target.files[0]) });
          out.push(h('div', { class: 'fvs-row' }, thumb, h('span', { style: { flex: '1', fontSize: '12px', wordBreak: 'break-all' }, text: im.src }), file, h('button', { class: 'fvs-btn', onclick: () => file.click() }, t('replace-image'))));
        }
      }
    }
    return out;
  }
  async function aiRewrite(item, s, run) {
    // Electron has no window.prompt; the host's modal input is ctx.app.prompt
    const how = app.prompt ? await app.prompt(t('rewrite-prompt'), t('rewrite-default')) : t('rewrite-default');
    if (how === null || how === undefined) return;
    const box = h('div', { class: 'fvs-suggest', text: '…' });
    item.append(box);
    try {
      const v = await rewrite(ctx, run.text.trim(), how || t('rewrite-default'));
      if (!v) { box.remove(); return; }
      box.replaceChildren(h('div', { text: v }), h('div', { class: 'fvs-row' },
        h('button', { class: 'fvs-btn primary', onclick: () => tryCommit(src => P.setSceneBlock(src, s.id, 'html', replaceText(P.sceneById(P.parseProject(src), s.id).html, run.index, v))) }, t('accept')),
        h('button', { class: 'fvs-btn', onclick: () => box.remove() }, t('discard'))));
    } catch (e) { box.textContent = String(e && e.message || e); }
  }
  async function replaceImage(s, im, file) {
    if (!file || !app.writeBytes) return;
    const dir = dirOf(path);
    const name = file.name.replace(/[^\w.\-一-鿿]+/g, '-');
    const rel = `assets/${name}`;
    try {
      await app.writeBytes(joinPath(dir, rel), new Uint8Array(await file.arrayBuffer()));
      assets.cache.delete(joinPath(dir, rel));
      tryCommit(src => P.setSceneBlock(src, s.id, 'html', setAttr(P.sceneById(P.parseProject(src), s.id).html, im.tag, 'src', rel)));
    } catch (e) { notify(ctx, String(e && e.message || e), 'warn'); }
  }

  function codeTab() {
    const s = selScene();
    const scope = h('div', { class: 'fvs-row' },
      h('button', { class: `fvs-btn${S.codeScope === 'scene' ? ' primary' : ''}`, disabled: !s, onclick: () => { S.codeScope = 'scene'; renderSide(); } }, `${t('code-scene')}${s ? ` · ${s.id}` : ''}`),
      h('button', { class: `fvs-btn${S.codeScope === 'project' ? ' primary' : ''}`, onclick: () => { S.codeScope = 'project'; renderSide(); } }, t('code-project')));
    const out = [scope, h('p', { class: 'fvs-hint', text: t('code-apply') })];
    if (S.codeScope === 'scene' && s) {
      out.push(field(t('code-html'), codeArea(`c:${s.id}:html`, s.html, v => tryCommit(src => P.setSceneBlock(src, s.id, 'html', v)))));
      out.push(field(t('code-css'), codeArea(`c:${s.id}:css`, s.css, v => tryCommit(src => P.setSceneBlock(src, s.id, 'css', v)))));
      out.push(field(t('code-js'), codeArea(`c:${s.id}:js`, s.js, v => tryCommit(src => P.setSceneBlock(src, s.id, 'js', v)))));
    } else {
      const blocks = P.cssBlocks(S.p);
      (blocks.length ? blocks : ['']).forEach((b, i) => out.push(field(`${t('code-global-css')}${blocks.length > 1 ? ` ${i + 1}` : ''}`, codeArea(`g:css:${i}`, b, v => tryCommit(src => P.setProjectBlock(src, 'css', v, i))))));
      out.push(field(t('code-stage-html'), codeArea('g:html', P.stageHtml(S.p), v => tryCommit(src => P.setProjectBlock(src, 'html', v)))));
      out.push(field(t('code-stage-js'), codeArea('g:js', P.stageJs(S.p), v => tryCommit(src => P.setProjectBlock(src, 'js', v)))));
    }
    return out;
  }

  function projectTab() {
    const m = S.p.meta, tp = S.p.tempo;
    const setM = patch => tryCommit(src => P.setProjectMeta(src, patch));
    const num = (k, v) => { const x = +v; return isFinite(x) && x > 0 ? x : null; };
    const out = [];
    out.push(h('p', { class: 'fvs-hint', text: t('project-length', { len: S.p.length.toFixed(2), n: S.p.scenes.length }) }));
    out.push(field(t('project-title'), input('ptitle', m.title || '', v => setM({ title: v.trim() || null }))));
    const presets = [[1920, 1080], [1440, 1080], [1080, 1920], [1080, 1080], [3840, 2160]];
    out.push(h('div', { class: 'fvs-row' },
      field(t('project-size'), h('select', { class: 'fvs-input', onchange: e => { const [w, hh] = e.target.value.split('x').map(Number); if (w) setM({ width: w, height: hh }); } },
        h('option', { value: '', text: `${m.width}×${m.height}` }), ...presets.map(([w, hh]) => h('option', { value: `${w}x${hh}`, text: `${w}×${hh}` })))),
      field(t('project-fps'), input('pfps', m.fps, v => num('fps', v) && setM({ fps: num('fps', v) }), { type: 'number', min: '1', max: '120' }))));
    out.push(h('div', { class: 'fvs-row' },
      field(t('project-bpm'), input('pbpm', tp ? tp.bpm : '', v => setM({ tempo: +v > 0 ? { bpm: +v, beatsPerBar: tp ? tp.beatsPerBar : 4 } : null }), { type: 'number', min: '20', max: '400' })),
      field(t('project-meter'), input('pmeter', tp ? tp.beatsPerBar : 4, v => tp && +v > 0 && setM({ tempo: { bpm: tp.bpm, beatsPerBar: +v } }), { type: 'number', min: '1', max: '16', disabled: !tp })),
      field(t('project-bg'), input('pbg', m.background || '', v => setM({ background: v.trim() || null })))));
    // audio
    out.push(h('h4', {}, t('project-audio')));
    const raw = Array.isArray(m.audio) ? m.audio : m.audio ? [m.audio] : [];
    const tracks = raw.map(a => (typeof a === 'string' ? { src: a } : { ...a }));
    const setTracks = next => setM({ audio: next });
    tracks.forEach((a, i) => out.push(h('div', { class: 'fvs-row' },
      field('src', input(`au:${i}:src`, a.src, v => { tracks[i] = { ...a, src: v.trim() }; setTracks(tracks); })),
      field(t('audio-at'), input(`au:${i}:at`, a.at ?? 0, v => { tracks[i] = { ...a, at: +v || undefined }; setTracks(tracks); }, { type: 'number', step: '0.01' })),
      field(t('audio-gain'), input(`au:${i}:gain`, a.gain ?? 0, v => { tracks[i] = { ...a, gain: +v || undefined }; setTracks(tracks); }, { type: 'number', step: '0.5' })),
      h('button', { class: 'fvs-btn', onclick: () => setTracks(tracks.filter((_, k) => k !== i)) }, t('audio-remove')))));
    const file = h('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: async e => {
      const f = e.target.files[0]; if (!f || !app.writeBytes) return;
      const rel = `audio/${f.name.replace(/[^\w.\-一-鿿]+/g, '-')}`;
      try { await app.writeBytes(joinPath(dirOf(path), rel), new Uint8Array(await f.arrayBuffer())); setTracks([...tracks, { src: rel, role: tracks.length ? 'track' : 'score' }]); } catch (err) { notify(ctx, String(err && err.message || err), 'warn'); }
    } });
    out.push(h('div', { class: 'fvs-row' }, file, h('button', { class: 'fvs-btn', disabled: !app.writeBytes, onclick: () => file.click() }, t('audio-add'))));
    // sync
    out.push(h('h4', {}, t('sync'), h('span', { class: 'fvs-grow' }), S.sync && S.sync.some(r => !r.ok) ? h('button', { class: 'fvs-link', onclick: () => handOff(ctx, S, TASKS.sync(), t) }, `✦ ${t('sync-fix')}`) : null));
    if (!tracks.length) out.push(h('p', { class: 'fvs-hint', text: t('sync-none') }));
    else if (!S.sync) out.push(h('p', { class: 'fvs-hint', text: t('sync-analyzing') }));
    else {
      const bad = S.sync.filter(r => !r.ok);
      out.push(h('p', { class: 'fvs-hint', text: bad.length ? t('sync-bad', { n: S.sync.length, bad: bad.length }) : t('sync-ok', { n: S.sync.length }) }));
      for (const r of bad) out.push(h('button', { class: 'fvs-link', style: { justifySelf: 'start' }, onclick: () => { S.sel = r.scene; seek(r.t); renderTimeline(); } }, `${r.t.toFixed(2)} s · ${r.scene} h${r.hit} · accent ${r.strength}`));
    }
    // problems
    const probs = [...S.p.errors, ...S.runtimeErrors.map(e => ({ level: 'error', ...e }))];
    out.push(h('h4', {}, t('problems')));
    out.push(probs.length ? h('div', { class: 'fvs-problems' }, ...probs.map(e => h('div', { class: e.level === 'warning' ? 'w' : 'e', text: `${e.scene ? `[${e.scene}] ` : ''}${e.line ? `line ${e.line}: ` : ''}${e.message}` }))) : h('p', { class: 'fvs-hint', text: t('no-problems') }));
    return out;
  }

  function renderAll() { renderTransport(); renderTimeline(); renderSide(); }

  /* ───────── popovers: ask AI, export ───────── */
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function place(node, anchor) {
    const r = anchor.getBoundingClientRect(), R = root.getBoundingClientRect();
    node.style.top = `${r.bottom - R.top + 6}px`;
    node.style.right = `${Math.max(8, R.right - r.right)}px`;
  }
  function openAsk(anchor) {
    if (pop) return closePop();
    const ta = h('textarea', { class: 'fvs-input', placeholder: t('ai-placeholder'), 'aria-label': t('ai-title') });
    const send = text => { if (!text.trim()) return; closePop(); handOff(ctx, S, TASKS.ask(text.trim()), t); };
    const chips = [['ai-chip-scene', null], ['ai-chip-pace', null], ['ai-chip-copy', null], ['ai-chip-score', () => TASKS.score()], ['ai-chip-sync', () => TASKS.sync()], ['ai-chip-review', () => TASKS.review()]];
    pop = h('div', { class: 'fvs-pop', role: 'dialog', 'aria-label': t('ai-title') }, h('h3', { text: t('ai-title') }), ta,
      h('div', { class: 'fvs-chips' }, ...chips.map(([k, task]) => h('button', { onclick: () => { if (task) { closePop(); handOff(ctx, S, task(), t); } else { ta.value = t(k) + (t.en() ? ': ' : '：'); ta.focus(); } } }, t(k)))),
      h('div', { class: 'fvs-row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'fvs-btn primary', onclick: () => send(ta.value) }, t('ai-send'))));
    ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(ta.value); if (e.key === 'Escape') closePop(); });
    place(pop, anchor); root.append(pop); ta.focus();
  }
  function openExport(anchor) {
    if (pop) return closePop();
    const mp4 = path.replace(/\.fvs\.md$/i, '') + '.mp4';
    const item = (label, hint, fn) => h('button', { role: 'menuitem', onclick: () => { closePop(); fn(); } }, h('span', { text: label }), h('small', { text: hint }));
    pop = h('div', { class: 'fvs-menu', role: 'menu' },
      item(t('export-html'), t('export-html-hint'), async () => { try { const out = await exportHtml(ctx, S.p, path, assets); notify(ctx, t('exported', { path: out })); } catch (e) { notify(ctx, String(e && e.message || e), 'warn'); } }),
      item(t('export-mp4'), t('export-mp4-hint'), () => handOff(ctx, S, TASKS.render(app.hostPath ? app.hostPath(mp4) || mp4 : mp4), t)),
      item(t('export-cmd'), t('export-cmd-hint'), async () => {
        let tools = null; try { tools = await ensureTools(ctx); } catch { tools = null; }
        const abs = app.hostPath ? app.hostPath(path) : null;
        const cmd = `node "${(tools && (tools.cliAbs || tools.cli)) || 'fvs.mjs'}" render "${abs || path}" --out "${(app.hostPath && app.hostPath(mp4)) || mp4}"`;
        try { await navigator.clipboard.writeText(cmd); } catch { /* shown below */ }
        notify(ctx, cmd);
      }));
    place(pop, anchor); root.append(pop);
    pop.querySelector('button').focus();
  }
  const onDocDown = e => { if (pop && !pop.contains(e.target) && !e.target.closest('.fvs-bar')) closePop(); };
  document.addEventListener('pointerdown', onDocDown, true);

  /* ───────── keys, layout ───────── */
  root.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (typing(e)) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') { closePop(); return; }
    if (e.code === 'Space') { e.preventDefault(); toggle(); return; }
    const beat = S.p.tempo ? S.p.tempo.beat : .5, frame = 1 / (+S.p.meta.fps || 30);
    if (e.key === 'ArrowRight') { e.preventDefault(); seek(S.time + (e.shiftKey ? beat : frame)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); seek(S.time - (e.shiftKey ? beat : frame)); }
    if (e.key === 'Home') seek(0);
    if (e.key === 'End') seek(S.p.length);
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selHit) {
      e.preventDefault();
      const { scene, index } = S.selHit; S.selHit = null;
      const s = P.sceneById(S.p, scene);
      if (s) tryCommit(src => P.setHits(src, scene, s.hits.filter((_, k) => k !== index)));
    }
  });
  // clicks on the timeline and the toolbar keep the keyboard on the editor (Space, arrows, ⌘Z)
  root.addEventListener('pointerdown', e => { if (!e.target.closest('input,textarea,select,.fvs-pop,.fvs-inline')) setTimeout(() => { if (!root.contains(document.activeElement) || document.activeElement === document.body) root.focus({ preventScroll: true }); }); });
  const ro = new ResizeObserver(() => {
    root.classList.toggle('narrow', root.clientWidth < 860);
    if (!S.zoom || S.zoom <= (scroller.clientWidth - 24) / Math.max(1, S.p.length) * 1.01) setZoom(0);
  });
  ro.observe(root);

  load();
  raf = requestAnimationFrame(loop);
  return () => {
    S.disposed = true;
    cancelAnimationFrame(raf);
    clearTimeout(previewTimer); clearTimeout(pendingTimer);
    if (S.text !== S.saved) save();
    if (unwatch) unwatch();
    clearInterval(poll);
    window.removeEventListener('message', onMessage);
    document.removeEventListener('pointerdown', onDocDown, true);
    ro.disconnect();
    for (const a of audios) { a.el.pause(); if (a.blob) URL.revokeObjectURL(a.url); }
    root.remove();
  };
}
