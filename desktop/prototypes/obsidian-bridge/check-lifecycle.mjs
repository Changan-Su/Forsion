// Reproductions for review findings: delayed writes across close, and edits during a pending read.
import { Window } from 'happy-dom';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const base = dirname(fileURLToPath(import.meta.url)), pkg = join(base, 'plugin');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const window = new Window({ settings: { enableJavaScriptEvaluation: true } });
window.structuredClone = structuredClone;
let view, saved = null, lease = false, writeCount = 0;
const gate = deferred(), reading = deferred();
const rejected = [];
const rejection = e => rejected.push(e);
process.on('unhandledRejection', rejection);
Object.defineProperty(window.navigator, 'locks', { value: {
  async request(_name, _options, callback) {
    if (lease) return callback(null);
    lease = true;
    try { await callback({}); } finally { lease = false; }
  },
} });
window.__ctx = {
  getLocale: () => 'en',
  registerView: v => view = v,
  registerCommand() {},
  packageFiles: {
    async readText(p) {
      const code = await readFile(join(pkg, p), 'utf8');
      return p === 'runtime.js' ? 'window.structuredClone = parent.structuredClone;\n' + code : code;
    },
    list: p => readdir(join(pkg, p)),
  },
  loadData: async () => saved,
  async saveData(snapshot) { if (++writeCount === 1) await gate.promise; saved = snapshot; },
  app: { vaultRoot: () => 'fixture', listPages: async () => ['Original.md'], readFile: () => reading.promise },
};
const roots = [];
async function mount() {
  const root = window.document.createElement('div'); roots.push(root); window.document.body.append(root);
  const dispose = await view.mount(root);
  if (root.querySelector('iframe')) {
    for (let i = 0; i < 200 && !root.querySelector('iframe')?.contentWindow?.bridge; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(root.querySelector('iframe')?.contentWindow?.bridge, 'Runtime starts after iframe load');
  }
  const child = root.querySelector('iframe')?.contentWindow;
  return { root, child, dispose, runtime: child?.bridge };
}
async function title(child, value) {
  const input = child.document.querySelector('input[aria-label="Title"]');
  input.value = value; input.dispatchEvent(new child.Event('input', { bubbles: true }));
  await tick();
}
let shutdown;
try {
  shutdown = window.eval('(function(ctx){' + await readFile(join(base, 'lab-main.js'), 'utf8') + '\n})(window.__ctx)');
  const first = await mount();
  first.child.document.querySelector('[data-plugin="obsidian-plugin-toc"] [data-action="settings"]').click(); await tick();
  await title(first.child, 'First title');
  await title(first.child, 'Newest accepted title');
  first.dispose();
  // Host view disposal immediately removes DOM. The write queue must survive in the parent realm.
  first.root.replaceChildren();
  assert.equal(lease, true);
  assert.equal(writeCount, 1);
  const blocked = await mount();
  assert.match(blocked.root.textContent, /already open/);
  gate.resolve();
  await first.runtime.flush();
  for (let i = 0; i < 10 && lease; i++) await tick();
  assert.equal(lease, false);
  assert.equal(writeCount, 2);
  const next = await mount();
  next.child.document.querySelector('[data-plugin="obsidian-plugin-toc"] [data-action="settings"]').click(); await tick();
  assert.equal(next.child.document.querySelector('input[aria-label="Title"]').value, 'Newest accepted title');
  next.child.document.querySelector('[data-action="close-settings"]').click(); await tick();
  const select = next.child.document.querySelector('select[aria-label="Read a vault note"]');
  select.value = 'Original.md'; select.dispatchEvent(new next.child.Event('change')); await tick();
  next.runtime.editor.setValue('Keep my new edits');
  reading.resolve('# Late file content'); await tick(); await tick();
  assert.equal(next.runtime.editor.getValue(), 'Keep my new edits');
  assert.match(next.child.document.querySelector('[role="status"]').textContent, /Draft changed/);
  next.runtime.editor.setCursor({ line: 0, ch: 4 });
  const iframe = next.root.querySelector('iframe');
  iframe.srcdoc = '<!doctype html><html><body></body></html>';
  for (let i = 0; i < 200 && (!iframe.contentWindow?.bridge || iframe.contentWindow.bridge === next.runtime); i++) await new Promise(r => setTimeout(r, 10));
  const restored = iframe.contentWindow.bridge;
  assert.notEqual(restored, next.runtime, 'A fresh iframe realm starts a new runtime');
  assert.equal(restored.editor.getValue(), 'Keep my new edits');
  assert.equal(restored.editor.getCursor().ch, 4);
  assert.equal(restored.diagnostics().plugins.filter(p => p.alive).length, 3);
  assert.equal(lease, true);
  next.dispose(); await tick(); await tick();
  assert.equal(rejected.length, 0, rejected.map(String).join('\n'));
  console.log('PASS lifecycle: accepted writes drain after close, lease outlives writes, remount loads latest settings, pending reads preserve edits, iframe reload restores draft/cursor/plugins');
} finally {
  gate.resolve(); reading.resolve(''); shutdown?.();
  await tick(); await window.happyDOM.close();
  process.off('unhandledRejection', rejection);
}
