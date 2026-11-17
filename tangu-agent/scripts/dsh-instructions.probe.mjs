#!/usr/bin/env node
/**
 * 交接指令的真模型探针:不经 Forsion 引擎,直接对 DSH(ACP)发同一问 N 次,数模型照不照指令目录里的话做。
 * 用来把「是交过去的东西变了,还是模型变了」拆开:固定一份指令目录(DSH_AGENTS_HOME,可从 dsh-engine.check.mjs
 * 跑完留下的 <root>/forsion/tangu/engines/dsh/agents/<会话>/ 整份拷出来),一次只改一处(截短 AGENTS.md / 换问法 / 换模型)。
 * 2026-11-16 用它查清交接署名掉线:同一份 AGENTS.md,问句带「Reply with just …」5/8 带署名、不带 8/8。
 *
 * 用法:
 *   node scripts/dsh-instructions.probe.mjs --dsh <@deepseek-ai/dsh 的 lib/bin.js> --dsh-home <已登录的隔离 DSH 目录>
 *     --root <工作目录> --agents-home <指令目录> --prompt <文本> [--model <模型 id 或名字片段>] [--n 5] [--effort high] [--dump-options]
 * 跑时在 <dsh-home>/profiles/acp/cordis.patch.yml 关掉 DSH 自带的跑命令 / 读写文件 / 搜文件 / 后台任务,跑完(含 Ctrl-C)原样还原;
 * 补丁层里已有 disabled 就不跑(多半是 dsh-engine.check.mjs 正开着同一份目录)。工作目录里立 .git 标记,别的仓的说明不混进来。
 * 只用隔离的 DSH 目录,别指到 ~/.dsh。跑完核一下 `ps -axo pid,command | grep '[d]sh/lib/bin.js'`。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BIN = opt('dsh'), DSH_HOME = resolve(opt('dsh-home')), ROOT = resolve(opt('root')), AH = resolve(opt('agents-home'));
const MODEL = opt('model', ''), PROMPT = opt('prompt'), N = Number(opt('n', '1')), EFFORT = opt('effort', '');
const NODE = process.execPath;
const D = (p) => { const x = join(ROOT, p); mkdirSync(x, { recursive: true }); return x; };
const env = { PATH: `${dirname(NODE)}:/usr/bin:/bin`, HOME: D('home'), DSH_HOME, TMPDIR: D('tmp'), XDG_CACHE_HOME: D('xc'), XDG_DATA_HOME: D('xd'), XDG_STATE_HOME: D('xs'), DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: AH };
const WS = D('ws');
mkdirSync(join(WS, '.git'), { recursive: true }); // DSH 以 .git 定项目根:不立的话 --root 所在仓的 AGENTS.md / CLAUDE.md 一并进请求
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const patchFile = join(DSH_HOME, 'profiles', 'acp', 'cordis.patch.yml');
const backup = readFileSync(patchFile, 'utf8');
if (/disabled:\s*true/.test(backup)) { console.error(`补丁层里已经有 disabled: true(别的台架在跑?),不跑:${patchFile}`); process.exit(2); }
writeFileSync(patchFile, ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search'].map((id) => `- id: ${id}\n  disabled: true\n`).join(''));
const restore = () => writeFileSync(patchFile, backup);
process.on('exit', restore);
let child = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { try { child?.kill('SIGKILL'); } catch {} restore(); process.exit(130); });

function dsh() {
  const c = spawn(NODE, [BIN, '--profile', 'acp'], { env, cwd: WS, stdio: ['pipe', 'pipe', 'pipe'] });
  child = c;
  let buf = '', id = 0; const waiters = new Map(); const updates = [];
  c.stderr.on('data', () => {});
  c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && !m.method && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); continue; }
    if (m.method === 'session/update') updates.push({ sid: m.params?.sessionId, ...m.params?.update });
    if (m.method === 'session/request_permission' && m.id != null) { // 一律拒
      const o = (m.params?.options || []).find((x) => /reject/.test(x.kind)) || (m.params?.options || [])[0];
      c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' } } })}\n`);
    } else if (m.method && m.id != null) c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } })}\n`);
  } });
  const call = (method, params, ms = 180_000) => new Promise((res) => { const my = ++id; const t = setTimeout(() => { waiters.delete(my); res({ timeout: method }); }, ms);
    waiters.set(my, (m) => { clearTimeout(t); res(m); }); c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`); });
  const kill = async () => { c.kill('SIGTERM'); for (let i = 0; i < 30 && c.exitCode === null && c.signalCode === null; i++) await sleep(100); if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); await sleep(150); };
  return { call, kill, updates };
}

const d = dsh();
try {
  await d.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  for (let k = 0; k < N; k++) {
    const s = await d.call('session/new', { cwd: WS, mcpServers: [] });
    const sid = s.result?.sessionId; if (!sid) { console.log('session/new failed', JSON.stringify(s).slice(0, 400)); break; }
    const opts = s.result?.configOptions || [];
    if (argv.includes('--dump-options') && k === 0) console.log(JSON.stringify(opts, null, 1).slice(0, 3000));
    if (MODEL) {
      const mo = opts.find((o) => o.category === 'model' || o.id === 'model');
      const flat = (mo?.options || []).flatMap((o) => o.options || [o]);
      const pick = flat.find((o) => JSON.stringify(o.value).includes(MODEL) || String(o.name).includes(MODEL));
      if (!pick) { console.log('no model', MODEL, JSON.stringify(flat.map((o) => o.value))); break; }
      const r = await d.call('session/set_config_option', { sessionId: sid, configId: mo.id, value: pick.value });
      if (r.error) { console.log('set model failed', JSON.stringify(r.error)); break; }
      if (k === 0) console.log(`model: ${pick.name} ${JSON.stringify(pick.value)}`);
    }
    if (EFFORT) { const r = await d.call('session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: EFFORT }); if (r.error) console.log('set effort failed', JSON.stringify(r.error)); }
    const from = d.updates.length;
    const r = await d.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: PROMPT }] });
    // 只算这一场的更新;超时的那一问还在跑,后面的样本会混进它的输出,所以超时就停
    const ups = d.updates.slice(from).filter((u) => u.sid === sid);
    const text = ups.filter((u) => u?.sessionUpdate === 'agent_message_chunk').map((u) => u.content?.text || '').join('');
    const tools = ups.filter((u) => u?.sessionUpdate === 'tool_call').map((u) => u.title || u.kind);
    console.log(`#${k + 1} stop=${r.result?.stopReason || JSON.stringify(r.error || r.timeout)} tools=[${tools.join(',')}] reply=${JSON.stringify(text.trim())}`);
    if (r.timeout) { console.log('这一问超时,停下(后面的样本会混进它的输出)'); break; }
  }
} finally { await d.kill(); restore(); }
