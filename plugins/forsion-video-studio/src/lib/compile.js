// Project → runtime payload → standalone HTML. DOM-free: used by the plugin, the CLI and tests.
import { cssBlocks, stageHtml, stageJs } from './project.js';

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;
export const isRelativeUrl = u => !!u && !ABSOLUTE.test(u.trim()) && !/^\$\{/.test(u) && !/^%%/.test(u);

const ATTR = /(\s(?:src|href|poster|xlink:href)\s*=\s*)(["'])([^"']*)\2/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/** Every relative asset reference in a chunk of html / css (for listing and resolving). */
export function assetRefs(html = '', css = '') {
  const out = new Set();
  for (const m of html.matchAll(ATTR)) if (isRelativeUrl(m[3])) out.add(clean(m[3]));
  for (const m of (html + '\n' + css).matchAll(CSS_URL)) if (isRelativeUrl(m[2])) out.add(clean(m[2]));
  return [...out];
}
const clean = u => u.trim().replace(/^\.\//, '');

export const rewriteHtml = (html, map) => html.replace(ATTR, (m, pre, q, u) => (isRelativeUrl(u) && map[clean(u)] ? `${pre}${q}${map[clean(u)]}${q}` : m));
export const rewriteCss = (css, map) => css.replace(CSS_URL, (m, q, u) => (isRelativeUrl(u) && map[clean(u)] ? `url(${q}${map[clean(u)]}${q})` : m));

/** Settings lists that may be written as one string or an array. */
const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Audio tracks: "a.mp3" or { "src": "a.mp3", "at": 0, "gain": -3, "role": "score" }. */
export function audioTracks(meta) {
  return list(meta.audio).map((a, i) => (typeof a === 'string' ? { src: a } : a)).filter(a => a && a.src)
    .map((a, i) => ({ id: a.id || `a${i}`, src: String(a.src), at: +a.at || 0, gain: +a.gain || 0, role: a.role || (i ? 'track' : 'score') }));
}

/**
 * The payload the runtime mounts. `resolve(relPath)` turns a project-relative asset path into a URL the
 * page can load (the Studio uses vault asset URLs; the HTML export keeps them relative or inlines them).
 */
export function compile(p, { resolve = u => u } = {}) {
  const css = cssBlocks(p).join('\n\n');
  const refs = new Set([...assetRefs(stageHtml(p), css), ...list(p.meta.assets).map(clean)]);
  for (const s of p.scenes) for (const r of assetRefs(s.html, s.css)) refs.add(r);
  const audio = audioTracks(p.meta);
  const map = {};
  for (const r of refs) map[r] = resolve(r);
  const jsLine = k => (k >= 0 ? p.toks[k].line + 1 : 0);
  return {
    v: 1,
    title: p.meta.title || '',
    lang: p.meta.lang || 'zh-CN',
    width: +p.meta.width, height: +p.meta.height, fps: +p.meta.fps,
    length: p.length,
    tempo: p.tempo ? { bpm: p.tempo.bpm, beatsPerBar: p.tempo.beatsPerBar } : null,
    background: p.meta.background || '#000',
    className: p.meta.class || '',
    fonts: list(p.meta.fonts),
    css: rewriteCss(css, map),
    stage: { html: rewriteHtml(stageHtml(p), map), js: stageJs(p), line: jsLine(p.stageJs) },
    scenes: p.scenes.map(s => ({
      id: s.id, title: s.title, t0: s.t0, t1: s.t1, hits: s.hitTimes, beats: s.hits,
      cls: s.meta.class || '', html: rewriteHtml(s.html, map), css: rewriteCss(s.css, map), js: s.js,
      line: jsLine(s.jsTok), htmlLine: jsLine(s.htmlTok),
    })),
    audio: audio.map(a => ({ ...a, url: resolve(a.src) })),
    assets: map,
  };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** JSON that is safe inside a <script> element. */
export const scriptJSON = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * A standalone page: the payload, the runtime and a mode.
 *   mode 'player'  – a page with a transport and chapter list (what "Export HTML" writes)
 *   mode 'capture' – the bare stage at 1:1 with window.__stage.seek(t) (what the renderer drives)
 *   mode 'embed'   – the stage fitted to the window, driven by the Studio through window.__fvs
 */
export function buildHtml(payload, runtimeSource, { mode = 'player', extraHead = '' } = {}) {
  const fonts = payload.fonts.map(u => `<link rel="stylesheet" href="${esc(u)}">`).join('\n');
  return `<!doctype html>
<html lang="${esc(payload.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(payload.title || 'Forsion Video Studio')}</title>
<meta name="generator" content="Forsion Video Studio">
${fonts}
${extraHead}
</head>
<body>
<script type="application/json" id="fvs-data">${scriptJSON(payload)}</script>
<script>${runtimeSource.replace(/<\/script/gi, '<\\/script')}</script>
<script>FVS.boot(${JSON.stringify(mode)});</script>
</body>
</html>
`;
}
