#!/usr/bin/env node
/* Forsion Video Studio 0.1.0 — built from src/ by build.mjs; edit the sources, not this file. */

// src/cli/fvs.js
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, basename, extname, sep, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir, homedir, platform } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

// src/lib/project.js
var FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
var HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
var SCENE_HEAD = /^([A-Za-z][\w-]*)(?:\s*(?:·|—|–|-|:|：|\|)\s*(.*))?$/;
var DEFAULTS = { width: 1920, height: 1080, fps: 30 };
function tokenize(src) {
  const eol = /\r\n/.test(src) ? "\r\n" : "\n";
  const text = src.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const endsWithNl = text.endsWith("\n");
  if (endsWithNl) lines.pop();
  const toks = [];
  let buf = [], bufLine = 1;
  const flush = () => {
    if (buf.length) {
      toks.push({ kind: "text", raw: buf.join(""), line: bufLine });
      buf = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const nl = i < lines.length - 1 || endsWithNl ? "\n" : "";
    const line = lines[i];
    const f = line.match(FENCE_OPEN);
    if (f && !(f[2][0] === "`" && f[3].includes("`"))) {
      flush();
      const fence = f[2], info = f[3].trim();
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
      const body = [];
      let j = i + 1, closed = false;
      for (; j < lines.length; j++) {
        if (close.test(lines[j])) {
          closed = true;
          break;
        }
        body.push(lines[j]);
      }
      const last = closed ? j : lines.length - 1;
      const rawLines = lines.slice(i, last + 1);
      const rawNl = last < lines.length - 1 || endsWithNl ? "\n" : "";
      const [lang = "", ...tags] = info.split(/\s+/).filter(Boolean);
      toks.push({ kind: "fence", raw: rawLines.join("\n") + rawNl, line: i + 1, fence, info, lang: lang.toLowerCase(), tags: tags.map((t) => t.toLowerCase()), body: body.join("\n"), closed, indent: f[1] });
      i = last;
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      flush();
      toks.push({ kind: "heading", raw: line + nl, line: i + 1, level: h[1].length, text: h[2] });
      continue;
    }
    if (!buf.length) bufLine = i + 1;
    buf.push(line + nl);
  }
  flush();
  return { toks, eol };
}
var UNIT = /^\s*(-?\d+(?:\.\d+)?)\s*(bars?|beats?|b|s|sec|secs|seconds?|ms|小节|拍|秒)?\s*$/i;
function tempoOf(meta) {
  const t = meta && meta.tempo;
  if (!t || !(+t.bpm > 0)) return null;
  const beatsPerBar = +t.beatsPerBar > 0 ? +t.beatsPerBar : 4;
  const beat = 60 / +t.bpm;
  return { bpm: +t.bpm, beatsPerBar, beat, bar: beat * beatsPerBar };
}
function parseLength(v, tempo) {
  if (typeof v === "number" && isFinite(v)) return v;
  const m = typeof v === "string" && v.match(UNIT);
  if (!m) throw new Error(`cannot read length ${JSON.stringify(v)} (use "4 bars", "6 beats" or "2.5s")`);
  const x = +m[1], u = (m[2] || "s").toLowerCase();
  if (/^(bars?|小节)$/.test(u)) {
    if (!tempo) throw new Error(`"${v}" needs a tempo in the project settings`);
    return x * tempo.bar;
  }
  if (/^(beats?|b|拍)$/.test(u)) {
    if (!tempo) throw new Error(`"${v}" needs a tempo in the project settings`);
    return x * tempo.beat;
  }
  if (u === "ms") return x / 1e3;
  return x;
}
var round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
var hitUnit = (tempo) => tempo ? tempo.beat : 1;
function readJSON(tok, where, errors) {
  if (!tok.body.trim()) return {};
  try {
    const v = JSON.parse(tok.body);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("settings must be a JSON object");
    return v;
  } catch (e) {
    errors.push({ level: "error", line: tok.line, scene: where, message: `invalid JSON in settings: ${e.message}` });
    return null;
  }
}
var isFvs = (t) => t.kind === "fence" && (t.lang === "fvs" || t.lang === "json" && t.tags.includes("fvs"));
var isLang = (t, ...langs) => t.kind === "fence" && langs.includes(t.lang) && !isFvs(t);
var LANG = { html: ["html", "htm"], js: ["js", "javascript", "mjs"], css: ["css"] };
function parseProject(src) {
  const { toks, eol } = tokenize(String(src ?? ""));
  const errors = [];
  const p = { eol, toks, meta: { ...DEFAULTS }, metaTok: -1, rawMeta: null, css: [], stageHtml: -1, stageJs: -1, scenes: [], errors };
  let i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === "heading" && t.level === 2) break;
    if (t.kind === "fence" && !t.closed) errors.push({ level: "error", line: t.line, message: "code block is never closed" });
    if (isFvs(t)) {
      if (p.metaTok >= 0) {
        errors.push({ level: "warning", line: t.line, message: "second project settings block ignored" });
        continue;
      }
      p.metaTok = i;
      const m = readJSON(t, null, errors);
      if (m) {
        p.rawMeta = m;
        p.meta = { ...DEFAULTS, ...m };
      }
    } else if (isLang(t, ...LANG.css)) p.css.push(i);
    else if (isLang(t, ...LANG.html) && (t.tags.includes("stage") || p.stageHtml < 0)) {
      if (p.stageHtml < 0) p.stageHtml = i;
    } else if (isLang(t, ...LANG.js) && (t.tags.includes("stage") || p.stageJs < 0)) {
      if (p.stageJs < 0) p.stageJs = i;
    }
  }
  if (p.metaTok < 0) errors.push({ level: "warning", line: 1, message: "no ```fvs project settings block; using 1920\xD71080 at 30 fps" });
  while (i < toks.length) {
    const head = toks[i];
    const s = { head: i, first: i, last: i, metaTok: -1, htmlTok: -1, jsTok: -1, cssTok: -1, meta: {}, title: "", id: "" };
    const hm = head.text.match(SCENE_HEAD);
    if (hm) {
      s.id = hm[1];
      s.title = (hm[2] || "").trim();
    } else {
      s.id = "";
      s.title = head.text;
      errors.push({ level: "error", line: head.line, message: `scene heading "${head.text}" must start with an id (letters, digits, - or _), e.g. "## intro \xB7 \u5F00\u573A"` });
    }
    for (i++; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind === "heading" && t.level <= 2) break;
      s.last = i;
      if (t.kind === "fence" && !t.closed) errors.push({ level: "error", line: t.line, scene: s.id, message: "code block is never closed" });
      if (isFvs(t)) {
        if (s.metaTok < 0) {
          s.metaTok = i;
          s.meta = readJSON(t, s.id, errors) || {};
        }
      } else for (const k of ["html", "js", "css"]) if (isLang(t, ...LANG[k])) {
        if (s[`${k}Tok`] < 0) s[`${k}Tok`] = i;
        else errors.push({ level: "warning", line: t.line, scene: s.id, message: `second \`${k}\` block in scene "${s.id}" is ignored` });
      }
    }
    if (head.level === 1) continue;
    p.scenes.push(s);
  }
  computeTimeline(p);
  return p;
}
function computeTimeline(p) {
  const tempo = tempoOf(p.meta);
  p.tempo = tempo;
  const seen = /* @__PURE__ */ new Set();
  let t = 0;
  for (const [k, s] of p.scenes.entries()) {
    s.index = k;
    s.html = s.htmlTok >= 0 ? p.toks[s.htmlTok].body : "";
    s.js = s.jsTok >= 0 ? p.toks[s.jsTok].body : "";
    s.css = s.cssTok >= 0 ? p.toks[s.cssTok].body : "";
    s.line = p.toks[s.head].line;
    if (s.id && seen.has(s.id)) p.errors.push({ level: "error", line: s.line, scene: s.id, message: `duplicate scene id "${s.id}"` });
    seen.add(s.id);
    let len = 0;
    try {
      if (s.meta.length === void 0) throw new Error('scene has no "length" (e.g. "length": "2 bars")');
      len = parseLength(s.meta.length, tempo);
      if (!(len > 0)) throw new Error(`length must be positive, got ${JSON.stringify(s.meta.length)}`);
    } catch (e) {
      p.errors.push({ level: "error", line: s.metaTok >= 0 ? p.toks[s.metaTok].line : s.line, scene: s.id, message: e.message });
      len = len > 0 ? len : tempo ? tempo.bar : 2;
    }
    s.t0 = t;
    s.dur = len;
    s.t1 = t + len;
    t = s.t1;
    const u = hitUnit(tempo);
    const hits = Array.isArray(s.meta.hits) ? s.meta.hits : [];
    if (s.meta.hits !== void 0 && !Array.isArray(s.meta.hits)) p.errors.push({ level: "error", line: s.line, scene: s.id, message: '"hits" must be an array of numbers' });
    s.hits = hits.filter((h) => typeof h === "number" && isFinite(h));
    if (s.hits.length !== hits.length) p.errors.push({ level: "error", line: s.line, scene: s.id, message: '"hits" must contain numbers only' });
    for (let j = 1; j < s.hits.length; j++) if (s.hits[j] < s.hits[j - 1]) {
      p.errors.push({ level: "warning", line: s.line, scene: s.id, message: "hits are not in ascending order" });
      break;
    }
    if (s.hits.some((h) => h < 0 || h * u > len + 1e-6)) p.errors.push({ level: "warning", line: s.line, scene: s.id, message: `a hit falls outside the scene (0\u2013${round(len / u, 3)} ${tempo ? "beats" : "s"})` });
    s.hitTimes = s.hits.map((h) => t0Round(s.t0 + h * u));
    if (!s.html.trim() && !s.js.trim()) p.errors.push({ level: "warning", line: s.line, scene: s.id, message: "scene has no html or js block" });
  }
  p.length = t;
  const m = p.meta;
  for (const k of ["width", "height", "fps"]) if (!(+m[k] > 0)) p.errors.push({ level: "error", line: p.metaTok >= 0 ? p.toks[p.metaTok].line : 1, message: `"${k}" must be a positive number` });
  if (!p.scenes.length) p.errors.push({ level: "warning", line: 1, message: 'the project has no scenes yet (add a "## id \xB7 Title" section)' });
}
var t0Round = (x) => Math.round(x * 1e9) / 1e9;
var cssBlocks = (p) => p.css.map((k) => p.toks[k].body);
var stageHtml = (p) => p.stageHtml >= 0 ? p.toks[p.stageHtml].body : "";
var stageJs = (p) => p.stageJs >= 0 ? p.toks[p.stageJs].body : "";
var sceneById = (p, id) => p.scenes.find((s) => s.id === id) || null;
function cueSheet(p) {
  const tempo = p.tempo;
  return {
    title: p.meta.title || "",
    bpm: tempo ? tempo.bpm : null,
    beatsPerBar: tempo ? tempo.beatsPerBar : null,
    length: round(p.length, 6),
    fps: +p.meta.fps,
    scenes: p.scenes.map((s) => ({
      id: s.id,
      title: s.title,
      t0: round(s.t0, 6),
      t1: round(s.t1, 6),
      ...tempo ? { bar: round(s.t0 / tempo.bar, 6), bars: round(s.dur / tempo.bar, 6), beat: round(s.t0 / tempo.beat, 6) } : {},
      hits: s.hits,
      hitTimes: s.hitTimes.map((x) => round(x, 6))
    })),
    audio: (p.meta.audio || []).map((a) => typeof a === "string" ? { src: a } : a)
  };
}

// src/lib/compile.js
var ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;
var isRelativeUrl = (u) => !!u && !ABSOLUTE.test(u.trim()) && !/^\$\{/.test(u) && !/^%%/.test(u);
var ATTR = /(\s(?:src|href|poster|xlink:href)\s*=\s*)(["'])([^"']*)\2/gi;
var CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
function assetRefs(html = "", css = "") {
  const out = /* @__PURE__ */ new Set();
  for (const m of html.matchAll(ATTR)) if (isRelativeUrl(m[3])) out.add(clean(m[3]));
  for (const m of (html + "\n" + css).matchAll(CSS_URL)) if (isRelativeUrl(m[2])) out.add(clean(m[2]));
  return [...out];
}
var clean = (u) => u.trim().replace(/^\.\//, "");
var rewriteHtml = (html, map) => html.replace(ATTR, (m, pre, q, u) => isRelativeUrl(u) && map[clean(u)] ? `${pre}${q}${map[clean(u)]}${q}` : m);
var rewriteCss = (css, map) => css.replace(CSS_URL, (m, q, u) => isRelativeUrl(u) && map[clean(u)] ? `url(${q}${map[clean(u)]}${q})` : m);
var list = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
function audioTracks(meta) {
  return list(meta.audio).map((a, i) => typeof a === "string" ? { src: a } : a).filter((a) => a && a.src).map((a, i) => ({ id: a.id || `a${i}`, src: String(a.src), at: +a.at || 0, gain: +a.gain || 0, role: a.role || (i ? "track" : "score") }));
}
function compile(p, { resolve: resolve2 = (u) => u } = {}) {
  const css = cssBlocks(p).join("\n\n");
  const refs = /* @__PURE__ */ new Set([...assetRefs(stageHtml(p), css), ...list(p.meta.assets).map(clean)]);
  for (const s of p.scenes) for (const r of assetRefs(s.html, s.css)) refs.add(r);
  const audio = audioTracks(p.meta);
  const map = {};
  for (const r of refs) map[r] = resolve2(r);
  const jsLine = (k) => k >= 0 ? p.toks[k].line + 1 : 0;
  return {
    v: 1,
    title: p.meta.title || "",
    lang: p.meta.lang || "zh-CN",
    width: +p.meta.width,
    height: +p.meta.height,
    fps: +p.meta.fps,
    length: p.length,
    tempo: p.tempo ? { bpm: p.tempo.bpm, beatsPerBar: p.tempo.beatsPerBar } : null,
    background: p.meta.background || "#000",
    className: p.meta.class || "",
    fonts: list(p.meta.fonts),
    css: rewriteCss(css, map),
    stage: { html: rewriteHtml(stageHtml(p), map), js: stageJs(p), line: jsLine(p.stageJs) },
    scenes: p.scenes.map((s) => ({
      id: s.id,
      title: s.title,
      t0: s.t0,
      t1: s.t1,
      hits: s.hitTimes,
      beats: s.hits,
      cls: s.meta.class || "",
      html: rewriteHtml(s.html, map),
      css: rewriteCss(s.css, map),
      js: s.js,
      line: jsLine(s.jsTok),
      htmlLine: jsLine(s.htmlTok)
    })),
    audio: audio.map((a) => ({ ...a, url: resolve2(a.src) })),
    assets: map
  };
}
var esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
var scriptJSON = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
function buildHtml(payload, runtimeSource, { mode = "player", extraHead = "" } = {}) {
  const fonts = payload.fonts.map((u) => `<link rel="stylesheet" href="${esc(u)}">`).join("\n");
  return `<!doctype html>
<html lang="${esc(payload.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(payload.title || "Forsion Video Studio")}</title>
<meta name="generator" content="Forsion Video Studio">
${fonts}
${extraHead}
</head>
<body>
<script type="application/json" id="fvs-data">${scriptJSON(payload)}</script>
<script>${runtimeSource.replace(/<\/script/gi, "<\\/script")}</script>
<script>FVS.boot(${JSON.stringify(mode)});</script>
</body>
</html>
`;
}

// src/lib/onsets.js
var ONSET_SR = 22050;
var N = 1024;
var HOP = 128;
var BLOCK = 110;
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}
function downsample(x, sr) {
  if (sr === ONSET_SR) return x;
  const r = sr / ONSET_SR, out = new Float32Array(Math.floor(x.length / r));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * r), b = Math.max(a + 1, Math.floor((i + 1) * r));
    let s = 0;
    for (let k = a; k < b; k++) s += x[k];
    out[i] = s / (b - a);
  }
  return out;
}
var MELS = 64;
var hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
var mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
var bank = null;
function melBank() {
  if (bank) return bank;
  const bins = N / 2 + 1, top = hz2mel(ONSET_SR / 2), pts = [];
  for (let i = 0; i < MELS + 2; i++) pts.push(mel2hz(top * i / (MELS + 1)) / (ONSET_SR / 2) * (bins - 1));
  bank = [];
  for (let m = 0; m < MELS; m++) {
    const [l, c, r] = [pts[m], pts[m + 1], pts[m + 2]], w = [];
    for (let k = Math.floor(l); k <= Math.ceil(r) && k < bins; k++) {
      const v = k < c ? (k - l) / Math.max(1e-9, c - l) : (r - k) / Math.max(1e-9, r - c);
      if (v > 0) w.push([k, v]);
    }
    bank.push(w);
  }
  return bank;
}
function onsetEnvelope(mono, sr = ONSET_SR) {
  const x = downsample(mono, sr);
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const env = new Float32Array(frames), level = new Float32Array(frames);
  const rms = new Float32Array(Math.floor(x.length / BLOCK));
  for (let b = 0; b < rms.length; b++) {
    let e = 0;
    for (let i = b * BLOCK; i < (b + 1) * BLOCK; i++) e += x[i] * x[i];
    rms[b] = e / BLOCK;
  }
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const B = melBank();
  const mel = new Float32Array(frames * MELS);
  const re = new Float32Array(N), im = new Float32Array(N);
  let top = -Infinity;
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    let ss = 0;
    for (let i = 0; i < N; i++) {
      const v = x[o + i];
      re[i] = v * win[i];
      im[i] = 0;
      ss += v * v;
    }
    level[f] = 10 * Math.log10(ss / N + 1e-12);
    fft(re, im);
    for (let m = 0; m < MELS; m++) {
      let e = 0;
      for (const [k, w] of B[m]) e += w * (re[k] * re[k] + im[k] * im[k]);
      const db = 10 * Math.log10(Math.max(e, 1e-10));
      mel[f * MELS + m] = db;
      if (db > top) top = db;
    }
  }
  const floor = top - 80;
  for (let i = 0; i < mel.length; i++) if (mel[i] < floor) mel[i] = floor;
  for (let f = 1; f < frames; f++) {
    let s = 0;
    for (let m = 0; m < MELS; m++) {
      const d = mel[f * MELS + m] - mel[(f - 1) * MELS + m];
      if (d > 0) s += d;
    }
    env[f] = s / MELS;
  }
  const sorted = [...env].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let f = 0; f < frames; f++) env[f] /= p95;
  return { env, level, rms, block: BLOCK / ONSET_SR, hop: HOP / ONSET_SR, offset: N / 2 / ONSET_SR };
}
var pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
};
function syncReport(scenes, { env, rms, block, hop, offset }, { before = 0.065, after = 0.03, weak = 0.6 } = {}) {
  const at = (t) => Math.round((t - offset) / hop);
  const rows = [];
  for (const s of scenes) {
    (s.hitTimes || s.hits || []).forEach((t, i) => {
      const a = Math.max(0, at(t - before)), b = Math.min(env.length - 1, at(t + after));
      let best = -1, bi = a;
      for (let k = a; k <= b; k++) if (env[k] > best) {
        best = env[k];
        bi = k;
      }
      const la = Math.max(0, at(t - 1)), lb = Math.min(env.length, at(t + 1));
      const local = pct(env.subarray(la, lb), 0.99) || 1;
      const strength = best < 0 ? 0 : best / local;
      const lvl = (p, q) => {
        const x = rms.subarray(Math.max(0, Math.ceil(p / block)), Math.max(0, Math.floor(q / block)));
        let s2 = 0;
        for (const v of x) s2 += v;
        return x.length ? 10 * Math.log10(s2 / x.length + 1e-12) : -120;
      };
      const drop = lvl(t, t + 0.07) - lvl(t - 0.08, t - 0.01) <= -6;
      const off = best < 0 ? null : bi * hop + offset - t;
      rows.push({ scene: s.id, hit: i, t, offset: off, strength: +strength.toFixed(2), quiet: drop, ok: drop || strength >= weak });
    });
  }
  return rows;
}

// src/lib/templates.js
var FONTS = "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=JetBrains+Mono:wght@500;700&family=Noto+Sans+SC:wght@400;500;700&family=Noto+Serif+SC:wght@700;900&display=swap";
var HEAD = (title, zh) => `# ${title}

${zh ? "\u8FD9\u662F\u4E00\u4E2A Forsion Video Studio \u5DE5\u7A0B\u6587\u4EF6\u3002\u573A\u666F\u6309\u987A\u5E8F\u9996\u5C3E\u76F8\u63A5\u5730\u64AD\u653E\uFF1B\u6BCF\u4E2A\u573A\u666F\u7684 `hits` \u662F\u4ECE\u573A\u666F\u5F00\u5934\u7B97\u8D77\u7684\u62CD\u70B9\uFF0C\u753B\u9762\u7684\u5207\u70B9\u548C\u914D\u4E50\u7684\u91CD\u97F3\u90FD\u4ECE\u8FD9\u91CC\u8BFB\u3002\u7528 Video Studio \u6253\u5F00\u53EF\u4EE5\u76F4\u63A5\u6539\u6587\u5B57\u3001\u62D6\u65F6\u95F4\u7EBF\uFF1B\u4E5F\u53EF\u4EE5\u8BA9 AI \u6309\u8FD9\u4EFD\u6587\u4EF6\u7684\u5199\u6CD5\u7EE7\u7EED\u5199\u3002" : "A Forsion Video Studio project. Scenes play back to back in document order; each scene's `hits` are beats from its start, and both the picture cuts and the score's accents read them. Open it in Video Studio to edit the text and the timeline, or ask the AI to keep writing it."}
`;
var EVA_CSS = `/* Title cards in the manner of an EVA intertitle: black, heavy serif, hard cuts on the beat. */
.fvs-eva { --ink: #f2f0ea; --red: #e3161b; --orange: #ff6a13; --green: #38ff8b; color: var(--ink); font-family: 'Noto Serif SC', 'Songti SC', serif; }
.fvs-eva .card { position: absolute; inset: 0; background: #000; }
.fvs-eva .card.inv { background: var(--ink); color: #000; }
.fvs-eva .k { position: absolute; font-weight: 900; line-height: 1; white-space: nowrap; transform: scaleX(.8); transform-origin: 0 0; }
.fvs-eva .k.mid { left: 0; right: 0; text-align: center; transform-origin: 50% 0; }
.fvs-eva .e { position: absolute; font: 700 44px/1.3 'Barlow Condensed', sans-serif; letter-spacing: .22em; white-space: nowrap; }
.fvs-eva .e.mid { left: 0; right: 0; text-align: center; }
.fvs-eva .red { color: var(--red); }
.fvs-eva .hud { position: absolute; inset: 0; background: #000; color: var(--orange); font-family: 'Barlow Condensed', sans-serif; }
.fvs-eva .top { position: absolute; left: 90px; right: 90px; top: 60px; height: 70px; display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid var(--orange); font: 700 38px 'Barlow Condensed', sans-serif; letter-spacing: .16em; }
.fvs-eva .term { position: absolute; left: 90px; top: 220px; display: grid; gap: 14px; }
.fvs-eva .term p { margin: 0; font: 500 44px/1.4 'JetBrains Mono', monospace; color: var(--green); white-space: pre; }
.fvs-eva .grain { position: absolute; inset: 0; pointer-events: none; background-size: 200px 200px; opacity: .06; mix-blend-mode: screen; }`;
function evaTemplate({ title = "\u65B0\u89C6\u9891", zh = true } = {}) {
  return `${HEAD(title, zh)}
\`\`\`fvs
{
  "fvs": 1,
  "title": ${JSON.stringify(title)},
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "tempo": { "bpm": 120, "beatsPerBar": 4 },
  "class": "fvs-eva",
  "fonts": [${JSON.stringify(FONTS)}],
  "audio": []
}
\`\`\`

\`\`\`css
${EVA_CSS}
\`\`\`

\`\`\`html stage
<div data-fvs-scenes></div>
<div class="grain"></div>
<div data-fvs-flash></div>
\`\`\`

\`\`\`js stage
grain('.grain')
\`\`\`

## boot \xB7 \u542F\u52A8

\`\`\`fvs
{ "length": "2 bars", "hits": [0, 1, 2, 3, 4, 6] }
\`\`\`

\`\`\`html
<div class="hud">
  <div class="top"><span>FORSION VIDEO STUDIO</span><span class="red">\u25CF REC</span></div>
  <div class="term">
    <p data-in="h1" data-fx="type">SCENES ........ OK</p>
    <p data-in="h2" data-fx="type">TIMELINE ...... OK</p>
    <p data-in="h3" data-fx="type">SCORE ......... OK</p>
    <p data-in="h4" data-fx="type" class="red">HUMAN ......... ??</p>
  </div>
</div>
\`\`\`

## cards \xB7 \u6807\u9898\u5361

\`\`\`fvs
{ "length": "2 bars", "hits": [0, 2, 4, 6] }
\`\`\`

\`\`\`html
<div data-seq="h0">
  <div class="card"><span class="k" style="left:150px;top:260px;font-size:380px">\u7B2C\u4E00\u8BDD</span><span class="e" style="left:160px;top:760px">EPISODE ONE</span></div>
  <div class="card"><span class="k" style="left:1500px;top:90px;font-size:300px;writing-mode:vertical-rl;transform:scaleY(.86)">\u5F00\u59CB</span><span class="e" style="left:150px;top:920px">BEGIN</span></div>
  <div class="card inv"><span class="k mid" style="top:330px;font-size:360px">\u6539\u6587\u5B57</span></div>
  <div class="card"><span class="e mid" style="top:380px;font-size:64px">EDIT THE TEXT, DRAG THE TIMELINE.</span><span class="k mid red" style="top:520px;font-size:120px">\u7136\u540E\u5BFC\u51FA\u3002</span></div>
</div>
\`\`\`

\`\`\`js
// a flash on the first cut; everything else in this scene is declarative (data-seq)
flash(hits[0], .6)
\`\`\`

## title \xB7 \u7247\u540D

\`\`\`fvs
{ "length": "2 bars", "hits": [0, 4] }
\`\`\`

\`\`\`html
<div class="card">
  <span class="e" style="left:160px;top:150px;font-size:60px" data-in="h0">EPISODE 01</span>
  <span class="k" style="left:140px;top:280px;font-size:420px" data-in="h1">${title}</span>
</div>
\`\`\`

\`\`\`js
flash(hits[1], .85)
\`\`\`
`;
}
function blankTemplate({ title = "\u65B0\u89C6\u9891", zh = true } = {}) {
  return `${HEAD(title, zh)}
\`\`\`fvs
{
  "fvs": 1,
  "title": ${JSON.stringify(title)},
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "tempo": { "bpm": 120, "beatsPerBar": 4 },
  "background": "#101010",
  "audio": []
}
\`\`\`

\`\`\`css
.fvs-stage { color: #f5f3ef; font-family: 'Noto Sans SC', 'PingFang SC', system-ui, sans-serif; }
.fvs-stage h1 { position: absolute; left: 160px; top: 380px; margin: 0; font-size: 150px; font-weight: 700; }
.fvs-stage p { position: absolute; left: 164px; top: 600px; margin: 0; font-size: 48px; color: #a39d96; }
\`\`\`

## intro \xB7 \u5F00\u573A

\`\`\`fvs
{ "length": "2 bars", "hits": [0, 2] }
\`\`\`

\`\`\`html
<h1 data-in="h0" data-fx="up">${title}</h1>
<p data-in="h1" data-fx="fade">${zh ? "\u7B2C\u4E00\u53E5\u526F\u6807\u9898" : "A subtitle"}</p>
\`\`\`
`;
}
var TEMPLATES = { eva: evaTemplate, blank: blankTemplate };

// src/generated/runtime-src.js
var runtime_src_default = '/* Forsion Video Studio 0.1.0 \u2014 built from src/ by build.mjs; edit the sources, not this file. */\nvar FVS=(()=>{var K=Object.defineProperty;var P=Object.getOwnPropertyDescriptor;var tt=Object.getOwnPropertyNames;var et=Object.prototype.hasOwnProperty;var nt=(t,n)=>{for(var s in n)K(t,s,{get:n[s],enumerable:!0})},st=(t,n,s,i)=>{if(n&&typeof n=="object"||typeof n=="function")for(let e of tt(n))!et.call(t,e)&&e!==s&&K(t,e,{get:()=>n[e],enumerable:!(i=P(n,e))||i.enumerable});return t};var ot=t=>st(K({},"__esModule",{value:!0}),t);var wt={};nt(wt,{EASE:()=>H,boot:()=>xt,createStage:()=>Y,mount:()=>D,prog:()=>X,rng:()=>z,timeExpr:()=>V});var H={lin:t=>t,in:t=>t*t*t,out:t=>1-(1-t)**3,io:t=>t<.5?4*t**3:1-(-2*t+2)**3/2,expo:t=>t>=1?1:1-2**(-10*t),back:t=>1+2.70158*(t-1)**3+1.70158*(t-1)**2,step:t=>t<1?0:1},U=(t,n=0,s=1)=>Math.min(s,Math.max(n,t)),G=(t,n,s)=>t+(n-t)*s,X=(t,n,s,i="io")=>(H[i]||H.io)(U((t-n)/(s-n))),z=t=>()=>{t|=0,t=t+1831565813|0;let n=Math.imul(t^t>>>15,1|t);return n=n+Math.imul(n^n>>>7,61|n)^n,((n^n>>>14)>>>0)/4294967296},at=["x","y","z","s","sx","sy","r","rx","ry"];function it(t,n){if(n<=t[0].t)return t[0].v;for(let s=1;s<t.length;s++){let i=t[s];if(n<i.t){let e=t[s-1],r=(H[i.e]||H.io)((n-e.t)/(i.t-e.t)),m={};for(let f in i.v){let y=f in e.v?e.v[f]:i.v[f],l=i.v[f];m[f]=typeof l=="number"&&typeof y=="number"?y+(l-y)*r:r<1?y:l}return m}}return t[t.length-1].v}function rt(t,n,s){let i=t.style;if(s){let e=`translate3d(${n.x||0}px,${n.y||0}px,${n.z||0}px)`;n.rx&&(e+=` rotateX(${n.rx}deg)`),n.ry&&(e+=` rotateY(${n.ry}deg)`),n.r&&(e+=` rotate(${n.r}deg)`),(n.s??1)!==1&&(e+=` scale(${n.s})`),((n.sx??1)!==1||(n.sy??1)!==1)&&(e+=` scale(${n.sx??1},${n.sy??1})`),i.transform=e}"o"in n&&(i.opacity=n.o,i.visibility=n.o<.002?"hidden":""),("b"in n||"br"in n)&&(i.filter=`blur(${n.b||0}px) brightness(${n.br??1})`),("ct"in n||"cr"in n||"cb"in n||"cl"in n)&&(i.clipPath=`inset(${n.ct||0}% ${n.cr||0}% ${n.cb||0}% ${n.cl||0}%)`);for(let e in n)e[0]==="-"&&i.setProperty(e,n[e])}function Y(t){let n=[],s=[],i=e=>typeof e=="string"?[...t.querySelectorAll(e)]:e==null?[]:e instanceof Element?[e]:[...e];return{root:t,q:i,tracks:n,hooks:s,K(e,r,m={}){let f={},y=r.map(([v,p={},E="io"])=>(f={...f,...p},{t:v,v:f,e:E}));if(!y.length)return;let l=y.some(v=>Object.keys(v.v).some(p=>at.includes(p)));i(e).forEach((v,p)=>n.push({el:v,kf:y,hasTf:l,off:(m.stagger||0)*p}))},S(e,r,m){let f=i(e);s.push(y=>{for(let l of f)l.style.display=y>=r&&y<m?"":"none"})},H(e){s.push(e)},type(e,r,m=30,f=0){i(e).forEach((y,l)=>{let v=[...y.textContent],p=r+f*l;s.push(E=>{let C=U(Math.floor((E-p)*m),0,v.length),$=v.slice(0,C).join("");y.textContent!==$&&(y.textContent=$)})})},render(e){for(let r of s)r(e);for(let r of n)rt(r.el,it(r.kf,e-r.off),r.hasTf)}}}var I=null;function ct(){if(I)return I;let t=z(7);I=[];for(let n=0;n<4;n++){let s=document.createElement("canvas");s.width=s.height=200;let i=s.getContext("2d"),e=i.createImageData(200,200);for(let r=0;r<e.data.length;r+=4){let m=t()*255;e.data[r]=e.data[r+1]=e.data[r+2]=m,e.data[r+3]=255}i.putImageData(e,0,0),I.push(`url(${s.toDataURL()})`)}return I}function J(t,n=".grain"){let s=t.q(n),i=ct();t.H(e=>{let r=i[Math.floor(e*24)%4];for(let m of s)m.style.backgroundImage=r})}var lt=`\n.fvs-stage{position:relative;overflow:hidden;transform-origin:0 0}\n.fvs-scenes{position:absolute;inset:0}\n.fvs-scene{position:absolute;inset:0;overflow:hidden}\n[data-fvs-flash]{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}\n`,dt=/^\\s*(?:(h)(\\d+)|(end|start))?\\s*(?:([+-])?\\s*(\\d*\\.?\\d+)\\s*(b|beats?|s|secs?)?)?\\s*$/i;function V(t,n,s,i){let e=String(t).match(dt);if(!e||!e[1]&&!e[3]&&!e[5])throw new Error(`cannot read time "${t}" (use h3, h3+0.5, 2b, 1.5s or end-1)`);let r=n.t0;if(e[1]){let m=+e[2];if(!(m<n.hits.length))throw new Error(`"${t}": this scene has ${n.hits.length} hits (h0\\u2013h${n.hits.length-1})`);r=n.hits[m]}if(e[3]==="end"&&(r=n.t1),e[5]){let m=+e[5]*(e[4]==="-"?-1:1),f=(e[6]||"").toLowerCase();r+=m*(f.startsWith("b")?i:f.startsWith("s")?1:s)}return r}function D(t,n,{doc:s=document,onScene:i=null}={}){let e=t,r=[],m=e.tempo,f=m?60/m.bpm:.5,y=f*(m?m.beatsPerBar:4),l=m?f:1,v=s.createElement("style");v.setAttribute("data-fvs",""),v.textContent=lt+`\n`+(e.css||"")+`\n`+e.scenes.filter(a=>a.css&&a.css.trim()).map(a=>`[data-scene="${a.id}"]{\n${a.css}\n}`).join(`\n`),s.head.append(v);let p=s.createElement("div");p.className=`fvs-stage ${e.className||""}`.trim(),Object.assign(p.style,{width:`${e.width}px`,height:`${e.height}px`,background:e.background||"#000"}),p.innerHTML=e.stage.html||"";let E=p.querySelector("[data-fvs-scenes], fvs-scenes"),C=s.createElement("div");C.className="fvs-scenes",E?E.replaceWith(C):p.prepend(C),E=C,n.append(p);let $=Y(p),N=[],T={},o=e.assets||{},d=a=>o[String(a).replace(/^\\.\\//,"")]||a;for(let a of e.scenes){let u=s.createElement("div");u.className=`fvs-scene scene ${a.cls||""}`.trim(),u.dataset.scene=a.id,u.innerHTML=a.html||"",E.append(u),$.S(u,a.t0,a.t1),T[a.id]={id:a.id,title:a.title,t0:a.t0,t1:a.t1,dur:a.t1-a.t0,hits:a.hits,beats:a.beats,el:u},i&&i(T[a.id])}function x(a,u){let w=c=>typeof c=="string"?[...u.querySelectorAll(c)]:c==null?[]:c instanceof Element?[c]:[...c],h=(c,g,q)=>$.K(w(c),g,q),R=(c,g,q)=>$.S(w(c),g,q),S=c=>a.t0+c*l,O=(c,g=0)=>c<a.hits.length?a.hits[c]+g*l:NaN,F=(c,g,q)=>h(c,[[g-.01,{o:0}],[g,{o:1},"step"]],q),j=(c,g,q={y:20},b)=>h(c,[[g-.01,{o:0,...q}],[g,{o:1},"step"],[g+.18,{x:0,y:0},"out"]],b),B=(c,g,q=f/2,b)=>h(c,[[g,{o:0}],[g+q,{o:1},"out"]],b),W=(c,g,q=a.t1)=>w(c).forEach((b,L)=>L<g.length&&$.S(b,g[L],g[L+1]??q));return{t0:a.t0,t1:a.t1,dur:a.t1-a.t0,hits:a.hits||[],beat:f,bar:y,unit:l,at:S,hit:O,root:u,stage:p,$:c=>u.querySelector(c),$$:c=>[...u.querySelectorAll(c)],K:h,S:R,H:c=>$.H(c),on:c=>$.H(c),type:(c,g,q,b)=>$.type(w(c),g,q,b),cut:F,slide:j,fade:B,seq:W,flash:(c,g=.85)=>N.push([c,g]),grain:(c=".grain")=>J({q:w,H:$.H},c),prog:X,ease:H,clamp:U,lerp:G,rng:z,scenes:T,flashes:N,asset:d,project:{title:e.title,width:e.width,height:e.height,fps:e.fps,length:e.length,tempo:m},width:e.width,height:e.height,fps:e.fps,length:e.length,during:c=>c.map(g=>Array.isArray(g)?g:T[g]?[T[g].t0,T[g].t1]:[0,0]),inside:(c,g)=>g.some(([q,b])=>c>=q&&c<b)}}function A(a,u,w,h){if(!a||!a.trim())return;let R=Object.keys(u);try{new Function(...R,`${a}\n//# sourceURL=fvs://${w}.js`)(...R.map(S=>u[S]))}catch(S){let O=String(S&&S.stack||"").match(new RegExp(`fvs://${w.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&")}\\\\.js:(\\\\d+)`));r.push({scene:w.replace(/^scene\\//,""),message:String(S&&S.message||S),line:O&&h?h+ +O[1]-3:h||0})}}function k(a,u){let w=(h,R)=>{try{return V(h,a,l,f)}catch(S){return r.push({scene:a.id,message:S.message,line:0,el:R.tagName}),NaN}};for(let h of a.el.querySelectorAll("[data-seq]")){let R=String(h.dataset.seq).match(/^\\s*h(\\d+)\\s*$/);if(!R){r.push({scene:a.id,message:`data-seq="${h.dataset.seq}" must name the first hit, e.g. data-seq="h0"`});continue}let S=[...h.children],O=+R[1],F=S.map((j,B)=>a.hits[O+B]).filter(j=>j!==void 0);F.length<S.length&&r.push({scene:a.id,message:`data-seq has ${S.length} items but only ${F.length} hits from h${O}`}),u.seq(S,F,h.dataset.seqEnd?w(h.dataset.seqEnd,h):a.t1)}for(let h of a.el.querySelectorAll("[data-in], [data-out]")){let R=h.dataset.each!==void 0?+h.dataset.each*l:null,S=R!==null?[...h.children]:[h],O=h.dataset.in!==void 0?w(h.dataset.in,h):null,F=h.dataset.out!==void 0?w(h.dataset.out,h):null,j=(h.dataset.fx||"cut").toLowerCase(),B=(h.dataset.fxOut||"cut").toLowerCase(),W=+h.dataset.dist||24,c=h.dataset.dur!==void 0?+h.dataset.dur*l:f/2;S.forEach((g,q)=>{let b=O===null?null:O+(R||0)*q,L=[];if(b!==null&&!isNaN(b))if(j==="type")$.type([g],b,+h.dataset.cps||30);else if(j==="fade")L.push([b,{o:0}],[b+c,{o:1},"out"]);else if(j==="pop")L.push([b-.01,{o:0,s:.92}],[b,{o:1},"step"],[b+.25,{s:1},"back"]);else if(/^(up|down|left|right)$/.test(j)){let Z={up:{y:W},down:{y:-W},left:{x:W},right:{x:-W}}[j];L.push([b-.01,{o:0,...Z}],[b,{o:1},"step"],[b+.18,{x:0,y:0},"out"])}else L.push([b-.01,{o:0}],[b,{o:1},"step"]);F!==null&&!isNaN(F)&&(B==="fade"?(L.length||L.push([a.t0,{o:1}]),L.push([F,{o:1}],[F+c,{o:0},"in"])):$.S([g],-1e9,F)),L.length&&$.K([g],L)})}}for(let a of e.scenes){let u=T[a.id],w=x(u,u.el);k(u,w),A(a.js,w,`scene/${a.id}`,a.line)}A(e.stage.js,x({id:"stage",t0:0,t1:e.length,hits:[],el:p},p),"stage",e.stage.line);let M=[...p.querySelectorAll("[data-fvs-flash]")];return M.length&&(N.sort((a,u)=>a[0]-u[0]),$.H(a=>{let u=0;for(let[w,h]of N)a>=w&&a<w+.18&&(u=Math.max(u,h*(1-(a-w)/.18)**2));for(let w of M)w.style.opacity=u})),{root:p,errors:r,scenes:T,seek:a=>$.render(a+1e-4),payload:e,length:e.length,width:e.width,height:e.height,fps:e.fps,destroy(){p.remove(),v.remove()}}}var ft=`\nhtml,body{margin:0;background:#0b0b0b;color:#e8e6e1;font:14px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif}\n.fvs-app{max-width:1200px;margin:0 auto;padding:24px 16px 48px;display:grid;gap:14px}\n.fvs-app h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.02em}\n.fvs-frame{position:relative;width:100%;overflow:hidden;background:#000;border-radius:6px;box-shadow:0 0 0 1px #262626;cursor:pointer}\n.fvs-frame .fvs-stage{position:absolute;left:0;top:0}\n.fvs-bar{display:flex;gap:10px;align-items:center}\n.fvs-bar button{font:600 14px inherit;font-family:inherit;color:#0b0b0b;background:#e8e6e1;border:0;border-radius:6px;height:36px;min-width:84px;cursor:pointer}\n.fvs-bar button:focus-visible,.fvs-bar input:focus-visible,.fvs-chapters button:focus-visible{outline:2px solid #ff6a13;outline-offset:2px}\n.fvs-bar input{flex:1;min-width:0;accent-color:#ff6a13}\n.fvs-bar output{font:12px ui-monospace,monospace;color:#9a948d;font-variant-numeric:tabular-nums;min-width:12ch;text-align:right}\n.fvs-chapters{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;padding:0;list-style:none;font-size:13px;color:#9a948d}\n.fvs-chapters button{font:inherit;color:inherit;background:none;border:0;padding:2px 0;cursor:pointer}\n.fvs-chapters button:hover,.fvs-chapters button.on{color:#e8e6e1}\n.fvs-chapters b{font:600 12px ui-monospace,monospace;color:#ff6a13;margin-right:6px}\n.fvs-err{font:12px ui-monospace,monospace;color:#ff8a65;white-space:pre-wrap;margin:0}\n.fvs-credit{font-size:12px;color:#6f6a64;margin:0}\n`,Q=t=>`${Math.floor(t/60)}:${(t%60).toFixed(1).padStart(4,"0")}`;function pt(){let t=document.getElementById("fvs-data");return JSON.parse(t.textContent)}function ut(t,n,s,i){let e=!1,r=0,m=0,f=()=>e?Math.min(s,r+(performance.now()-m)/1e3):r,y=l=>{let v=f();for(let{el:p,at:E}of n){let C=v-E;if(!e||C<0||C>(p.duration||1/0)){p.paused||p.pause(),C<0&&p.currentTime&&(p.currentTime=0);continue}(l||Math.abs(p.currentTime-C)>.08)&&(p.currentTime=C),p.paused&&p.play().catch(()=>{})}};return{now:f,sync:y,get playing(){return e},play(){r>=s&&(r=0),e=!0,m=performance.now(),y(!0)},pause(){r=f(),e=!1,y()},seek(l){r=Math.max(0,Math.min(s,l)),m=performance.now(),y(!0)},tick(){e&&f()>=s?(r=s,e=!1,y(),i&&i()):e&&y()}}}function ht(t,n,s){let i=()=>{t.root.style.transform=`scale(${n.clientWidth/s.width})`};new ResizeObserver(i).observe(n),i()}function gt(t){let n=document.createElement("style");n.textContent=ft,document.head.append(n);let s=document.createElement("main");s.className="fvs-app",s.innerHTML=`<h1></h1><div class="fvs-frame" role="img"></div>\n    <div class="fvs-bar" role="group" aria-label="Playback"><button type="button" class="fvs-play">\\u25B6 \\u64AD\\u653E</button><input type="range" min="0" step="0.01" value="0" aria-label="\\u8FDB\\u5EA6"><output></output></div>\n    <ol class="fvs-chapters" aria-label="\\u7AE0\\u8282"></ol><pre class="fvs-err" hidden></pre><p class="fvs-credit">Made with Forsion Video Studio</p>`,document.body.append(s),s.querySelector("h1").textContent=t.title||"";let i=s.querySelector(".fvs-frame");i.style.aspectRatio=`${t.width} / ${t.height}`,i.style.maxWidth=`calc((100vh - 200px) * ${t.width/t.height})`,i.style.margin="0 auto",i.setAttribute("aria-label",t.title||"video");let e=D(t,i);ht(e,i,t);let r=t.audio.map(o=>{let d=new Audio(o.url);return d.preload="auto",d.volume=Math.min(1,10**((o.gain||0)/20)),{el:d,at:o.at||0}}),m=s.querySelector(".fvs-play"),f=s.querySelector("input"),y=s.querySelector("output");f.max=t.length;let l=ut(t,r,t.length),v=s.querySelector(".fvs-chapters");v.innerHTML=t.scenes.map(o=>`<li><button type="button" data-t="${o.t0}"><b>${o.t0.toFixed(1)}</b></button></li>`).join(""),[...v.querySelectorAll("button")].forEach((o,d)=>o.append(t.scenes[d].title||t.scenes[d].id));let p=[...v.querySelectorAll("button")];if(e.errors.length){let o=s.querySelector(".fvs-err");o.hidden=!1,o.textContent=e.errors.map(d=>`${d.scene}${d.line?`:${d.line}`:""} ${d.message}`).join(`\n`)}let E=()=>l.playing?l.pause():l.play();m.addEventListener("click",E),i.addEventListener("click",E),f.addEventListener("input",()=>l.seek(+f.value)),p.forEach(o=>o.addEventListener("click",()=>{l.seek(+o.dataset.t),l.playing||l.play()})),document.addEventListener("keydown",o=>{o.target.closest&&o.target.closest("input,button,textarea")||(o.code==="Space"&&(o.preventDefault(),E()),o.code==="ArrowRight"&&l.seek(l.now()+2),o.code==="ArrowLeft"&&l.seek(l.now()-2))});let C=-1,$=t.scenes.length?Math.min(t.length,t.scenes[Math.min(1,t.scenes.length-1)].t0+.8):0,N=!1,T=()=>{l.tick();let o=N||l.playing?l.now():$;l.playing&&(N=!0),o!==C&&(e.seek(o),C=o),f.value=o,y.textContent=`${Q(o)} / ${Q(t.length)}`,m.textContent=l.playing?"\\u275A\\u275A \\u6682\\u505C":"\\u25B6 \\u64AD\\u653E",p.forEach((d,x)=>d.classList.toggle("on",o>=t.scenes[x].t0&&o<t.scenes[x].t1)),requestAnimationFrame(T)};f.addEventListener("input",()=>{N=!0}),requestAnimationFrame(T),window.__fvs={stage:e,clock:l}}function mt(t){document.documentElement.style.background="#000",document.body.style.margin="0";let n=D(t,document.body);n.root.style.transform="none",n.seek(0),window.__stage={w:t.width,h:t.height,dur:t.length,fps:t.fps,errors:n.errors,audio:t.audio,seek:s=>n.seek(s),ready:()=>document.fonts.ready.then(()=>Promise.all([...document.images].map(s=>s.complete?0:s.decode().catch(()=>0))))}}var yt=/^(SCRIPT|STYLE|TEXTAREA|TITLE)$/i;function bt(t){document.documentElement.style.cssText="background:#141414;height:100%;overflow:hidden",document.body.style.cssText="margin:0;height:100%;overflow:hidden;display:grid;place-items:center";let n=document.createElement("div");n.style.cssText=`position:relative;overflow:hidden;background:#000;aspect-ratio:${t.width}/${t.height};width:min(100vw, calc(100vh * ${t.width/t.height}))`,document.body.append(n);let s={},i=new WeakMap,e=new WeakMap,r=new WeakMap,f=D(t,n,{onScene:o=>{let d=[],x=[...o.el.querySelectorAll("img")],A=document.createTreeWalker(o.el,NodeFilter.SHOW_TEXT);for(let k;k=A.nextNode();){if(!/\\S/.test(k.data)||k.parentElement&&yt.test(k.parentElement.tagName))continue;i.set(k,d.length);let M=k.parentElement;e.has(M)||e.set(M,[]),e.get(M).push(d.length),d.push({node:k,el:M})}x.forEach((k,M)=>r.set(k,M)),s[o.id]={texts:d,imgs:x}}}),y=()=>{f.root.style.transform=`scale(${n.clientWidth/t.width})`};new ResizeObserver(y).observe(n),y();let l=o=>parent.postMessage({fvs:o.type,...o,type:void 0},"*"),v=0;f.seek(0);let p=document.createElement("div");p.style.cssText="position:absolute;pointer-events:none;border:2px solid #ff6a13;border-radius:3px;box-shadow:0 0 0 9999px rgba(0,0,0,.18);display:none;z-index:10",n.append(p);let E=o=>({x:o.left,y:o.top,w:o.width,h:o.height}),C=o=>{if(!o){p.style.display="none";return}let d=n.getBoundingClientRect();Object.assign(p.style,{display:"",left:`${o.x-d.left-3}px`,top:`${o.y-d.top-3}px`,width:`${o.w+6}px`,height:`${o.h+6}px`})},$=o=>{let d=o&&o.closest&&o.closest("[data-scene]");return d?d.dataset.scene:null};function N(o,d){let x=document.elementFromPoint(o.clientX,o.clientY),A=$(x);if(!A||!s[A]){l({type:"pick",scene:null,dbl:d});return}if(x.tagName==="IMG"&&r.has(x)){l({type:"pick",scene:A,img:r.get(x),rect:E(x.getBoundingClientRect()),dbl:d});return}let k=null,M=document.caretRangeFromPoint&&document.caretRangeFromPoint(o.clientX,o.clientY);M&&M.startContainer.nodeType===3&&i.has(M.startContainer)&&(k=i.get(M.startContainer));for(let u=x;k===null&&u&&u!==n;u=u.parentElement)e.has(u)&&(k=e.get(u)[0]);if(k===null){l({type:"pick",scene:A,dbl:d});return}let _=s[A].texts[k],a=_.node.isConnected?(()=>{let u=document.createRange();return u.selectNodeContents(_.node),u.getBoundingClientRect()})():_.el.getBoundingClientRect();l({type:"pick",scene:A,text:k,rect:E(a.width?a:_.el.getBoundingClientRect()),dbl:d})}n.addEventListener("click",o=>N(o,!1)),n.addEventListener("dblclick",o=>{o.preventDefault(),N(o,!0)}),window.addEventListener("message",o=>{let d=o.data||{};if(d.fvs==="seek")v=d.t,f.seek(d.t);else if(d.fvs==="outline"){let x=s[d.scene],A=x?d.img!=null?x.imgs[d.img]:d.text!=null&&x.texts[d.text]?x.texts[d.text].el:null:null;C(A&&A.isConnected&&A.getClientRects().length?E(A.getBoundingClientRect()):null)}});let T=o=>Object.fromEntries(Object.entries(s).map(([d,x])=>[d,x[o].length]));l({type:"ready",length:t.length,errors:f.errors,texts:T("texts"),imgs:T("imgs")}),window.__fvs={stage:f,seek:o=>f.seek(o)}}function xt(t){let n=pt(),s=typeof window<"u"&&window.FVS_MODE||t||new URLSearchParams(location.search).get("mode")||(new URLSearchParams(location.search).has("capture")?"capture":"player");s==="capture"?mt(n):s==="embed"?bt(n):gt(n)}return ot(wt);})();\n';

// src/cli/fvs.js
var VERSION = "0.1.0";
var HELP = `fvs ${VERSION} \u2014 Forsion Video Studio

  fvs new <file.fvs.md> [--template eva|blank] [--title T]   start a project
  fvs info <file>                      scenes, times, hits (read this before editing)
  fvs check <file> [--runtime]         parse errors; --runtime also runs every scene script in a browser
  fvs cues <file> [--out cues.json]    the cue sheet a score is written against (JSON)
  fvs html <file> [--out f.html] [--inline]   standalone web video (player page)
  fvs still <file> --at <t|scene[:hit]> [--out f.png] [--scale 0.5]   one frame as PNG
  fvs sheet <file> [--scenes | --every <sec>] [--out sheet.png]       contact sheet of frames
  fvs render <file> [--out f.mp4] [--from s] [--to s] [--scale 0.5] [--workers 3] [--crf 18]
                    [--keep-frames dir] [--no-audio]                 MP4 with the project's audio
  fvs sync <file> [--audio a.mp3]      do the hits land on accents of the score?

  Times: 12.5 (seconds), scene id (its start), scene:3 (its hit 3).
  Browser: playwright-core (npm i -g playwright-core) + Chrome/Edge, or FVS_CHROMIUM=/path/to/chrome.
  ffmpeg: on PATH, or FFMPEG=/path/to/ffmpeg.`;
var argv = process.argv.slice(2);
var cmd = argv.shift();
var flags = {};
var pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    if (v !== void 0) flags[k] = v;
    else if (argv[i + 1] !== void 0 && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
var die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};
var log = (...a) => console.log(...a);
function load(file) {
  if (!file) die("which project? (fvs <command> <file.fvs.md>)");
  const path = resolve(file);
  if (!existsSync(path)) die(`no such file: ${path}`);
  const text = readFileSync(path, "utf8");
  return { path, dir: dirname(path), text, p: parseProject(text) };
}
function report(p, { fail = true } = {}) {
  const errs = p.errors.filter((e) => e.level === "error"), warns = p.errors.filter((e) => e.level !== "error");
  for (const e of [...errs, ...warns]) console.error(`${e.level === "error" ? "error" : "warn "} line ${e.line}${e.scene ? ` [${e.scene}]` : ""}: ${e.message}`);
  if (errs.length && fail && !flags.force) die(`${errs.length} error(s); fix them or pass --force`);
}
var fileUrl = (dir, rel) => pathToFileURL(join(dir, rel)).href;
function timeArg(p, v) {
  if (v === void 0 || v === true) return null;
  if (/^-?\d+(\.\d+)?$/.test(String(v))) return +v;
  const [id, h] = String(v).split(":");
  const s = sceneById(p, id);
  if (!s) die(`no scene "${id}" (scenes: ${p.scenes.map((x) => x.id).join(", ")})`);
  if (h === void 0) return s.t0;
  if (!(+h < s.hitTimes.length)) die(`scene "${id}" has ${s.hitTimes.length} hits`);
  return s.hitTimes[+h];
}
async function chromium() {
  const req = createRequire(join(process.cwd(), "x.js"));
  const tries = ["playwright-core", "playwright"];
  let pw = null;
  for (const m of tries) {
    for (const load2 of [() => import(m), () => req(m), () => createRequire(import.meta.url)(m), () => globalRequire(m)]) {
      try {
        pw = await load2();
        if (pw && (pw.chromium || pw.default && pw.default.chromium)) break;
        pw = null;
      } catch {
      }
    }
    if (pw) break;
  }
  if (!pw) die("This command needs a browser driver. Install one:  npm i -g playwright-core   (or run inside a folder with playwright installed)");
  const { chromium: C } = pw.chromium ? pw : pw.default;
  const exe = process.env.FVS_CHROMIUM || flags.browser;
  const attempts = [];
  if (exe) attempts.push({ executablePath: exe });
  attempts.push({}, { channel: "chrome" }, { channel: "msedge" }, { channel: "chromium" });
  for (const p of knownBrowsers()) attempts.push({ executablePath: p });
  let lastErr;
  for (const opt of attempts) {
    try {
      return await C.launch({ ...opt, args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars"] });
    } catch (e) {
      lastErr = e;
    }
  }
  die(`Could not start a Chromium-based browser (${String(lastErr && lastErr.message || lastErr).split("\n")[0]}).
Install Google Chrome or Microsoft Edge, or run: npx playwright install chromium, or set FVS_CHROMIUM=/path/to/chrome`);
}
function globalRequire(m) {
  const root = spawnSync(platform() === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: platform() === "win32" }).stdout.trim();
  return createRequire(join(root, "x.js"))(m);
}
function knownBrowsers() {
  const P = platform(), h = homedir();
  const list2 = P === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium", `${h}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`] : P === "win32" ? [`${process.env["PROGRAMFILES"] || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium/chrome-linux/chrome", "/snap/bin/chromium"];
  return list2.filter((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}
function ffmpegBin() {
  const cands = [flags.ffmpeg, process.env.FFMPEG, "ffmpeg"].filter(Boolean);
  for (const c of cands) if (spawnSync(c, ["-version"], { stdio: "ignore" }).status === 0) return c;
  for (const py of ["python3", "python"]) {
    const r = spawnSync(py, ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  die("ffmpeg not found. Install it (macOS: brew install ffmpeg \xB7 Windows: winget install ffmpeg \xB7 Linux: apt install ffmpeg) or set FFMPEG=/path/to/ffmpeg");
}
async function openStage(ctx, browser, { scale = 1 } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "fvs-"));
  const payload = compile(ctx.p, { resolve: (rel) => fileUrl(ctx.dir, rel) });
  const html = buildHtml(payload, runtime_src_default, { mode: "capture" });
  const page = join(tmp, "capture.html");
  writeFileSync(page, html);
  const pg = await browser.newPage({ viewport: { width: payload.width, height: payload.height }, deviceScaleFactor: scale });
  const logs = [];
  pg.on("pageerror", (e) => logs.push(String(e.message || e)));
  if (flags["no-remote-fonts"]) await pg.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await pg.route(/\.(mp3|wav|m4a|ogg|aac|flac)(\?|$)/i, (r) => r.abort());
  await pg.goto(pathToFileURL(page).href);
  const st = await pg.evaluate(async () => {
    await Promise.race([window.__stage.ready(), new Promise((r) => setTimeout(r, 15e3))]);
    return { w: __stage.w, h: __stage.h, dur: __stage.dur, fps: __stage.fps, errors: __stage.errors };
  });
  return { pg, st, tmp, payload, logs };
}
function runtimeErrors(st, logs) {
  for (const e of st.errors) console.error(`error line ${e.line || "?"} [${e.scene}]: ${e.message}`);
  for (const l of logs) console.error(`page error: ${l}`);
  return st.errors.length + logs.length;
}
var commands = {
  async new() {
    const file = pos[0] || die("fvs new <file.fvs.md>");
    const path = resolve(file.endsWith(".fvs.md") ? file : `${file}.fvs.md`);
    if (existsSync(path) && !flags.force) die(`${path} exists (pass --force to overwrite)`);
    const tpl = TEMPLATES[flags.template || "eva"] || die(`templates: ${Object.keys(TEMPLATES).join(", ")}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, tpl({ title: flags.title || basename(path, ".fvs.md"), zh: flags.lang !== "en" }));
    log(path);
  },
  async info() {
    const { p } = load(pos[0]);
    report(p, { fail: false });
    const tp = p.tempo;
    log(`${p.meta.title || "(untitled)"} \xB7 ${p.meta.width}\xD7${p.meta.height} @ ${p.meta.fps} fps \xB7 ${p.length.toFixed(2)} s${tp ? ` \xB7 ${tp.bpm} BPM ${tp.beatsPerBar}/4 (beat ${tp.beat.toFixed(3)} s, bar ${tp.bar.toFixed(3)} s)` : ""}`);
    for (const a of audioTracks(p.meta)) log(`audio ${a.role}: ${a.src}${a.at ? ` at ${a.at}s` : ""}${a.gain ? ` ${a.gain} dB` : ""}`);
    log("");
    log(`${"#".padStart(3)}  ${"id".padEnd(14)} ${"start".padStart(7)} ${"end".padStart(7)}  ${"length".padEnd(10)} hits (${tp ? "beats" : "s"} from scene start \u2192 absolute s)`);
    for (const s of p.scenes) {
      log(`${String(s.index + 1).padStart(3)}  ${s.id.padEnd(14)} ${s.t0.toFixed(2).padStart(7)} ${s.t1.toFixed(2).padStart(7)}  ${String(s.meta.length ?? "?").padEnd(10)} ${s.hits.map((h, i) => `${h}\u2192${s.hitTimes[i].toFixed(2)}`).join("  ")}${s.title ? `   # ${s.title}` : ""}`);
    }
  },
  async check() {
    const ctx = load(pos[0]);
    report(ctx.p, { fail: false });
    let n = ctx.p.errors.filter((e) => e.level === "error").length;
    if (flags.runtime) {
      const browser = await chromium();
      const { st, logs } = await openStage(ctx, browser);
      n += runtimeErrors(st, logs);
      await browser.close();
    }
    if (n) die(`${n} error(s)`);
    log(`ok \xB7 ${ctx.p.scenes.length} scenes \xB7 ${ctx.p.length.toFixed(2)} s${flags.runtime ? " \xB7 scripts ran clean" : ""}`);
  },
  async cues() {
    const { p } = load(pos[0]);
    report(p, { fail: false });
    const out = JSON.stringify(cueSheet(p), null, 2);
    if (flags.out) {
      writeFileSync(resolve(flags.out), out + "\n");
      log(resolve(flags.out));
    } else log(out);
  },
  async html() {
    const ctx = load(pos[0]);
    report(ctx.p);
    const out = resolve(flags.out || ctx.path.replace(/\.fvs\.md$/i, "") + ".html");
    const outDir = dirname(out);
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
    const resolveUrl = (rel) => {
      const abs = join(ctx.dir, rel);
      if (flags.inline && existsSync(abs)) return `data:${mime[extname(abs).toLowerCase()] || "application/octet-stream"};base64,${readFileSync(abs).toString("base64")}`;
      return relative(outDir, abs).split(sep).join("/");
    };
    const payload = compile(ctx.p, { resolve: resolveUrl });
    writeFileSync(out, buildHtml(payload, runtime_src_default, { mode: "player" }));
    log(`${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
  },
  async still() {
    const ctx = load(pos[0]);
    report(ctx.p);
    const t = timeArg(ctx.p, flags.at) ?? 0;
    const browser = await chromium();
    const { pg, st, logs } = await openStage(ctx, browser, { scale: +flags.scale || 1 });
    runtimeErrors(st, logs);
    await pg.evaluate((x) => __stage.seek(x), t);
    const out = resolve(flags.out || `${ctx.path.replace(/\.fvs\.md$/i, "")}-${t.toFixed(2)}s.png`);
    await pg.screenshot({ path: out });
    await browser.close();
    log(out);
  },
  async sheet() {
    const ctx = load(pos[0]);
    report(ctx.p);
    const p = ctx.p;
    let times;
    if (flags.every) {
      const d = +flags.every;
      times = [];
      for (let t = 0; t < p.length; t += d) times.push(t);
    } else times = p.scenes.map((s) => Math.min(s.t1 - 0.05, (s.hitTimes.length ? s.hitTimes[s.hitTimes.length - 1] : s.t0) + 0.5));
    const labels = flags.every ? times.map((t) => `${t.toFixed(1)}s`) : p.scenes.map((s) => `${s.id} \xB7 ${s.t0.toFixed(1)}s`);
    const browser = await chromium();
    const scale = 320 / p.meta.width;
    const { pg, st, logs } = await openStage(ctx, browser, { scale });
    runtimeErrors(st, logs);
    const shots = [];
    for (const t of times) {
      await pg.evaluate((x) => __stage.seek(x), t);
      shots.push((await pg.screenshot({ type: "jpeg", quality: 80 })).toString("base64"));
    }
    const cols = Math.min(6, Math.ceil(Math.sqrt(shots.length * 1.4)));
    const sheet = await browser.newPage({ viewport: { width: cols * 332 + 12, height: 400 } });
    await sheet.setContent(`<body style="margin:0;background:#111;color:#bbb;font:12px sans-serif"><div style="display:grid;grid-template-columns:repeat(${cols},320px);gap:12px;padding:12px">${shots.map((b, i) => `<figure style="margin:0"><img style="display:block;width:320px" src="data:image/jpeg;base64,${b}"><figcaption style="padding-top:4px">${labels[i]}</figcaption></figure>`).join("")}</div></body>`);
    const out = resolve(flags.out || `${ctx.path.replace(/\.fvs\.md$/i, "")}-sheet.png`);
    await sheet.screenshot({ path: out, fullPage: true });
    await browser.close();
    log(out);
  },
  async render() {
    const ctx = load(pos[0]);
    report(ctx.p);
    const p = ctx.p, fps = +flags.fps || +p.meta.fps;
    const from = timeArg(p, flags.from) ?? 0, to = Math.min(p.length, timeArg(p, flags.to) ?? p.length);
    const out = resolve(flags.out || ctx.path.replace(/\.fvs\.md$/i, "") + ".mp4");
    const ff = ffmpegBin();
    const frames = flags["keep-frames"] ? resolve(flags["keep-frames"]) : mkdtempSync(join(tmpdir(), "fvs-frames-"));
    rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    const browser = await chromium();
    const workers = Math.max(1, Math.min(8, +flags.workers || 3));
    const stages = await Promise.all([...Array(workers)].map(() => openStage(ctx, browser)));
    if (runtimeErrors(stages[0].st, stages[0].logs) && !flags.force) {
      await browser.close();
      die("scene scripts failed (see above); fix them or pass --force");
    }
    const f0 = Math.round(from * fps), f1 = Math.max(f0, Math.round(to * fps) - 1);
    const total = f1 - f0 + 1;
    let done = 0, lastPct = -1;
    const t0 = Date.now();
    await Promise.all(stages.map(async ({ pg }, k) => {
      for (let f = f0 + k; f <= f1; f += workers) {
        await pg.evaluate((t) => __stage.seek(t), f / fps);
        await pg.screenshot({ path: join(frames, `${String(f - f0).padStart(6, "0")}.png`) });
        done++;
        const pct2 = Math.floor(done / total * 20) * 5;
        if (pct2 !== lastPct) {
          lastPct = pct2;
          log(`frames ${pct2}% (${done}/${total}, ${((Date.now() - t0) / 1e3).toFixed(0)} s)`);
        }
      }
    }));
    await browser.close();
    const args = ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(frames, "%06d.png")];
    const tracks = flags["no-audio"] ? [] : audioTracks(p.meta).filter((a) => existsSync(join(ctx.dir, a.src)));
    for (const a of audioTracks(p.meta)) if (!existsSync(join(ctx.dir, a.src))) console.error(`warn audio not found, skipped: ${a.src}`);
    tracks.forEach((a) => args.push("-i", join(ctx.dir, a.src)));
    const vf = +flags.scale && +flags.scale !== 1 ? ["-vf", `scale=trunc(iw*${+flags.scale}/2)*2:-2:flags=lanczos`] : [];
    if (tracks.length) {
      const parts = tracks.map((a, i) => {
        const shift = a.at - from;
        const trim = shift < 0 ? `atrim=start=${-shift},asetpts=PTS-STARTPTS,` : "";
        const delay = shift > 0 ? `adelay=${Math.round(shift * 1e3)}:all=1,` : "";
        return `[${i + 1}:a]${trim}${delay}volume=${a.gain || 0}dB[a${i}]`;
      });
      const mix = tracks.length > 1 ? `;${tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${tracks.length}:normalize=0[aout]` : "";
      args.push("-filter_complex", parts.join(";") + mix, "-map", "0:v", "-map", tracks.length > 1 ? "[aout]" : "[a0]", "-c:a", "aac", "-b:a", flags.abr || "256k");
    }
    args.push(...vf, "-c:v", "libx264", "-preset", flags.preset || "slow", "-crf", String(flags.crf || 18), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", String(total / fps), out);
    const r = spawnSync(ff, args, { stdio: "inherit" });
    if (!flags["keep-frames"]) rmSync(frames, { recursive: true, force: true });
    if (r.status !== 0) die("ffmpeg failed");
    log(`${out} \xB7 ${total} frames \xB7 ${(total / fps).toFixed(2)} s \xB7 ${(statSync(out).size / 1048576).toFixed(1)} MB`);
  },
  async sync() {
    const { p, dir } = load(pos[0]);
    report(p, { fail: false });
    const tracks = audioTracks(p.meta);
    const src = flags.audio ? resolve(flags.audio) : tracks[0] && join(dir, tracks[0].src);
    if (!src || !existsSync(src)) die(`no audio to check against (add one to the project's "audio" or pass --audio)`);
    const at = flags.audio ? 0 : tracks[0].at || 0;
    const ff = ffmpegBin();
    const r = spawnSync(ff, ["-v", "error", "-i", src, "-ac", "1", "-ar", String(ONSET_SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
    if (r.status !== 0) die(`ffmpeg could not decode ${src}`);
    const buf = r.stdout;
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    const lead = new Float32Array(Math.round(at * ONSET_SR));
    const mono = at > 0 ? Float32Array.from([...lead, ...pcm]) : pcm;
    const rows = syncReport(p.scenes, onsetEnvelope(mono, ONSET_SR));
    let bad = 0;
    for (const x of rows) {
      const flag = x.ok ? x.quiet ? "cut to quiet" : "" : "<< weak accent";
      if (!x.ok) bad++;
      if (!x.ok || flags.all) log(`${x.t.toFixed(2).padStart(7)}s  ${x.scene}:h${x.hit}  accent ${x.strength.toFixed(2)}  ${x.offset == null ? "" : `${x.offset >= 0 ? "+" : ""}${Math.round(x.offset * 1e3)} ms`}  ${flag}`);
    }
    log(`${rows.length} hits, ${rows.length - bad} land on an accent${bad ? `, ${bad} do not (listed above)` : ""}`);
  }
};
if (!cmd || cmd === "help" || flags.help || !commands[cmd]) {
  log(HELP);
  process.exit(cmd && !commands[cmd] && cmd !== "help" ? 1 : 0);
}
commands[cmd]().catch((e) => die(e && e.stack || String(e)));
