#!/usr/bin/env node
// Forsion desktop plugin checker. Loads a plugin's main.js the way the desktop host does
// (`new Function('ctx', src)(ctx)`), records what it registers while loading, and checks every bundled
// Space against that. Answers "why is my Space / view / command not there?" without the app running.
//
//   node check-plugin.mjs <plugin folder> [--app-version 2.13.1] [--locale en]
//   node check-plugin.mjs                      every plugin installed in ~/.forsion/plugins (or pass any folder of plugins)
//
// No `node` on PATH? The Forsion app binary runs it too:
//   macOS    ELECTRON_RUN_AS_NODE=1 "/Applications/Forsion.app/Contents/MacOS/Forsion" check-plugin.mjs <plugin folder>
//   Windows  set ELECTRON_RUN_AS_NODE=1 && "%LOCALAPPDATA%\Programs\Forsion\Forsion.exe" check-plugin.mjs <plugin folder>
//
// Exit code: 0 = nothing wrong found, 1 = at least one problem, 2 = could not run.
// main.js runs in a bare vm context (no `process`, no `require`, no real DOM, timers never fire), so this is safe to
// point at a plugin you did not write, and it does not touch the user's notes.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import vm from 'node:vm';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--')) || join(homedir(), '.forsion', 'plugins');
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`not a folder: ${dir}\nusage: node check-plugin.mjs [<plugin folder>] [--app-version x.y.z] [--locale zh|en]`);
  process.exit(2);
}
const root = resolve(dir);

// A folder of plugins (the install folder itself): check each one in its own process and report them together.
if (!existsSync(join(root, 'manifest.json'))) {
  const kids = readdirSync(root).filter((n) => !n.startsWith('.') && existsSync(join(root, n, 'manifest.json'))).sort();
  if (kids.length) {
    const rest = argv.filter((a) => a !== dir);
    const bad = [];
    console.log(`Forsion plugin check: ${kids.length} plugin(s) in ${root}\n`);
    for (const kid of kids) {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), join(root, kid), ...rest], { encoding: 'utf8', timeout: 60_000 });
      if (r.status === 0) { console.log(`  ✓ ${kid}`); continue; }
      console.log(`  ✗ ${kid}: details below`);
      bad.push({ kid, text: (r.stdout || r.stderr || String(r.error || 'no output')).trim() });
    }
    for (const b of bad) console.log(`\n──────── ${b.kid} ────────\n${b.text}`);
    console.log(`\nRESULT: ${bad.length ? `${bad.length} of ${kids.length} plugin(s) have problems: ${bad.map((b) => b.kid).join(', ')}.` : `nothing wrong found in ${kids.length} plugin(s).`}`);
    process.exit(bad.length ? 1 : 0);
  }
}
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const out = [];
const problems = [];
const say = (line = '') => out.push(line);
const problem = (line) => { problems.push(line); say(`  ✗ ${line}`); };
const ok = (line) => say(`  ✓ ${line}`);
const finish = () => {
  say();
  say(problems.length ? `RESULT: ${problems.length} problem(s) found.` : 'RESULT: nothing wrong found.');
  console.log(out.join('\n'));
  process.exit(problems.length ? 1 : 0);
};

// ── 1. manifest ────────────────────────────────────────────────────────────────────────────────────────────────────
say(`Forsion plugin check: ${root}`);
say();
say('manifest.json');
let manifest;
try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); }
catch (e) { problem(`cannot read manifest.json (${e.message}). Without it the host does not treat this folder as a plugin.`); finish(); }
if (typeof manifest.id !== 'string' || !SLUG.test(manifest.id)) problem(`"id" must be kebab-case (a-z, 0-9, -): got ${JSON.stringify(manifest.id)}`);
else ok(`id ${manifest.id}, version ${manifest.version ?? '(none)'}${basename(root) !== manifest.id ? ` (folder is "${basename(root)}"; views and Spaces go by the id, not the folder name)` : ''}`);
const mainName = typeof manifest.main === 'string' ? manifest.main : 'main.js';
const mainFile = join(root, mainName);
if (!existsSync(mainFile)) { problem(`"main" points at ${mainName}, which does not exist`); finish(); }
const src = readFileSync(mainFile, 'utf8');
const lineOf = (offset) => src.slice(0, Math.max(0, offset)).split('\n').length;

// ── 2. load main.js like the host does ─────────────────────────────────────────────────────────────────────────────
say();
say(`${mainName} (${src.split('\n').length} lines), loaded the way the desktop host loads it: new Function('ctx', source)(ctx)`);
if (/^\s*(import|export)\s/m.test(src)) problem(`${mainName} has a top-level import/export. The file is evaluated as a function body, so that is a syntax error for the host.`);

const registered = []; // { kind: 'registerView', id }
let timers = 0;
const noop = () => {};
// An object that tolerates any property access or call, so UI code that runs during load does not throw here.
const anything = (path) => new Proxy(function () {}, {
  get: (_, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : anything(`${path}.${String(k)}`)),
  set: () => true,
  apply: (_, __, args) => {
    const name = path.split('.').pop();
    if (/^register[A-Z]/.test(name)) registered.push({ kind: name, id: args[0] && (args[0].id ?? args[0].key ?? args[0].type ?? null) });
    return /^(register|subscribe|watch|on[A-Z]|add)/.test(name) ? noop : anything(`${path}()`);
  },
});
const app = new Proxy({}, { get: (_, k) => (/^(watch|subscribe|on[A-Z])/.test(String(k)) ? () => noop : () => Promise.resolve(null)) });
const ctx = new Proxy({}, {
  get: (_, k) => {
    if (typeof k !== 'string') return undefined;
    if (k === 'app') return app;
    if (k === 'getLocale') return () => opt('locale') || 'zh';
    if (k === 'loadData' || k === 'saveData') return () => Promise.resolve(null);
    return anything(`ctx.${k}`);
  },
});
const element = () => anything('element');
const sandbox = {
  __ctx: ctx,
  document: { createElement: element, createElementNS: element, createTextNode: element, head: element(), body: element(), documentElement: element(),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener: noop, removeEventListener: noop },
  console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
  setTimeout: () => { timers += 1; return 0; }, setInterval: () => { timers += 1; return 0; }, clearTimeout: noop, clearInterval: noop,
  requestAnimationFrame: () => { timers += 1; return 0; }, cancelAnimationFrame: noop, queueMicrotask,
  navigator: { userAgent: 'forsion-plugin-check', language: 'zh-CN', platform: '' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { href: 'app://forsion/', protocol: 'app:', search: '', hash: '' },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
  getComputedStyle: () => anything('style'), addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, atob, btoa, structuredClone, performance: { now: () => 0 },
  MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} }, CustomEvent: class {}, Event: class {},
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;

// Precise coverage tells us which parts of the file ran. Optional: without the inspector the "why" below is skipped.
const FILE = 'forsion-plugin-main.js';
const PREFIX = '(function(ctx){\n';
let post = null;
try {
  const inspector = await import('node:inspector');
  const session = new inspector.Session();
  session.connect();
  post = (method, params) => new Promise((res, rej) => session.post(method, params, (e, r) => (e ? rej(e) : res(r))));
  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
} catch { post = null; }

let loadError = null;
let returned;
const lateErrors = [];
process.on('unhandledRejection', (e) => lateErrors.push(String((e && e.message) || e)));
try {
  returned = vm.runInNewContext(`${PREFIX}${src}\n})(__ctx)`, sandbox, { filename: FILE, timeout: 5000 });
  if (returned && typeof returned.then === 'function') returned = await Promise.race([returned, new Promise((r) => setTimeout(() => r(undefined), 3000))]);
} catch (e) {
  const at = /forsion-plugin-main\.js:(\d+)/.exec(String(e && e.stack));
  loadError = `${(e && e.name) || 'Error'}: ${(e && e.message) || e}${at ? ` (line ${Number(at[1]) - 1})` : ''}`;
}
await new Promise((r) => setTimeout(r, 30));

let functions = [];
if (post) {
  try {
    const { result } = await post('Profiler.takePreciseCoverage');
    functions = result.find((s) => s.url === FILE)?.functions ?? [];
  } catch { /* coverage is best-effort */ }
}
/** The largest piece of the file that never ran and contains `offset` (offsets are into main.js itself). */
const deadRegionAt = (offset) => {
  let best = null;
  for (const fn of functions) {
    for (const [i, r] of fn.ranges.entries()) {
      const start = r.startOffset - PREFIX.length, end = r.endOffset - PREFIX.length;
      if (r.count !== 0 || offset < start || offset >= end || start < 0) continue; // start < 0 = the wrapper itself
      if (!best || end - start > best.end - best.start) best = { start, end, name: i === 0 ? fn.functionName : '', isFunction: i === 0 };
    }
  }
  return best;
};

if (loadError) {
  problem(`loading threw: ${loadError}`);
  say('    The host reports this as "failed to load" and rolls back everything the plugin registered. If the line above is a');
  say('    browser or host API this checker does not imitate, it may not happen in the app; read the code at that line to tell.');
} else {
  ok(`loaded without throwing; returned ${typeof returned === 'function' ? 'a cleanup function' : typeof returned}`);
}
const byKind = {};
for (const r of registered) (byKind[r.kind] ||= []).push(r.id ?? '?');
const kinds = Object.keys(byKind);
if (kinds.length) for (const k of kinds) ok(`${k} × ${byKind[k].length}: ${byKind[k].join(', ')}`);
else say('  · registered nothing while loading (no views, commands, settings, status items …)');
if (lateErrors.length) say(`  · after loading, async code rejected: ${lateErrors[0]} (often a limit of this checker's stand-in APIs, not a plugin bug)`);
const views = new Set((byKind.registerView || []).map(String));

// ── 3. bundled Spaces (worked out before printing: which views are missing decides what is worth explaining) ─────────
const cmp = (a, b) => { const x = String(a).replace(/^v/i, '').split('.'), y = String(b).replace(/^v/i, '').split('.'); for (let i = 0; i < Math.max(x.length, y.length); i++) { const p = parseInt(x[i] ?? '0', 10) || 0, q = parseInt(y[i] ?? '0', 10) || 0; if (p !== q) return p < q ? -1 : 1; } return 0; };
const spacesDir = join(root, 'spaces');
const slugs = existsSync(spacesDir) ? readdirSync(spacesDir).filter((s) => existsSync(join(spacesDir, s, 'space.json'))) : [];
const own = `plugin:${manifest.id}:`;
const spaces = []; // { label, reasons[], notes[] }
const missingViews = new Set();
for (const slug of slugs) {
  let spec;
  try { spec = JSON.parse(readFileSync(join(spacesDir, slug, 'space.json'), 'utf8')); }
  catch (e) { spaces.push({ label: `spaces/${slug}/space.json`, reasons: [`not valid JSON (${e.message})`], notes: [] }); continue; }
  const reasons = [], notes = [];
  if (typeof spec.id !== 'string' || !SLUG.test(spec.id)) reasons.push(`"id" must be kebab-case, got ${JSON.stringify(spec.id)}`);
  const lay = spec.layout && typeof spec.layout === 'object' ? spec.layout : null;
  if (!lay || !Array.isArray(lay.main) || !lay.main.length) reasons.push('layout.main must list at least one view');
  const types = new Set();
  for (const side of ['main', 'left', 'right', 'bottom']) for (const p of Array.isArray(lay?.[side]) ? lay[side] : []) if (p && typeof p.type === 'string') types.add(p.type);
  for (const v of Array.isArray(spec.requires?.views) ? spec.requires.views : []) if (typeof v === 'string') types.add(v);
  const missing = [...types].filter((t) => t.startsWith(own) && !views.has(t.slice(own.length)));
  const foreign = [...types].filter((t) => t.startsWith('plugin:') && !t.startsWith(own));
  const wrongOwner = foreign.filter((t) => views.has(t.split(':').pop()));
  for (const t of missing) missingViews.add(t.slice(own.length));
  if (missing.length) reasons.push(`needs ${missing.join(', ')}, which ${mainName} did not register while loading`);
  if (wrongOwner.length) reasons.push(`names ${wrongOwner.join(', ')}, but this plugin's id is "${manifest.id}" — the view type must be ${wrongOwner.map((t) => own + t.split(':').pop()).join(', ')}`);
  const appVersion = opt('app-version');
  if (typeof spec.minAppVersion === 'string' && appVersion && cmp(appVersion, spec.minAppVersion) < 0) reasons.push(`needs app ≥ ${spec.minAppVersion}, the app is ${appVersion}`);
  else if (typeof spec.minAppVersion === 'string' && !appVersion) notes.push(`needs app ≥ ${spec.minAppVersion}; pass --app-version to check`);
  const others = foreign.filter((t) => !wrongOwner.includes(t));
  if (others.length) notes.push(`also needs views of other plugins (${others.join(', ')}): those plugins must be installed and enabled`);
  spaces.push({ label: `Space "${spec.id ?? slug}"`, reasons, notes });
}

// ── 4. registration code that exists but did not run ───────────────────────────────────────────────────────────────
// Reported only when it explains something: a Space is missing one of this plugin's views, or nothing was registered at
// all. A registration that is skipped on purpose (platform check, optional host API) is normal and stays unmentioned.
const HOST_REGISTER = /\.\s*(register(?:View|Command|Setting|SettingsView|StatusItem|SlashItem|Panel|Theme|FileType|EmbedRenderer|FileCreator|ListSource|PropertyType|SelectionAction|Readiness|StoreView|Appearance|Font|EditorExtension|Companion|Series))\s*(?:\?\.)?\s*\(/g;
const sites = [...src.matchAll(HOST_REGISTER)].map((m) => ({ kind: m[1], offset: m.index, line: lineOf(m.index), after: src.slice(m.index, m.index + 400), dead: deadRegionAt(m.index) }));
let explain = [];
if (!loadError && missingViews.size) {
  const viewSites = sites.filter((x) => x.kind === 'registerView');
  const named = viewSites.filter((x) => [...missingViews].some((id) => new RegExp(`\\bid\\s*:\\s*['"\`]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(x.after)));
  const relevant = named.length ? named : viewSites;
  explain = relevant.filter((x) => x.dead);
  say();
  if (!viewSites.length) problem(`${mainName} has no ctx.registerView(...) call at all, so ${[...missingViews].join(', ')} can never exist.`);
  else if (!explain.length && named.length) problem(`${mainName} reaches ctx.registerView at line ${named.map((x) => x.line).join(', ')} but ${[...missingViews].join(', ')} was not registered: check the id spelling${views.size ? ` (registered: ${[...views].join(', ')})` : ''} and whether the call is guarded by a condition.`);
  else if (!explain.length) problem(`No ctx.registerView call in ${mainName} uses the id ${[...missingViews].join(', ')}${views.size ? ` (registered: ${[...views].join(', ')})` : ''}. The Space and the view id must match exactly.`);
} else if (!loadError && !kinds.length) {
  // Nothing registered and no Space to hold it against: only a function nobody called is worth calling a problem.
  // Code behind a false condition usually waits for a host feature this checker does not imitate.
  explain = sites.filter((x) => x.dead && x.dead.isFunction);
  const gated = sites.filter((x) => x.dead && !x.dead.isFunction);
  if (!explain.length && gated.length) say(`  · its registration code (line ${[...new Set(gated.map((x) => x.line))].slice(0, 5).join(', ')}) sits behind a condition that was false here; it may depend on a host feature this checker does not imitate.`);
  if (explain.length) say();
}
if (explain.length) {
  say(`Why: registration code exists in ${mainName} but did NOT run while loading`);
  const regions = new Map();
  for (const x of explain) {
    const key = `${x.dead.start}-${x.dead.end}`;
    if (!regions.has(key)) regions.set(key, { dead: x.dead, calls: [] });
    regions.get(key).calls.push(`${x.kind} (line ${x.line})`);
  }
  const total = src.split('\n').length;
  for (const { dead, calls } of regions.values()) {
    const from = lineOf(dead.start), to = lineOf(dead.end);
    const what = dead.isFunction ? `function ${dead.name || '(anonymous)'}` : 'a block';
    const where = from === to ? `line ${from}` : `lines ${from}–${to}`;
    problem(`${calls.slice(0, 6).join(', ')}${calls.length > 6 ? ` … +${calls.length - 6} more` : ''} ${calls.length > 1 ? 'sit' : 'sits'} inside ${what}, ${where}, which never ran. It starts: ${JSON.stringify(src.slice(dead.start, dead.start + 70).split('\n')[0])}`);
    if (dead.isFunction && to >= total - 2 && to - from > 40) {
      say('    That function runs to the last line of the file. It was almost certainly meant to end much earlier: look for a missing');
      say(`    closing brace where ${dead.name || 'it'} should end (shortly after line ${from}), and for a stray "}" at the very end of the file.`);
    } else if (dead.isFunction) {
      say('    The host only evaluates the file body; nothing calls that function during load. Registration has to happen at the top');
      say('    level of the file (or in a function the top level calls). A file wrapped as `function setup(ctx) { … }` is the usual case.');
    } else {
      say('    An early return, a false condition or an exception above it keeps execution from reaching these lines.');
    }
  }
}
if (!kinds.length && !explain.length && !loadError && timers) say(`  · ${timers} timer(s) were scheduled during load; anything registered from a timer or an event is not counted here.`);

say();
say(slugs.length ? 'Bundled Spaces (the host shows a Space only if every view it names is registered once the plugin has loaded)' : 'Bundled Spaces: none (no spaces/<slug>/space.json)');
let hidden = 0;
for (const sp of spaces) {
  if (sp.reasons.length) { hidden += 1; problem(`${sp.label} will be HIDDEN: ${sp.reasons.join('; ')}`); }
  else ok(`${sp.label}: every view it needs from this plugin is registered`);
  for (const n of sp.notes) say(`    ${n}`);
}

// ── 5. what it means ───────────────────────────────────────────────────────────────────────────────────────────────
if (hidden && !loadError && explain.length) {
  say();
  say(`What this means: the Space is missing because of a bug in this plugin's own ${mainName}, not because the app or its plugin`);
  say('API changed. The host loads the file exactly as this checker did: it runs without an error, so the host shows no');
  say('"failed to load" badge, but the registration code is never reached, so the views do not exist and the host quietly');
  say('skips every Space that needs them. This result does not depend on a real host: fix the structure pointed out above, then');
  say('run this check again until the views are listed. No reinstall or app downgrade will help.');
} else if (hidden && !loadError && missingViews.size) {
  say();
  say(`What this means: ${mainName} loads without an error but the view the Space needs is not registered, so the host quietly skips`);
  say('the Space. That is decided by this plugin\'s own files (view id, registration code), not by the app version.');
}
finish();
