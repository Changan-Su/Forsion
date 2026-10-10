/** Opt-in live scenario: can the agent work out why an installed desktop plugin's Space does not show up?
 *
 *  A plugin whose main.js evaluates without throwing but never reaches `ctx.registerView` gives the host nothing to
 *  report: the Space is skipped with one renderer-console line and the engine has no tool that reads it. So this
 *  measures what the model can find from the plugin folder and a shell alone. The plugin under test is supplied by
 *  `--plugin-src` and copied into a fake home, because the engine child otherwise sees the developer's real `$HOME`. */
import { mkdirSync, cpSync, symlinkSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

/** Evaluates main.js the way the desktop host does and prints the view ids registered at the top level. */
const STUB = `
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
globalThis.document = { createElement: () => new Proxy({}, { get: () => noop, set: () => true }) };
globalThis.window = globalThis;
let error = null;
try { new Function('ctx', src)(ctx); } catch (e) { error = String(e && e.message || e); }
process.stdout.write(JSON.stringify({ views, error }));
process.exit(0);
`;

export function registeredViews(mainFile) {
  const r = spawnSync(process.execPath, ['-e', STUB, mainFile], { encoding: 'utf8', timeout: 15_000 });
  try { return JSON.parse(r.stdout); } catch { return { views: [], error: `stub: ${(r.stderr || r.error?.message || 'no output').slice(0, 300)}` }; }
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

/** Copies the plugin (and optionally its plugins-data blob) under `<shared>/plugins` and points `<fakeHome>/.forsion` at `shared`. */
export function plantPlugin({ src, data, shared, fakeHome }) {
  if (!src || !existsSync(join(src, 'manifest.json'))) throw new Error('plugindiag: --plugin-src <desktop plugin folder> is required (it must contain manifest.json)');
  mkdirSync(fakeHome, { recursive: true });
  symlinkSync(shared, join(fakeHome, '.forsion'));
  const dir = join(shared, 'plugins', basename(src));
  cpSync(src, dir, { recursive: true });
  if (data) { mkdirSync(join(shared, 'plugins-data'), { recursive: true }); cpSync(data, join(shared, 'plugins-data', basename(data))); }
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
  if (needed.every((v) => before.views.includes(v))) return { ok: false, detail: `夹具不成立:这份插件在顶层已经注册了 Space 需要的视图(${needed.join(', ')}),没有可排查的问题` };

  // 照用户的原话问:把原因归到应用升级上,不给路径,不提视图注册 / 括号 / 自检脚本。
  const ask = `我把 Forsion 升到 2.13.1 之后,${manifest.name} 这个插件的 Space 在功能条上不见了,插件明明还装着、也是开着的。是不是插件系统更新了导致不兼容?帮我排查一下原因。`;
  // 点名腿:分清「不会查」和「没想到要查」。路径给隔离目录的绝对路径 —— 写成 ~/.forsion/… 时模型会去列 /Users 拼出开发机的真家目录(10-10 实测)。
  const hinted = `${ask}插件装在 ${dir} 。请在本地实际验证一下它的 main.js 被宿主加载后注册了哪些视图。`;
  const message = hint ? hinted : ask;

  // 开发机的真家目录不许碰(模型拿到的 HOME 是假的,这里兜的是它自己拼出绝对路径的情况);也不许往机器上装东西。
  const realHome = homedir();
  const rejected = [];
  const onApproval = (p) => {
    const args = String(p.arguments || '').split(OUT).join('');
    if (args.includes(realHome) || /\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b/.test(args)) { rejected.push(`${p.name}: ${args.slice(0, 160)}`); return 'reject'; }
    return undefined;
  };
  const t0 = Date.now();
  const ev = await run(`live-plugindiag-${Date.now()}`, message, 900_000, { approvalMode: 'auto-edit', debugSystemPrompt: true }, undefined, onApproval);
  const wallMs = Date.now() - t0;

  const after = { sha: sha(mainFile), ...registeredViews(mainFile) };
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
    named, fixed, skillLoaded: skill, ranNode, wallMs, done: ev.done, error: ev.error, approvals: ev.approvalList, rejected,
    skillCatalogLines: String(ev.systemPrompt || '').split('\n').filter((l) => /forsion-plugin/.test(l)).map((l) => l.slice(0, 400)),
    // 两张表各按到达顺序排;并行调用时下标不一定对得上,所以不配对。
    toolCalls: ev.toolArgs.map((a) => ({ name: a.name, arguments: a.arguments })),
    toolResults: ev.toolResults.map((r) => ({ name: r.name, isError: r.isError, length: r.fullLength, head: String(r.full || '').slice(0, 2000) })),
    content: c,
  }, null, 1));

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
