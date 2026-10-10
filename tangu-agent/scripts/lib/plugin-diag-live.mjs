/** Opt-in live scenario: can the agent work out why an installed desktop plugin's Space does not show up?
 *
 *  A plugin whose main.js evaluates without throwing but never reaches `ctx.registerView` gives the host nothing to
 *  report: the Space is skipped with one renderer-console line and the engine has no tool that reads it. So this
 *  measures what the model can find from the plugin folder and a shell alone. The plugin under test is supplied by
 *  `--plugin-src` and copied into a fake home, because the engine child otherwise sees the developer's real `$HOME`.
 *
 *  The fake home is a convention, not a boundary: file reads need no approval and a shell command can still work out
 *  the real home. What this file does about it — the approval guard refuses the obvious routes, a run that touched the
 *  real home is reported as void, and the developer's own copy of the plugin is hashed before and after. */
import { mkdirSync, cpSync, symlinkSync, existsSync, readFileSync, readdirSync, writeFileSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';

const MARK = '@@plugindiag@@';

/** Evaluates main.js the way the desktop host does (`new Function('ctx', src)(ctx)`) and prints the registered view ids.
 *  The file may have been edited by the model under test, so it runs in a bare vm context: no `process`, no `require`,
 *  timers and console stubbed. A promise returned by the body is awaited, as the host does for an async setup. */
const STUB = `
const vm = require('vm');
const src = require('fs').readFileSync(process.argv[1], 'utf8');
const views = [];
const noop = () => {};
const app = new Proxy({}, { get: (_, k) => () => (k === 'watchFile' ? noop : Promise.resolve(null)) });
const ctx = new Proxy({ app }, { get(t, k) {
  if (k in t) return t[k];
  if (k === 'getLocale') return () => 'zh';
  if (k === 'saveData' || k === 'loadData') return () => Promise.resolve(null);
  if (typeof k !== 'string') return undefined;
  return (def) => { if (k === 'registerView') views.push(String(def && def.id)); return noop; };
} });
const sandbox = {
  __ctx: ctx,
  document: { createElement: () => new Proxy({}, { get: () => noop, set: () => true }), addEventListener: noop, removeEventListener: noop },
  console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
  setTimeout: () => 0, setInterval: () => 0, clearTimeout: noop, clearInterval: noop, requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  navigator: { userAgent: '' }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  addEventListener: noop, removeEventListener: noop,
};
sandbox.window = sandbox; sandbox.self = sandbox;
(async () => {
  let error = null;
  try {
    const ret = vm.runInNewContext('(function(ctx){\\n' + src + '\\n})(__ctx)', sandbox, { timeout: 5000 });
    if (ret && typeof ret.then === 'function') await Promise.race([Promise.resolve(ret), new Promise((r) => setTimeout(r, 3000))]);
  } catch (e) { error = String((e && e.message) || e); }
  await new Promise((r) => setTimeout(r, 30));
  process.stdout.write('${MARK}' + JSON.stringify({ views, error }));
  process.exit(0);
})();
`;

export function registeredViews(mainFile) {
  const home = dirname(mainFile);
  const r = spawnSync(process.execPath, ['-e', STUB, mainFile], { encoding: 'utf8', timeout: 20_000, cwd: home, env: { ...process.env, HOME: home } });
  const at = String(r.stdout || '').lastIndexOf(MARK);
  try { return JSON.parse(r.stdout.slice(at + MARK.length)); } catch { return { views: [], error: `stub: ${(r.stderr || r.error?.message || 'no output').slice(0, 300)}` }; }
}

/** Cases for the harness `--selftest`: [name, main.js body, expected view ids, expect an error]. */
export const STUB_SELFTEST = [
  ['顶层同步注册', "ctx.registerView({ id: 'a' })", 'a', false],
  ['注册被没人调用的函数包住(负对照)', "function render() { ctx.registerView({ id: 'a' }) }", '', false],
  ['异步 setup 里注册', "return (async () => { await ctx.loadData(); ctx.registerView({ id: 'b' }) })()", 'b', false],
  ['先打日志再注册', "console.log('hi'); ctx.registerView({ id: 'c' })", 'c', false],
  ['求值抛错', "ctx.registerView({ id: 'd' }); throw new Error('boom')", 'd', true],
  ['拿不到 process', "ctx.registerView({ id: typeof process })", 'undefined', false],
];

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

/** Content hash of every regular file under `dir` (symlinks and node_modules are not followed); null when it does not exist. */
function treeHash(dir) {
  if (!existsSync(dir)) return null;
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name === 'node_modules') continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) { h.update(p); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

/** Copies the plugin (and optionally its plugins-data blob) under `<shared>/plugins` and points `<fakeHome>/.forsion` at `shared`.
 *  Symlinks are resolved while copying: a link kept as a link would still point at the developer's original files. */
export function plantPlugin({ src, data, shared, fakeHome }) {
  if (!src || !existsSync(join(src, 'manifest.json'))) throw new Error('plugindiag: --plugin-src <desktop plugin folder> is required (it must contain manifest.json)');
  mkdirSync(fakeHome, { recursive: true });
  symlinkSync(shared, join(fakeHome, '.forsion'));
  const dir = join(shared, 'plugins', basename(src));
  cpSync(src, dir, { recursive: true, dereference: true });
  if (data) { mkdirSync(join(shared, 'plugins-data'), { recursive: true }); cpSync(data, join(shared, 'plugins-data', basename(data)), { dereference: true }); }
  return dir;
}

/** View ids the bundled Spaces need from this plugin (`plugin:<manifest id>:<view>` in any space.json). */
function neededViews(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const prefix = `plugin:${manifest.id}:`;
  const out = new Set();
  const spaces = join(dir, 'spaces');
  for (const slug of existsSync(spaces) ? readdirSync(spaces) : []) {
    const file = join(spaces, slug, 'space.json');
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/"(plugin:[^"]+)"/g)) if (m[1].startsWith(prefix)) out.add(m[1].slice(prefix.length));
  }
  return { manifest, views: [...out] };
}

export async function pluginDiagLive({ run, dir, OUT, hint, tokensOf, ttft }) {
  const { manifest, views: needed } = neededViews(dir);
  const mainFile = join(dir, manifest.main || 'main.js');
  const before = { sha: sha(mainFile), ...registeredViews(mainFile) };
  // 本场景量的是「求值不抛错、但没注册」那一类;抛错的插件宿主自己会报「加载失败」,是另一回事。
  if (before.error) return { ok: false, detail: `夹具不成立:这份插件照宿主的方式求值就抛错(${before.error}),不是「不报错、零注册」那一类` };
  if (needed.every((v) => before.views.includes(v))) return { ok: false, detail: `夹具不成立:这份插件在顶层已经注册了 Space 需要的视图(${needed.join(', ')}),没有可排查的问题` };

  // 照用户的原话问:把原因归到应用升级上,不给路径,不提视图注册 / 括号 / 自检脚本。
  const ask = `我把 Forsion 升到 2.13.1 之后,${manifest.name} 这个插件的 Space 在功能条上不见了,插件明明还装着、也是开着的。是不是插件系统更新了导致不兼容?帮我排查一下原因。`;
  // 点名腿:分清「不会查」和「没想到要查」。路径给隔离目录的绝对路径 —— 写成 ~/.forsion/… 时模型会去列 /Users 拼出开发机的真家目录(10-10 实测)。
  const hinted = `${ask}插件装在 ${dir} 。请在本地实际验证一下它的 main.js 被宿主加载后注册了哪些视图。`;
  const message = hint ? hinted : ask;

  // 开发机的真家目录不许碰。模型拿到的 HOME 是假的,这里兜的是它自己拼出真路径的几条明路(字面路径、/Users、os.userInfo);也不许往机器上装东西。
  // 挡不全(读文件不过审批;shell 里总有别的办法拿到真路径),所以下面还有两道:读过真家目录的这次作废;开发机上同名插件目录前后比对。
  const realHome = homedir();
  const outside = (text) => { const t = String(text || '').split(OUT).join(''); return t.includes(realHome) || /\/Users\/|\buserInfo\b/.test(t); };
  const realCopy = join(realHome, '.forsion', 'plugins', basename(dir));
  const realBefore = treeHash(realCopy);
  const rejected = [];
  const onApproval = (p) => {
    const args = String(p.arguments || '');
    if (outside(args) || /\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b/.test(args)) { rejected.push(`${p.name}: ${args.split(OUT).join('').slice(0, 160)}`); return 'reject'; }
    return undefined;
  };
  const t0 = Date.now();
  const ev = await run(`live-plugindiag-${Date.now()}`, message, 900_000, { approvalMode: 'auto-edit', debugSystemPrompt: true }, undefined, onApproval);
  const wallMs = Date.now() - t0;

  const after = { sha: sha(mainFile), ...registeredViews(mainFile) };
  const realTouched = treeHash(realCopy) !== realBefore;
  // 模型的工具调用里出现了真家目录 = 它查的不是隔离目录里那份,这次不算数。
  const escaped = ev.toolArgs.filter((a) => outside(a.arguments)).map((a) => `${a.name}: ${a.arguments.split(OUT).join('').slice(0, 120)}`);
  const c = ev.content || '';
  // 「不可用」那句回执不算错误(isError=false),所以按长度认:取回了正文才算装载(10-10 实测:模型传了技能名而不是 id,拿到一句 71 字的「not available」)。
  const skill = ev.toolResults.some((r) => r.name === 'use_skill' && !r.isError && r.fullLength > 1000);
  const ranNode = ev.toolArgs.some((a) => a.name === 'run_bash' && /\bnode\b/.test(a.arguments));
  // 粗判:回答里同时说到「视图没注册」和「被包进 / 没收口的函数」。只当索引用,结论以原话为准。
  // 「有没有把原因算到应用升级头上」不自动判:试过按关键词判,六次里两次判反(否定句、让步句),读原话。
  const named = /registerView|视图.{0,12}(没有|没|未|不会|从未).{0,6}注册|(没有|没|未|从未).{0,6}注册.{0,12}视图/.test(c)
    && /花括号|大括号|括号|brace|闭合|收口|嵌套|nested|unclosed|unbalanced|吞|包进|包在|函数体/i.test(c);
  const fixed = needed.every((v) => after.views.includes(v)) && !after.error;

  writeFileSync(join(OUT, 'plugindiag-evidence.json'), JSON.stringify({
    leg: hint ? 'hinted' : 'plain', message, plugin: { id: manifest.id, version: manifest.version, dir: basename(dir) }, needed, before, after,
    named, fixed, skillLoaded: skill, ranNode, wallMs, done: ev.done, error: ev.error, approvals: ev.approvalList, rejected, escaped, realTouched,
    skillCatalogLines: String(ev.systemPrompt || '').split('\n').filter((l) => /forsion-plugin/.test(l)).map((l) => l.slice(0, 400)),
    // 两张表各按到达顺序排;并行调用时下标不一定对得上,所以不配对。
    toolCalls: ev.toolArgs.map((a) => ({ name: a.name, arguments: a.arguments })),
    toolResults: ev.toolResults.map((r) => ({ name: r.name, isError: r.isError, length: r.fullLength, head: String(r.full || '').slice(0, 2000) })),
    content: c,
  }, null, 1));

  if (realTouched) return { ok: false, detail: `⚠️ 开发机上的 ${realCopy} 在这次运行期间变了。台架不自动还原:先核对是不是别的进程改的,再从备份或重装恢复`, output: c, toolCalls: ev.toolCalls };
  if (escaped.length) return { ok: false, detail: `作废:模型查的是开发机真实家目录里的东西,不是隔离目录里那份(${escaped.length} 次,首条 ${escaped[0]});这次不计数`, output: c, toolCalls: ev.toolCalls };
  return {
    ok: !ev.error && ev.done && named,
    detail: ev.error || [
      `${hint ? '点名腿' : '原话腿'}`,
      `说中原因(粗判)${named ? '是' : '否'}`,
      `main.js ${after.sha === before.sha ? '没改' : '改了'}`, `改后视图注册 ${fixed ? '齐了' : `缺(${after.error || after.views.join(',') || '0 个'})`}`,
      `装载手册 ${skill ? '是' : '否'}`, `跑过 node ${ranNode ? '是' : '否'}`, `审批 ${ev.approvals} 张(拒 ${rejected.length})`,
      `工具 ${ev.toolCalls.length} 次:${[...new Set(ev.toolCalls)].join(',') || '无'}`, `${Math.round(wallMs / 1000)}s`,
    ].join(';'),
    output: c, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls,
  };
}
