// The runtime: mounts a compiled project (see lib/compile.js) as a stage and plays or captures it.
// Loaded into every page the Studio makes: the preview, the HTML export and the renderer's capture page.
import { createStage, grain, EASE, prog, clamp, lerp, rng } from './engine.js';

const BASE_CSS = `
.fvs-stage{position:relative;overflow:hidden;transform-origin:0 0}
.fvs-scenes{position:absolute;inset:0}
.fvs-scene{position:absolute;inset:0;overflow:hidden}
[data-fvs-flash]{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
`;

/* ───────── time expressions: "h3", "h3+0.5", "2b", "1.5s", "end-1", "0.25" ───────── */
const TIME = /^\s*(?:(h)(\d+)|(end|start))?\s*(?:([+-])?\s*(\d*\.?\d+)\s*(b|beats?|s|secs?)?)?\s*$/i;
export function timeExpr(expr, sc, unit, beat) {
  const m = String(expr).match(TIME);
  if (!m || (!m[1] && !m[3] && !m[5])) throw new Error(`cannot read time "${expr}" (use h3, h3+0.5, 2b, 1.5s or end-1)`);
  let t = sc.t0;
  if (m[1]) { const i = +m[2]; if (!(i < sc.hits.length)) throw new Error(`"${expr}": this scene has ${sc.hits.length} hits (h0–h${sc.hits.length - 1})`); t = sc.hits[i]; }
  if (m[3] === 'end') t = sc.t1;
  if (m[5]) {
    const x = +m[5] * (m[4] === '-' ? -1 : 1), u = (m[6] || '').toLowerCase();
    t += x * (u.startsWith('b') ? beat : u.startsWith('s') ? 1 : unit);
  }
  return t;
}

/** Mount a payload into `container`. Returns the controller the page, the Studio and the renderer drive. */
export function mount(payload, container, { doc = document, onScene = null } = {}) {
  const P = payload, errors = [];
  const tempo = P.tempo, beat = tempo ? 60 / tempo.bpm : .5, bar = beat * (tempo ? tempo.beatsPerBar : 4), unit = tempo ? beat : 1;

  const style = doc.createElement('style');
  style.setAttribute('data-fvs', '');
  style.textContent = BASE_CSS + '\n' + (P.css || '') + '\n' + P.scenes.filter(s => s.css && s.css.trim()).map(s => `[data-scene="${s.id}"]{\n${s.css}\n}`).join('\n');
  doc.head.append(style);

  const root = doc.createElement('div');
  root.className = `fvs-stage ${P.className || ''}`.trim();
  Object.assign(root.style, { width: `${P.width}px`, height: `${P.height}px`, background: P.background || '#000' });
  root.innerHTML = P.stage.html || '';
  let box = root.querySelector('[data-fvs-scenes], fvs-scenes');
  const holder = doc.createElement('div');
  holder.className = 'fvs-scenes';
  if (box) box.replaceWith(holder); else root.prepend(holder);
  box = holder;
  container.append(root);

  const F = createStage(root);
  const flashes = [];
  const scenes = {};
  const assets = P.assets || {};
  const asset = rel => assets[String(rel).replace(/^\.\//, '')] || rel;

  for (const s of P.scenes) {
    const el = doc.createElement('div');
    el.className = `fvs-scene scene ${s.cls || ''}`.trim();
    el.dataset.scene = s.id;
    el.innerHTML = s.html || '';
    box.append(el);
    F.S(el, s.t0, s.t1);
    scenes[s.id] = { id: s.id, title: s.title, t0: s.t0, t1: s.t1, dur: s.t1 - s.t0, hits: s.hits, beats: s.beats, el };
    if (onScene) onScene(scenes[s.id]);
  }

  /* the API a script sees; string selectors resolve inside `scope` */
  function api(sc, scope) {
    const q = sel => (typeof sel === 'string' ? [...scope.querySelectorAll(sel)] : sel == null ? [] : sel instanceof Element ? [sel] : [...sel]);
    const K = (sel, kfs, opt) => F.K(q(sel), kfs, opt);
    const S = (sel, a, b) => F.S(q(sel), a, b);
    const at = x => sc.t0 + x * unit;
    const hit = (i, off = 0) => (i < sc.hits.length ? sc.hits[i] + off * unit : NaN);
    const cut = (sel, t, opt) => K(sel, [[t - .01, { o: 0 }], [t, { o: 1 }, 'step']], opt);
    const slide = (sel, t, from = { y: 20 }, opt) => K(sel, [[t - .01, { o: 0, ...from }], [t, { o: 1 }, 'step'], [t + .18, { x: 0, y: 0 }, 'out']], opt);
    const fade = (sel, t, d = beat / 2, opt) => K(sel, [[t, { o: 0 }], [t + d, { o: 1 }, 'out']], opt);
    const seq = (sel, times, end = sc.t1) => q(sel).forEach((el, i) => i < times.length && F.S(el, times[i], times[i + 1] ?? end));
    return {
      t0: sc.t0, t1: sc.t1, dur: sc.t1 - sc.t0, hits: sc.hits || [], beat, bar, unit, at, hit,
      root: scope, stage: root, $: sel => scope.querySelector(sel), $$: sel => [...scope.querySelectorAll(sel)],
      K, S, H: fn => F.H(fn), on: fn => F.H(fn), type: (sel, a, cps, gap) => F.type(q(sel), a, cps, gap),
      cut, slide, fade, seq, flash: (t, o = .85) => flashes.push([t, o]), grain: (sel = '.grain') => grain({ q, H: F.H }, sel),
      prog, ease: EASE, clamp, lerp, rng, scenes, flashes, asset,
      project: { title: P.title, width: P.width, height: P.height, fps: P.fps, length: P.length, tempo },
      width: P.width, height: P.height, fps: P.fps, length: P.length,
      during: ids => ids.map(id => (Array.isArray(id) ? id : scenes[id] ? [scenes[id].t0, scenes[id].t1] : [0, 0])),
      inside: (t, spans) => spans.some(([a, b]) => t >= a && t < b),
    };
  }

  function run(js, A, where, line) {
    if (!js || !js.trim()) return;
    const names = Object.keys(A);
    try {
      // eslint-disable-next-line no-new-func
      new Function(...names, `${js}\n//# sourceURL=fvs://${where}.js`)(...names.map(k => A[k]));
    } catch (e) {
      const m = String(e && e.stack || '').match(new RegExp(`fvs://${where.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.js:(\\d+)`));
      errors.push({ scene: where.replace(/^scene\//, ''), message: String(e && e.message || e), line: m && line ? line + +m[1] - 3 : line || 0 });
    }
  }

  function declarative(sc, A) {
    const t = (expr, el) => { try { return timeExpr(expr, sc, unit, beat); } catch (e) { errors.push({ scene: sc.id, message: e.message, line: 0, el: el.tagName }); return NaN; } };
    for (const el of sc.el.querySelectorAll('[data-seq]')) {
      const m = String(el.dataset.seq).match(/^\s*h(\d+)\s*$/);
      if (!m) { errors.push({ scene: sc.id, message: `data-seq="${el.dataset.seq}" must name the first hit, e.g. data-seq="h0"` }); continue; }
      const kids = [...el.children], k = +m[1];
      const times = kids.map((_, i) => sc.hits[k + i]).filter(x => x !== undefined);
      if (times.length < kids.length) errors.push({ scene: sc.id, message: `data-seq has ${kids.length} items but only ${times.length} hits from h${k}` });
      A.seq(kids, times, el.dataset.seqEnd ? t(el.dataset.seqEnd, el) : sc.t1);
    }
    for (const el of sc.el.querySelectorAll('[data-in], [data-out]')) {
      const each = el.dataset.each !== undefined ? +el.dataset.each * unit : null;
      const targets = each !== null ? [...el.children] : [el];
      const tin = el.dataset.in !== undefined ? t(el.dataset.in, el) : null;
      const tout = el.dataset.out !== undefined ? t(el.dataset.out, el) : null;
      const fx = (el.dataset.fx || 'cut').toLowerCase(), outFx = (el.dataset.fxOut || 'cut').toLowerCase();
      const dist = +el.dataset.dist || 24, dur = el.dataset.dur !== undefined ? +el.dataset.dur * unit : beat / 2;
      targets.forEach((node, i) => {
        const a = tin === null ? null : tin + (each || 0) * i;
        const kf = [];
        if (a !== null && !isNaN(a)) {
          if (fx === 'type') F.type([node], a, +el.dataset.cps || 30);
          else if (fx === 'fade') kf.push([a, { o: 0 }], [a + dur, { o: 1 }, 'out']);
          else if (fx === 'pop') kf.push([a - .01, { o: 0, s: .92 }], [a, { o: 1 }, 'step'], [a + .25, { s: 1 }, 'back']);
          else if (/^(up|down|left|right)$/.test(fx)) {
            const from = { up: { y: dist }, down: { y: -dist }, left: { x: dist }, right: { x: -dist } }[fx];
            kf.push([a - .01, { o: 0, ...from }], [a, { o: 1 }, 'step'], [a + .18, { x: 0, y: 0 }, 'out']);
          } else kf.push([a - .01, { o: 0 }], [a, { o: 1 }, 'step']);
        }
        if (tout !== null && !isNaN(tout)) {
          if (outFx === 'fade') { if (!kf.length) kf.push([sc.t0, { o: 1 }]); kf.push([tout, { o: 1 }], [tout + dur, { o: 0 }, 'in']); }
          else F.S([node], -1e9, tout);
        }
        if (kf.length) F.K([node], kf);
      });
    }
  }

  for (const s of P.scenes) {
    const sc = scenes[s.id];
    const A = api(sc, sc.el);
    declarative(sc, A);
    run(s.js, A, `scene/${s.id}`, s.line);
  }
  run(P.stage.js, api({ id: 'stage', t0: 0, t1: P.length, hits: [], el: root }, root), 'stage', P.stage.line);

  const flashEls = [...root.querySelectorAll('[data-fvs-flash]')];
  if (flashEls.length) {
    flashes.sort((a, b) => a[0] - b[0]);
    F.H(t => { let o = 0; for (const [ft, fo] of flashes) if (t >= ft && t < ft + .18) o = Math.max(o, fo * (1 - (t - ft) / .18) ** 2); for (const el of flashEls) el.style.opacity = o; });
  }

  /* frame times and beat times are both exact on paper; the nudge keeps float error from pushing a cut one frame late */
  const seek = t => F.render(t + 1e-4);
  return {
    root, errors, scenes, seek, payload: P,
    length: P.length, width: P.width, height: P.height, fps: P.fps,
    destroy() { root.remove(); style.remove(); },
  };
}
