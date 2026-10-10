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
// Exit code: 0 = nothing wrong found, 1 = at least one problem, 2 = could not run, 3 = undecided (see the "?" lines).
//
// What "loads" means here: main.js IS EXECUTED — in a separate process that is killed if it hangs, inside a bare vm
// context whose every object is created inside that context (no `process`, no `require`, no real DOM, timers never
// fire), and under Node's permission model where the runtime has it (no file writes, no child processes; the app's own
// runtime has it). That keeps a plugin away from the user's notes and files. It is a dry run with stand-in host APIs and
// no saved plugin data, and Node's vm is not a hardened sandbox: do not point it at a plugin you would not install.
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';

const argv = process.argv.slice(2);
const FILE = 'forsion-plugin-main.js';
// How long a plugin may take to load before the probe is killed (ms). The env knob is for slow machines and for tests.
const HARD_MS = Number(process.env.FORSION_PLUGIN_CHECK_TIMEOUT_MS) || 20_000;
const PREFIX = '__probeRun(function(ctx){\n';

// ── the load probe (child process): run main.js, print one JSON line ───────────────────────────────────────────────
// Everything the plugin can reach is built by this bootstrap INSIDE the vm context. Handing it any object from this
// process (a function, `URL`, `console`) would hand it this process: `fn.constructor('return process')()`.
const BOOT = String.raw`(function () {
  'use strict';
  var state = { error: null, returned: 'undefined', registered: [], late: [], timers: 0, settled: false };
  var stringify = JSON.stringify;
  var noop = function () {};
  var text = function (v) { try { return String(v); } catch (e) { return '?'; } };
  var anything = function (path) {
    return new Proxy(function () {}, {
      get: function (_, k) { return k === 'then' ? undefined : k === Symbol.toPrimitive ? function () { return ''; } : anything(path + '.' + text(k)); },
      set: function () { return true; },
      apply: function (_, __, args) {
        var name = path.split('.').pop();
        if (/^register[A-Z]/.test(name)) {
          var id = null;
          try { var a = args[0]; id = a && (a.id != null ? a.id : a.key != null ? a.key : a.type != null ? a.type : null); } catch (e) { /* a throwing getter is the plugin's business */ }
          state.registered.push({ kind: name, id: id == null ? null : text(id).slice(0, 120) });
        }
        return /^(register|subscribe|watch|on[A-Z]|add)/.test(name) ? noop : anything(path + '()');
      },
    });
  };
  var app = new Proxy({}, { get: function (_, k) { return /^(watch|subscribe|on[A-Z])/.test(text(k)) ? function () { return noop; } : function () { return Promise.resolve(null); }; } });
  var ctx = new Proxy({}, { get: function (_, k) {
    if (typeof k !== 'string') return undefined;
    if (k === 'app') return app;
    if (k === 'getLocale') return function () { return __LOCALE__; };
    if (k === 'loadData' || k === 'saveData') return function () { return Promise.resolve(null); };
    return anything('ctx.' + k);
  } });
  var element = function () { return anything('element'); };
  var timer = function () { state.timers += 1; return 0; };
  var storage = function () { return { getItem: function () { return null; }, setItem: noop, removeItem: noop }; };
  var Observer = function () {}; Observer.prototype = { observe: noop, disconnect: noop, unobserve: noop };
  var g = globalThis;
  var globals = {
    document: { createElement: element, createElementNS: element, createTextNode: element, head: element(), body: element(), documentElement: element(),
      querySelector: function () { return null; }, querySelectorAll: function () { return []; }, getElementById: function () { return null; }, addEventListener: noop, removeEventListener: noop },
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    setTimeout: timer, setInterval: timer, clearTimeout: noop, clearInterval: noop, requestAnimationFrame: timer, cancelAnimationFrame: noop,
    queueMicrotask: function (f) { Promise.resolve().then(f); },
    navigator: { userAgent: 'forsion-plugin-check', language: 'zh-CN', platform: '' },
    localStorage: storage(), sessionStorage: storage(),
    location: { href: 'app://forsion/', protocol: 'app:', search: '', hash: '' },
    matchMedia: function () { return { matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }; },
    getComputedStyle: function () { return anything('style'); }, addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    performance: { now: function () { return 0; } },
    structuredClone: function (v) { return v === undefined ? v : JSON.parse(stringify(v)); },
    URL: anything('URL'), URLSearchParams: anything('URLSearchParams'), TextEncoder: anything('TextEncoder'), TextDecoder: anything('TextDecoder'),
    AbortController: anything('AbortController'), atob: function () { return ''; }, btoa: function () { return ''; },
    MutationObserver: Observer, ResizeObserver: Observer, IntersectionObserver: Observer, CustomEvent: function () {}, Event: function () {},
  };
  for (var name in globals) g[name] = globals[name];
  g.window = g; g.self = g;
  var describe = function (e) {
    var at = null;
    try { at = /forsion-plugin-main\.js:(\d+)/.exec(text(e && e.stack)); } catch (x) { /* no line then */ }
    var head = '';
    try { head = (e && e.name ? text(e.name) : 'Error') + ': ' + text(e && e.message != null ? e.message : e); } catch (x) { head = 'Error'; }
    return head.slice(0, 600) + (at ? ' (line ' + (Number(at[1]) - 1) + ')' : '');
  };
  Object.defineProperty(g, '__probeRun', { value: function (body) {
    try {
      var r = body(ctx);
      state.returned = typeof r;
      if (r && typeof r.then === 'function') {
        Promise.resolve(r).then(function (v) { state.returned = typeof v; state.settled = true; }, function (e) { state.late.push(describe(e)); state.settled = true; });
      } else state.settled = true;
    } catch (e) { state.error = describe(e); state.settled = true; }
  } });
  Object.defineProperty(g, '__probeRead', { value: function () { return stringify(state); } });
})()`;

async function probe(mainFile, nonce, locale) {
  const src = readFileSync(mainFile, 'utf8');
  const out = { loadError: null, returned: 'undefined', registered: [], late: [], timers: 0, dead: null };
  // Precise coverage says which parts of the file ran. Optional: without the inspector the "why" is skipped.
  let post = null;
  try {
    const inspector = await import('node:inspector');
    const session = new inspector.Session();
    session.connect();
    post = (method, params) => new Promise((res, rej) => session.post(method, params, (e, r) => (e ? rej(e) : res(r))));
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  } catch { post = null; }

  const context = vm.createContext(Object.create(null));
  vm.runInContext(BOOT.replace('__LOCALE__', JSON.stringify(locale === 'en' ? 'en' : 'zh')), context, { filename: 'forsion-check-boot.js' });
  // Read the probe's state as a string made inside the context. Values that come out of the context are never
  // inspected, logged or called from here: that would pass this process's functions into plugin code.
  const read = () => {
    try { const t = vm.runInContext('__probeRead()', context, { timeout: 1000 }); return typeof t === 'string' ? JSON.parse(t) : null; } catch { return null; }
  };
  process.on('unhandledRejection', () => {}); // a stand-in API the plugin awaited and then tripped over; reported via `late` when it is the setup promise

  let script = null;
  // Our own sourceURL goes last, so a `//# sourceURL=` inside the plugin cannot rename the script coverage is looked up by.
  try { script = new vm.Script(`${PREFIX}${src}\n})\n//# sourceURL=${FILE}`, { filename: FILE }); }
  catch (e) { // a SyntaxError raised by this process's compiler, not a plugin object: safe to read
    const at = /forsion-plugin-main\.js:(\d+)/.exec(String(e.stack));
    out.loadError = `${e.name}: ${e.message}${at ? ` (line ${Number(at[1]) - 1})` : ''}`;
    if (/import statement|Unexpected token 'export'|import\.meta/.test(e.message)) out.loadError += '. The file is evaluated as a function body, so a top-level import / export is a syntax error for the host';
  }
  if (script) {
    let threw = false;
    try { script.runInContext(context, { timeout: 5000 }); } catch { threw = true; }
    const deadline = Date.now() + 3000; // an async setup gets 3 s; the host awaits it too
    for (;;) {
      await new Promise((r) => setImmediate(r));
      const s = read();
      if (!s || s.settled || Date.now() > deadline) break;
    }
    const s = read();
    if (s) {
      out.loadError = typeof s.error === 'string' ? s.error : null;
      out.returned = String(s.returned);
      out.registered = Array.isArray(s.registered) ? s.registered.filter((r) => r && typeof r.kind === 'string').map((r) => ({ kind: r.kind, id: r.id == null ? null : String(r.id) })) : [];
      out.late = Array.isArray(s.late) ? s.late.map(String) : [];
      out.timers = Number(s.timers) || 0;
    }
    if (threw && !out.loadError) out.loadError = 'main.js did not finish its synchronous part within 5 s (an endless loop at load?), or it broke the stand-in globals this checker gives it';
  }
  if (post) {
    try {
      const { result } = await post('Profiler.takePreciseCoverage');
      const functions = result.find((s) => s.url === FILE)?.functions;
      // Only the pieces that never ran go back: [start, end, is it a whole function, its name]. A big plugin has
      // thousands of ranges, and the whole list would not fit through the pipe in one write.
      if (functions) out.dead = functions.flatMap((fn) => fn.ranges.flatMap((r, i) => (r.count === 0 ? [[r.startOffset, r.endOffset, i === 0 ? 1 : 0, i === 0 ? String(fn.functionName || '') : '']] : [])));
    } catch { /* coverage is best-effort */ }
  }
  // Exit only once the line is flushed: a pipe takes a large write in pieces, and exiting first cuts it short.
  await new Promise((done) => process.stdout.write(`\n@@${nonce}@@${JSON.stringify(out)}\n`, done));
}

if (argv[0] === '--probe') {
  await probe(argv[1], argv[2], argv[3]);
  process.exit(0);
}

// ── the checker ────────────────────────────────────────────────────────────────────────────────────────────────────
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--')) || join(homedir(), '.forsion', 'plugins');
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`not a folder: ${dir}\nusage: node check-plugin.mjs [<plugin folder>] [--app-version x.y.z] [--locale zh|en]`);
  process.exit(2);
}
const root = resolve(dir);
const SELF = fileURLToPath(import.meta.url);

// A folder of plugins (the install folder itself): check each one in its own process and report them together.
if (!existsSync(join(root, 'manifest.json'))) {
  const kids = readdirSync(root).filter((n) => !n.startsWith('.') && existsSync(join(root, n, 'manifest.json'))).sort();
  if (kids.length) {
    const rest = argv.filter((a) => a !== dir);
    const bad = [], unsure = [];
    console.log(`Forsion plugin check: ${kids.length} plugin(s) in ${root}\n`);
    for (const kid of kids) {
      const r = spawnSync(process.execPath, [SELF, join(root, kid), ...rest], { encoding: 'utf8', timeout: 90_000 });
      if (r.status === 0) { console.log(`  ✓ ${kid}`); continue; }
      const text = (r.stdout || r.stderr || String(r.error || 'no output')).trim();
      if (r.status === 3) { console.log(`  ? ${kid}: undecided from the files alone, details below`); unsure.push({ kid, text }); }
      else { console.log(`  ✗ ${kid}: details below`); bad.push({ kid, text }); }
    }
    for (const b of [...bad, ...unsure]) console.log(`\n──────── ${b.kid} ────────\n${b.text}`);
    const tail = unsure.length ? ` Undecided (ask the running app): ${unsure.map((b) => b.kid).join(', ')}.` : '';
    console.log(`\nRESULT: ${bad.length ? `${bad.length} of ${kids.length} plugin(s) have problems: ${bad.map((b) => b.kid).join(', ')}.` : `nothing wrong found in ${kids.length - unsure.length} of ${kids.length} plugin(s).`}${tail}`);
    process.exit(bad.length ? 1 : 0);
  }
}
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASK_APP = 'Ask the running app: its `plugin-status` command (run_ui_command), or the plugin\'s card in Settings → Plugins.';
const out = [];
const problems = [];
const unsure = [];
const say = (line = '') => out.push(line);
const problem = (line) => { problems.push(line); say(`  ✗ ${line}`); };
const undecided = (line) => { unsure.push(line); say(`  ? ${line}`); };
const ok = (line) => say(`  ✓ ${line}`);
const finish = () => {
  say();
  if (problems.length) say(`RESULT: ${problems.length} problem(s) found.`);
  else if (unsure.length) say(`RESULT: undecided. Nothing is provably wrong in the files, but ${unsure.length} thing(s) depend on what only the running app knows. ${ASK_APP}`);
  else say('RESULT: nothing wrong found in what this checker covers: how main.js loads, what it registers, and the views each bundled Space needs. Whether the plugin is switched on, blocked or failing inside the app is the app\'s to say.');
  console.log(out.join('\n'));
  process.exit(problems.length ? 1 : unsure.length ? 3 : 0);
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
const mainName = typeof manifest.main === 'string' && manifest.main ? manifest.main : 'main.js';
const mainFile = join(root, mainName);
// The host lets a bundle (engine plugins / agents / skills / Spaces only) omit main.js, but only when "main" is not declared.
const bundleOnly = !existsSync(mainFile) && !manifest.main && ['tangu-plugins', 'agents', 'skills', 'spaces'].some((d) => existsSync(join(root, d)));
if (!existsSync(mainFile) && !bundleOnly) { problem(`"main" points at ${mainName}, which does not exist`); finish(); }
const src = bundleOnly ? '' : readFileSync(mainFile, 'utf8');
const lineOf = (offset) => src.slice(0, Math.max(0, offset)).split('\n').length;

// ── 2. load main.js like the host does ─────────────────────────────────────────────────────────────────────────────
say();
let run = { loadError: null, returned: 'undefined', registered: [], late: [], timers: 0, dead: null };
if (bundleOnly) say(`no ${mainName}: a bundle-only plugin (the host loads it with no desktop code, so it registers no views)`);
else {
  say(`${mainName} (${src.split('\n').length} lines), loaded the way the desktop host loads it: new Function('ctx', source)(ctx)`);
  const nonce = randomBytes(8).toString('hex');
  // Node's permission model where this runtime has it (Node ≥ 24, the app's own runtime): no file writes, no child
  // processes, reads limited to this script and the plugin. Decided up front: never retried without it after a failure.
  const flags = process.allowedNodeEnvironmentFlags;
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const confine = flags.has('--permission') && flags.has('--allow-inspector')
    ? ['--permission', '--allow-inspector', `--allow-fs-read=${real(SELF)}`, `--allow-fs-read=${real(root)}`] : [];
  const r = spawnSync(process.execPath, ['--max-old-space-size=512', ...confine, real(SELF), '--probe', real(mainFile), nonce, opt('locale') || 'zh'],
    { encoding: 'utf8', timeout: HARD_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith(`@@${nonce}@@`));
  let parsed = null;
  try { parsed = line ? JSON.parse(line.slice(nonce.length + 4)) : null; } catch { /* treated as no result */ }
  if (parsed) run = parsed;
  else {
    const hung = r.signal === 'SIGKILL' || (r.error && r.error.code === 'ETIMEDOUT');
    problem(hung
      ? `${mainName} did not finish loading within ${HARD_MS / 1000} s and was stopped: it blocks the thread while loading (an endless loop or a busy wait, possibly in a promise callback). In the app that freezes the window.`
      : `the load probe gave no result (exit ${r.status ?? r.signal ?? '?'}): ${String(r.stderr || r.error || '').trim().split('\n').pop().slice(0, 200) || 'no output'}`);
    finish();
  }
}
const { loadError } = run;
const functions = Array.isArray(run.dead) ? run.dead : null; // the never-run pieces; null = no coverage: which lines ran is unknown
/** The largest piece of the file that never ran and contains `offset` (offsets are into main.js itself). */
const deadRegionAt = (offset) => {
  let best = null;
  for (const [from, to, whole, name] of functions || []) {
    const start = from - PREFIX.length, end = to - PREFIX.length;
    if (offset < start || offset >= end || start < 0) continue; // start < 0 = the wrapper itself
    if (!best || end - start > best.end - best.start) best = { start, end, name: whole ? String(name || '') : '', isFunction: !!whole };
  }
  return best;
};

if (!bundleOnly) {
  if (loadError) {
    problem(`loading threw: ${loadError}`);
    say('    The host reports this as "failed to load" and rolls back everything the plugin registered. If the line above is a');
    say('    browser or host API this checker does not imitate, it may not happen in the app; read the code at that line to tell.');
  } else {
    ok(`loaded without throwing; returned ${run.returned === 'function' ? 'a cleanup function' : run.returned}`);
  }
}
const byKind = {};
for (const r of run.registered) (byKind[r.kind] ||= []).push(r.id ?? '?');
const kinds = Object.keys(byKind);
if (kinds.length) for (const k of kinds) ok(`${k} × ${byKind[k].length}: ${byKind[k].join(', ')}`);
else if (!bundleOnly) say('  · registered nothing while loading (no views, commands, settings, status items …)');
if (run.late.length) say(`  · after loading, async code rejected: ${run.late[0]} (often a limit of this checker's stand-in APIs, not a plugin bug)`);
const views = new Set((byKind.registerView || []).map(String));

// ── 3. bundled Spaces (worked out before printing: which views are missing decides what is worth explaining) ─────────
const cmp = (a, b) => { const x = String(a).replace(/^v/i, '').split('.'), y = String(b).replace(/^v/i, '').split('.'); for (let i = 0; i < Math.max(x.length, y.length); i++) { const p = parseInt(x[i] ?? '0', 10) || 0, q = parseInt(y[i] ?? '0', 10) || 0; if (p !== q) return p < q ? -1 : 1; } return 0; };
const spacesDir = join(root, 'spaces');
const slugs = existsSync(spacesDir) ? readdirSync(spacesDir).filter((s) => existsSync(join(spacesDir, s, 'space.json'))) : [];
const own = `plugin:${manifest.id}:`;
const spaces = []; // { label, reasons[] (the recipe itself is wrong), missing[] (own views not registered), notes[] }
const missingViews = new Set();
for (const slug of slugs) {
  let spec;
  try { spec = JSON.parse(readFileSync(join(spacesDir, slug, 'space.json'), 'utf8')); }
  catch (e) { spaces.push({ label: `spaces/${slug}/space.json`, reasons: [`not valid JSON (${e.message})`], missing: [], notes: [] }); continue; }
  const reasons = [], notes = [];
  if (!spec || typeof spec !== 'object') { spaces.push({ label: `spaces/${slug}/space.json`, reasons: ['must be a JSON object'], missing: [], notes: [] }); continue; }
  // The recipe rules a plugin author trips over most. Not the host's whole validator: the app has the final word.
  if (typeof spec.id !== 'string' || !SLUG.test(spec.id)) reasons.push(`"id" must be kebab-case, got ${JSON.stringify(spec.id)}`);
  const nameOk = (typeof spec.name === 'string' && spec.name.trim()) || (spec.name && typeof spec.name === 'object' && !Array.isArray(spec.name) && (typeof spec.name.zh === 'string' || typeof spec.name.en === 'string'));
  if (!nameOk) reasons.push('"name" must be a non-empty string or { zh?, en? }');
  const lay = spec.layout && typeof spec.layout === 'object' ? spec.layout : null;
  if (!lay || !Array.isArray(lay.main) || !lay.main.length) reasons.push('layout.main must list at least one view');
  const types = new Set();
  for (const side of ['main', 'left', 'right', 'bottom']) {
    if (lay?.[side] !== undefined && !Array.isArray(lay[side])) { reasons.push(`layout.${side} must be an array`); continue; }
    for (const p of lay?.[side] ?? []) {
      if (!p || typeof p !== 'object' || typeof p.type !== 'string' || !p.type) { reasons.push(`every entry of layout.${side} must be { type: string }`); continue; }
      if (p.params !== undefined && (typeof p.params !== 'object' || p.params === null || Array.isArray(p.params))) reasons.push(`layout.${side}: "params" of ${p.type} must be an object`);
      types.add(p.type);
    }
  }
  for (const v of Array.isArray(spec.requires?.views) ? spec.requires.views : []) if (typeof v === 'string') types.add(v);
  const missing = [...types].filter((t) => t.startsWith(own) && !views.has(t.slice(own.length)));
  for (const t of missing) missingViews.add(t.slice(own.length));
  const appVersion = opt('app-version');
  if (typeof spec.minAppVersion === 'string' && appVersion && cmp(appVersion, spec.minAppVersion) < 0) reasons.push(`needs app ≥ ${spec.minAppVersion}, the app is ${appVersion}`);
  else if (typeof spec.minAppVersion === 'string' && !appVersion) notes.push(`needs app ≥ ${spec.minAppVersion}; pass --app-version to check`);
  const foreign = [...types].filter((t) => t.startsWith('plugin:') && !t.startsWith(own));
  if (foreign.length) notes.push(`also names views of other plugins (${foreign.join(', ')}): the Space shows only while those plugins are installed and running`);
  const lookalike = foreign.filter((t) => views.has(t.split(':').pop()));
  if (lookalike.length) notes.push(`this plugin registers ${lookalike.map((t) => `"${t.split(':').pop()}"`).join(', ')} itself: if you meant your own view, the type is ${lookalike.map((t) => own + t.split(':').pop()).join(', ')} (this plugin's id is "${manifest.id}")`);
  spaces.push({ label: `Space "${typeof spec.id === 'string' ? spec.id : slug}"`, reasons, missing, notes });
}

// ── 4. registration code that exists but did not run ───────────────────────────────────────────────────────────────
// Reported only when it explains something: a Space is missing one of this plugin's views, or nothing was registered at
// all. A registration that is skipped on purpose (platform check, optional host API) is normal and stays unmentioned.
const HOST_REGISTER = /\.\s*(register(?:View|Command|Setting|SettingsView|StatusItem|SlashItem|Panel|Theme|FileType|EmbedRenderer|FileCreator|ListSource|PropertyType|SelectionAction|Readiness|StoreView|Appearance|Font|EditorExtension|Companion|Series))\s*(?:\?\.)?\s*\(/g;
const sites = [...src.matchAll(HOST_REGISTER)].map((m) => ({ kind: m[1], offset: m.index, line: lineOf(m.index), after: src.slice(m.index, m.index + 400), dead: deadRegionAt(m.index) }));
const total = src.split('\n').length;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reachesEnd = (dead) => lineOf(dead.end) >= total - 2 && lineOf(dead.end) - lineOf(dead.start) > 40;
/** A never-run function is PROOF only when nothing could have called it: it swallowed the rest of the file, or its name
 *  is used nowhere outside its own body (bar `return name`: the host calls a returned function on unload, not on load).
 *  Otherwise something may call it under a condition this dry run could not satisfy (saved data, a host feature, an event). */
const provable = (dead) => {
  if (!dead.isFunction) return false;
  if (reachesEnd(dead)) return true;
  if (!dead.name) return false; // a callback: runs when its event fires
  const outside = src.slice(0, dead.start) + ' '.repeat(dead.end - dead.start) + src.slice(dead.end);
  return !outside.replace(new RegExp(`\\breturn\\s+${esc(dead.name)}\\b`, 'g'), '').match(new RegExp(`(?<![.\\w$])${esc(dead.name)}\\b`));
};
let explain = [];   // provably unreached
let maybe = [];     // unreached in this dry run only
let viewsVerdict = missingViews.size ? 'problem' : 'fine'; // how sure we are that the missing views are missing in the app too
if (!loadError && missingViews.size) {
  const viewSites = sites.filter((x) => x.kind === 'registerView');
  const named = viewSites.filter((x) => [...missingViews].some((id) => new RegExp(`\\bid\\s*:\\s*['"\`]${esc(id)}['"\`]`).test(x.after)));
  const relevant = named.length ? named : viewSites;
  explain = relevant.filter((x) => x.dead && provable(x.dead));
  maybe = explain.length ? [] : relevant.filter((x) => x.dead && !provable(x.dead));
  const list = [...missingViews].join(', ');
  say();
  if (bundleOnly) problem(`this plugin has no ${mainName}, so ${list} can never be registered.`);
  else if (!viewSites.length) problem(`${mainName} has no ctx.registerView(...) call at all, so ${list} can never exist.`);
  else if (explain.length) { /* explained below */ }
  else if (maybe.length) viewsVerdict = 'undecided';
  else if (!functions) { viewsVerdict = 'undecided'; undecided(`${list} was not registered in this dry run, and this runtime gave no coverage data, so which lines of ${mainName} ran is unknown. ${ASK_APP}`); }
  else if (named.length) problem(`${mainName} ran its ctx.registerView call at line ${named.map((x) => x.line).join(', ')}, but ${list} was not registered: check the id spelling${views.size ? ` (registered: ${[...views].join(', ')})` : ''}.`);
  else problem(`No ctx.registerView call in ${mainName} uses the id ${list}${views.size ? ` (registered: ${[...views].join(', ')})` : ''}. The Space and the view id must match exactly.`);
} else if (!loadError && !kinds.length && !bundleOnly) {
  // Nothing registered and no Space to hold it against: only a function nothing could have called is worth calling a
  // problem. Code behind a condition usually waits for a host feature this checker does not imitate.
  explain = sites.filter((x) => x.dead && provable(x.dead));
  const gated = sites.filter((x) => x.dead && !provable(x.dead));
  if (!explain.length && gated.length) say(`  · its registration code (line ${[...new Set(gated.map((x) => x.line))].slice(0, 5).join(', ')}) did not run in this dry run: it sits behind a condition, or in code that runs later; it may depend on a host feature or saved data this checker does not have.`);
  if (explain.length) say();
}
const regionsOf = (list) => {
  const regions = new Map();
  for (const x of list) {
    const key = `${x.dead.start}-${x.dead.end}`;
    if (!regions.has(key)) regions.set(key, { dead: x.dead, calls: [] });
    regions.get(key).calls.push(`${x.kind} (line ${x.line})`);
  }
  return [...regions.values()].map(({ dead, calls }) => {
    const from = lineOf(dead.start), to = lineOf(dead.end);
    return { dead, from, to,
      calls: `${calls.slice(0, 6).join(', ')}${calls.length > 6 ? ` … +${calls.length - 6} more` : ''} ${calls.length > 1 ? 'sit' : 'sits'}`,
      what: dead.isFunction ? `function ${dead.name || '(anonymous)'}` : 'a block',
      where: from === to ? `line ${from}` : `lines ${from}–${to}`,
      starts: JSON.stringify(src.slice(dead.start, dead.start + 70).split('\n')[0]) };
  });
};
if (explain.length) {
  say(`Why: registration code exists in ${mainName} but did NOT run while loading`);
  for (const r of regionsOf(explain)) {
    problem(`${r.calls} inside ${r.what}, ${r.where}, which never ran. It starts: ${r.starts}`);
    if (reachesEnd(r.dead)) {
      say('    That function runs to the last line of the file. It was almost certainly meant to end much earlier: look for a missing');
      say(`    closing brace where ${r.dead.name || 'it'} should end (shortly after line ${r.from}), and for a stray "}" at the very end of the file.`);
    } else {
      say('    The host only evaluates the file body; nothing calls that function during load. Registration has to happen at the top');
      say('    level of the file (or in a function the top level calls). A file wrapped as `function setup(ctx) { … }` is the usual case.');
    }
  }
}
if (maybe.length) {
  say(`Not decided: registration code exists in ${mainName} but did not run in this dry run`);
  for (const r of regionsOf(maybe)) {
    undecided(`${r.calls} inside ${r.what}, ${r.where}, which did not run here. It starts: ${r.starts}`);
    say(r.dead.isFunction
      ? '    Something else in the file refers to that function, so it may be called under a condition, or later from an event.'
      : '    A condition above it was false here, or an early return came first.');
  }
  say('    This checker has no saved plugin data or settings and only stands in for host APIs, so that condition can differ in');
  say(`    the app. ${ASK_APP}`);
}
if (!kinds.length && !explain.length && !maybe.length && !loadError && run.timers) say(`  · ${run.timers} timer(s) were scheduled during load; anything registered from a timer or an event is not counted here.`);

say();
say(slugs.length ? 'Bundled Spaces (the host shows a Space only if every view it names is registered once the plugin has loaded)' : 'Bundled Spaces: none (no spaces/<slug>/space.json)');
let hidden = 0;
for (const sp of spaces) {
  const need = sp.missing.length ? `needs ${sp.missing.join(', ')}, which ${bundleOnly ? 'nothing registers' : `${mainName} did not register ${viewsVerdict === 'undecided' ? 'in this dry run' : 'while loading'}`}` : '';
  if (sp.reasons.length || (need && viewsVerdict !== 'undecided')) { hidden += 1; problem(`${sp.label} will be HIDDEN: ${[...sp.reasons, need].filter(Boolean).join('; ')}`); }
  else if (need) undecided(`${sp.label} may be hidden: ${need}`);
  else ok(`${sp.label}: every view it needs from this plugin is registered`);
  for (const n of sp.notes) say(`    ${n}`);
}

// ── 5. what it means ───────────────────────────────────────────────────────────────────────────────────────────────
if (hidden && !loadError && explain.length) {
  say();
  say(`What this means: the Space is missing because of a bug in this plugin's own ${mainName}, not because the app or its plugin`);
  say('API changed. The host loads the file the same way: it runs without an error, so the host shows no "failed to load"');
  say('badge, but nothing calls the code that registers the view, in this checker or in any app version, so the view does');
  say('not exist and the host quietly skips every Space that needs it. Fix the structure pointed out above, then run this');
  say('check again until the views are listed. No reinstall or app downgrade will help.');
} else if (hidden && !loadError && missingViews.size && viewsVerdict === 'problem') {
  say();
  say(`What this means: ${mainName} loads without an error but the view the Space needs is not registered, so the host quietly skips`);
  say('the Space. That is decided by this plugin\'s own files (view id, registration code), not by the app version.');
}
finish();
