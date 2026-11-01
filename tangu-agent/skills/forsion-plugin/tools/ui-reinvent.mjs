// Finds UI a desktop plugin draws itself although the host already has a part for it: dropdowns, menus, dialogs,
// tab bars, hand-placed overlays, hand-styled buttons, whole views in an iframe, <style> tags in document.head.
// Report only: a plugin may still draw its own UI, and plugins whose UI is a web page stay allowed.
// Used by `check-plugin.mjs --style` and by the engine's plugin_sandbox status, so the agent writing a plugin sees the
// same notes in both. Heuristic on purpose: only patterns with a named replacement, one line per kind. Lines marked
// `forsion-style: off` (CSS for an iframe page or an exported file) and comment lines are skipped.
import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;
const MAX_FILES = 200;
/** An element made in code or markup: createElement('x'), h('x'), jsx('x'), <x …>. */
const made = (tag) => new RegExp(`(?:createElement|\\bh|\\bel|\\bjsxs?|\\bjsxDEV)\\(\\s*['"\`]${tag}['"\`]|<${tag}[\\s>/]`, 'g');
const HOST_CLASSES = new Set(['ctx-menu', 'ctx-menu-scroll', 'ui-popover']);
const MENU = /(?:^|-)(?:menu|dropdown|popup)(?:$|-)/;
const TABS = /(?:^|-)(?:tabs?|tab-?bar|tablist)(?:$|-)/;

/** Class names a line defines or sets: a CSS rule line (`.a-menu .b {`) or a JS class string / classList.add(…). */
function classesOf(line) {
  const out = [];
  if (/^\s*[.#\w*:[][^{};]*\{/.test(line)) for (const m of line.split('{')[0].matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.push(m[1]);
  for (const m of line.matchAll(/\bclass(?:Name)?\s*[=:]\s*(['"`])([^'"`]*)\1/g)) out.push(...m[2].split(/\s+/));
  for (const m of line.matchAll(/classList\.(?:add|toggle)\(([^)]*)\)/g)) for (const s of m[1].matchAll(/['"`]([\w-]+)['"`]/g)) out.push(s[1]);
  return out.filter((c) => c && !HOST_CLASSES.has(c));
}

const RULES = [
  { kind: 'dropdown', what: 'hand-made dropdown', use: "ctx.ui.mountControl(el, { type: 'select', value, options, onChange })",
    test: (l) => count(l, made('select')) + count(l, /role\s*[=:]\s*['"`]listbox/g) },
  { kind: 'menu', what: 'hand-made menu', use: "ctx.ui.contextMenu({ anchor, align: 'end' }, entries) (rows, { separator: true }, { section })",
    test: (l) => count(l, /role\s*[=:]\s*['"`]menu(?:item)?['"`]/g) + (classesOf(l).some((c) => MENU.test(c)) ? 1 : 0) },
  { kind: 'dialog', what: 'hand-made dialog', use: 'ctx.ui.confirm({ title, danger }); to ask for text, ctx.ui.openDialog({ title, mount, actions }) with an input in mount (window.prompt does nothing in the desktop app)',
    test: (l, ctx) => count(l, made('dialog')) + count(l, /\.showModal\(/g) + count(l, /role\s*[=:]\s*['"`](?:alert)?dialog/g)
      + count(l, /\bwindow\.(?:confirm|alert|prompt)\(/g) + (ctx.hostDialogs ? 0 : count(l, /(?<![\w.$]|function\s+)(?:confirm|alert|prompt)\(/g)) },
  { kind: 'tabs', what: 'hand-made tab bar', use: "several views in one panel of space.json (native tabs), or ctx.ui.mountControl(el, { type: 'segmented' }) for 2-5 modes",
    test: (l) => count(l, /role\s*[=:]\s*['"`]tab(?:list)?['"`]/g) + count(l, /['"`]?data-tab['"`]?\s*[=:]/g) + (classesOf(l).some((c) => TABS.test(c)) ? 1 : 0) },
  { kind: 'overlay', what: 'position: fixed overlay', use: 'ctx.ui.popover(anchor, { mount }) or ctx.ui.contextMenu for anything anchored to an element (a full-window HUD may stay)',
    test: (l) => count(l, /position\s*[:=]\s*['"`]?fixed\b/g) },
  { kind: 'iframe', what: 'view drawn in an iframe', use: 'draw the view with host parts: theme, language and zoom do not reach an iframe (web-page plugins stay allowed)',
    test: (l) => count(l, made('iframe')) + count(l, made('webview')) },
  { kind: 'style', what: '<style> added to document.head', use: 'ctx.addStyle(css) (removed on disable / reload)',
    test: (l) => count(l, /document\.head\.(?:append|appendChild|prepend|insertBefore)\(/g) },
  { kind: 'button', what: 'hand-styled button (no host .btn class anywhere)', use: "the host's .btn / .btn.primary / .btn.ghost / .btn.sm classes, or actions in ctx.ui.setViewHead / mountControl / contextMenu",
    test: (l, ctx) => (ctx.hostButtons ? 0 : count(l, made('button')) + (/^\s*[^{};]*(?:^|[\s,>}])button(?:[:.[\s,>{]|$)[^{};]*\{/.test(l) ? 1 : 0)) },
];
function count(line, re) { re.lastIndex = 0; let n = 0; while (re.exec(line)) n++; return n; }

/** files: [[relativePath, text], …] → [{ kind, what, use, count, at: ['main.js:12', …] }], most frequent first. */
export function scanUi(files) {
  const all = files.map(([, t]) => t).join('\n');
  const ctx = {
    hostButtons: /(?:^|[\s'"`.])btn(?=$|[\s'"`.:{,])/m.test(all),
    hostDialogs: /\bui\.(?:confirm|openDialog)\b/.test(all),
  };
  const groups = new Map();
  for (const [file, text] of files) text.split('\n').forEach((raw, i) => {
    // ponytail: minified lines are skipped whole — mostly bundled libraries (React DOM, pdf.js) naming every tag; a plugin
    // shipped only minified goes unreported. Ceiling: needs a source map or an unminified build to see past it.
    if (raw.length > 2000 || /^\s*(\/\/|\/\*|\*\/|\*(?=\s|$)(?![^{]*\{))/.test(raw) || /forsion-style:\s*off/.test(raw)) return;
    const line = raw.replace(/\/\*.*?\*\//g, '');
    for (const r of RULES) {
      const n = r.test(line, ctx);
      if (!n) continue;
      const g = groups.get(r.kind) || { kind: r.kind, what: r.what, use: r.use, count: 0, at: [] };
      g.count += n;
      if (g.at.length < 20) g.at.push(`${file}:${i + 1}`);
      groups.set(r.kind, g);
    }
  });
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** The files check-plugin --style reads: the manifest's main file plus every .css file (no dot folders, no node_modules).
 *  Runs on every plugin_sandbox status, so it never follows a symlinked folder (a link back to the root would read the same
 *  files thousands of times) and stops at MAX_FILES / MAX_TOTAL. */
export function pluginUiFiles(dir) {
  let main = 'main.js';
  try { const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).main; if (typeof m === 'string' && m) main = m; } catch {}
  const out = [];
  let total = 0;
  const read = (rel) => {
    try {
      const p = join(dir, rel);
      const size = statSync(p).size;
      if (size > MAX_FILE || total + size > MAX_TOTAL || out.length >= MAX_FILES) return;
      total += size;
      out.push([rel, readFileSync(p, 'utf8')]);
    } catch {}
  };
  if (existsSync(join(dir, main))) read(main);
  const walk = (rel, depth) => {
    if (depth > 6) return;
    let names; try { names = readdirSync(join(dir, rel)).sort(); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const r = rel ? `${rel}/${n}` : n;
      let st; try { st = lstatSync(join(dir, r)); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(r, depth + 1);
      else if (n.endsWith('.css') && r !== main) read(r);
    }
  };
  walk('', 0);
  return out;
}

/** One line per kind: "- hand-made menu ×5 (main.js:40, main.js:88, main.js:97, …) → ctx.ui.contextMenu(…)". */
export function formatUiNotes(groups, max = 8) {
  return groups.slice(0, max).map((g) => `- ${g.what} ×${g.count} (${g.at.slice(0, 3).join(', ')}${g.at.length > 3 ? ', …' : ''}) → ${g.use}`);
}
