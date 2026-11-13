#!/usr/bin/env node
/**
 * DSH 引擎实测:真 standalone 引擎 × 真 DSH(官方包,`dsh --profile acp`)× 本机假模型。
 * 不带真 key、不连外网、不碰真实的 ~/.dsh 与 ~/.tangu —— HOME / DSH_HOME / TANGU_HOME / XDG_* / TMPDIR 全指到 --root 下面。
 * 证的是「接线」:引擎把哪个 DSH 会话续上了、交给模型的请求里有没有上一句、审批卡上写的是什么。模型配不配合要另用真模型验。
 *
 * 用法:
 *   npm run build
 *   node scripts/dsh-engine.check.mjs --node <Node ≥ 24 的可执行文件> --dsh <@deepseek-ai/dsh 的 lib/bin.js> --root <全新目录>
 *     [--only twoturn,model,…]   只跑某几项(见下面 SCENARIOS 的 key)
 *     [--engine-entry <别处的 dist/standalone/main.js>]   负对照:拿没有这次改动的旧构建跑同一套,twoturn 应当红
 *
 * 准备 DSH(只装官方包,不装任何社区插件;和你自己的 DSH 无关):
 *   mkdir rt && cd rt && npm init -y && npm install --ignore-scripts @deepseek-ai/dsh
 *   → --dsh rt/node_modules/@deepseek-ai/dsh/lib/bin.js
 *
 * --root 不能在系统临时目录下面:DSH 的沙箱本来就允许往临时目录写,审批那一项会测不出来(2026-11-13 踩过)。
 * 跑完会核对有没有留下 DSH 进程。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = opt('node', ''), BIN = opt('dsh', ''), ROOT_ARG = opt('root', '');
const ENTRY = resolve(opt('engine-entry', join(root, 'dist', 'standalone', 'main.js')));
const ONLY = new Set((opt('only', '') || '').split(',').filter(Boolean));
if (!NODE || !BIN || !ROOT_ARG) { console.error('用法见文件头:--node <node24> --dsh <dsh 的 lib/bin.js> --root <全新目录>'); process.exit(2); }
for (const [what, p] of [['--node', NODE], ['--dsh', BIN], ['引擎入口(先 npm run build)', ENTRY]]) if (!existsSync(p)) { console.error(`找不到 ${what}:${p}`); process.exit(2); }
mkdirSync(ROOT_ARG, { recursive: true });
const R = realpathSync(ROOT_ARG);
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
for (const t of [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']) {
  if (R === real(t) || R.startsWith(real(t) + sep)) { console.error(`--root 在系统临时目录下面(${t}),审批那一项会测不出来,换个地方`); process.exit(2); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 300) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };
const D = (name) => { const p = join(R, name); mkdirSync(p, { recursive: true }); return p; };
const HOME = D('home'), DSH_HOME = D('dsh'), WS = D('ws'), OUTSIDE = D('outside'), TMP = D('tmp');
const TANGU_HOME = D(join('forsion', 'tangu'));
const LOG = join(R, 'engine.log');
const clean = (s) => String(s).split(R).join('<root>').replace(/\/Users\/[^/\s"'\\]+/g, '/Users/<user>');

// ── 本机假模型(Anthropic Messages 格式,DSH 0.2.2 调的是 POST {DEEPSEEK_BASE_URL}/v1/messages)。只听 127.0.0.1。
//    剧本的每一步对应一次带工具的模型请求:{ text } | { tool, args } | { hang: true }(一直不回,等这一轮被停掉)。剧本用完回「ok」。
const stub = await (async () => {
  const requests = []; let queue = []; const hanging = new Set();
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const path = (req.url || '').split('?')[0];
      if (req.method === 'POST' && /\/messages\/count_tokens$/.test(path)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 10 })); }
      if (!(req.method === 'POST' && /\/messages$/.test(path))) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `stub: no such route ${path}` } })); }
      const withTools = Array.isArray(body?.tools) && body.tools.length > 0;
      const step = withTools ? (queue.shift() || {}) : { text: 'check session' }; // 不带工具的是起标题之类的旁路请求,不占剧本
      if (withTools) requests.push(body);
      if (step.hang) { hanging.add(res); req.on('close', () => hanging.delete(res)); return; }
      const blocks = [];
      if (step.text || !step.tool) blocks.push({ type: 'text', text: step.text ?? 'ok' });
      if (step.tool) blocks.push({ type: 'tool_use', id: `toolu_${randomUUID().slice(0, 8)}`, name: step.tool, input: step.args || {} });
      const stop = step.tool ? 'tool_use' : 'end_turn';
      const msg = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body?.model || 'stub', stop_reason: null, stop_sequence: null };
      if (!body?.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...msg, content: blocks, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { ...msg, content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
      blocks.forEach((b, index) => {
        if (b.type === 'text') { ev('content_block_start', { index, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }); }
        else { ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }); ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }); }
        ev('content_block_stop', { index });
      });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
      ev('message_stop', {}); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests,
    script: (steps) => { queue = [...steps]; }, mark: () => requests.length,
    since: (n) => requests.slice(n),
    close: async () => { for (const r of hanging) r.destroy(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
})();

// ── DSH 子进程的环境:全部另指,假 key 只会发给上面那个假模型
const dshEnv = (extra = {}) => ({
  PATH: `${dirname(NODE)}:/usr/bin:/bin`, HOME, DSH_HOME, TMPDIR: TMP,
  XDG_CACHE_HOME: D('xc'), XDG_DATA_HOME: D('xd'), XDG_STATE_HOME: D('xs'),
  DEEPSEEK_BASE_URL: stub.url, DEEPSEEK_API_KEY: 'stub-not-a-real-key', DSH_TELEMETRY_DISABLED: '1', ...extra,
});
// 引擎清单:按 id 覆盖内置的 dsh(内置那条跑的是 PATH 上的 `dsh`,这里指到 --dsh 给的那份);dsh-ro = 只读模式,给审批那一项用
writeFileSync(join(TANGU_HOME, 'engines.json'), JSON.stringify({ engines: [
  { id: 'dsh', name: 'DeepSeek Harness', command: NODE, args: [BIN, '--profile', 'acp'], env: dshEnv() },
  { id: 'dsh-ro', name: 'DeepSeek Harness (read-only)', command: NODE, args: [BIN, '--profile', 'acp'], env: dshEnv({ DSH_PERMISSION_MODE: 'read-only' }) },
] }, null, 2));

// ── 直接和 DSH 说 ACP(只用来看它那边的会话清单、扮「另一个开着这场会话的进程」)
function rawDsh() {
  const c = spawn(NODE, [BIN, '--profile', 'acp'], { env: dshEnv(), cwd: WS, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0; const waiters = new Map();
  c.stderr.on('data', () => {});
  c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && !m.method && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
  const call = (method, params, ms = 40_000) => new Promise((res) => { const my = ++id; const t = setTimeout(() => { waiters.delete(my); res({ timeout: method }); }, ms);
    waiters.set(my, (m) => { clearTimeout(t); res(m); }); c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`); });
  const kill = async () => { c.kill('SIGTERM'); for (let i = 0; i < 20 && c.exitCode === null && c.signalCode === null; i++) await sleep(100); if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); await sleep(150); };
  return { call, kill, init: () => call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }) };
}
const dshSessions = async () => { const d = rawDsh(); try { await d.init(); return (await d.call('session/list', {})).result?.sessions || []; } finally { await d.kill(); } };

// ── 真 standalone 引擎
const TOKEN = randomUUID();
let engine = null, base = '';
async function startEngine() {
  const port = await new Promise((r) => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
  base = `http://127.0.0.1:${port}`;
  engine = spawn(process.execPath, [ENTRY, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(TANGU_HOME, 'state.db'), '--sandbox', 'auto', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN], {
    cwd: WS,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME, TMPDIR: TMP, TANGU_HOME, TANGU_DEFAULT_WORKSPACE: WS, TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0',
      FORSION_DESKTOP_CONFIG: join(R, 'userData', 'tangu-desktop-config.json'), LANG: 'en_US.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine.stdout.on('data', (d) => appendFileSync(LOG, d)); engine.stderr.on('data', (d) => appendFileSync(LOG, d));
  let exited = false; engine.once('exit', () => { exited = true; });
  const ok = await until(() => (exited ? Promise.resolve(null) : fetch(`${base}/health`).then((r) => (r.ok ? true : null)).catch(() => null)), 40_000, 400);
  if (!ok) throw new Error(`引擎没起来,见 ${LOG}`);
}
async function stopEngine() {
  if (!engine) return; const e = engine; engine = null;
  e.kill('SIGTERM'); await until(() => e.exitCode !== null || e.signalCode !== null, 8000, 200); if (e.exitCode === null && e.signalCode === null) e.kill('SIGKILL');
}
const api = async (path, init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} → ${r.status} ${(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300)}`);
  return body;
};
const newSession = async (title) => (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title }) })).session.id;
const messages = async (sid) => { const r = await api(`/agent/sessions/${sid}/messages`); return Array.isArray(r) ? r : r.messages || []; };
/** 起一轮并读事件到结束。cfg 并进 agent_config;onApproval(p) 回 'approve' | 'reject';stopOn(ev) 为真时按停止键。 */
async function run(sid, message, cfg = {}, { onApproval, stopOn, timeoutMs = 120_000 } = {}) {
  const { runId } = await api('/agent/runs', { method: 'POST', body: JSON.stringify({ session_id: sid, model_id: 'engine/dsh', message, agent_config: { engineId: 'dsh', execMode: 'host', cwd: WS, preset: null, ...cfg } }) });
  const ev = { runId, text: '', tools: [], results: [], approvals: [], done: false, error: null, aborted: false };
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  let stopped = false; const maybeStop = async () => { if (!stopped && stopOn?.(ev)) { stopped = true; await api(`/agent/runs/${runId}/abort`, { method: 'POST' }).catch(() => {}); } };
  const poll = stopOn ? setInterval(() => { void maybeStop(); }, 200) : null;
  try {
    const res = await fetch(`${base}/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
    let buf = '';
    outer: for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8'); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let e; try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
          const p = e.payload || {};
          if (e.type === 'token') ev.text += p.delta || '';
          else if (e.type === 'tool_call') ev.tools.push({ name: p.name, arguments: p.arguments });
          else if (e.type === 'tool_result') ev.results.push({ name: p.name, isError: !!p.isError, result: String(p.result || '') });
          else if (e.type === 'approval_request') {
            const action = (await onApproval?.(p)) || 'reject';
            ev.approvals.push({ name: p.name, arguments: p.arguments, preview: p.preview, action });
            await api(`/agent/runs/${runId}/approvals/${p.approvalId}`, { method: 'POST', body: JSON.stringify({ action }) });
          } else if (e.type === 'done') { ev.done = true; break outer; }
          else if (e.type === 'error') { ev.error = String(p.error || 'error'); ev.aborted = !!p.aborted; break outer; }
        }
      }
    }
  } catch (e) { ev.error = ev.error || `events: ${e.message}`; } finally { clearTimeout(timer); if (poll) clearInterval(poll); ac.abort(); }
  // done 事件之后引擎才把这一轮标成结束:等它标完再发下一句。**不多等** —— 下一句紧跟着上一句发,是要测的时序之一
  // (上一轮的 DSH 进程刚被杀、可能还没退干净)。
  await until(async () => !((await api(`/agent/runs?session_id=${sid}`)).runs || []).some((x) => ['queued', 'running'].includes(x.status)), 8000, 100);
  return ev;
}
/** 直接读隔离的 state.db(只读):某场会话各轮 run 记下的引擎会话指针。 */
const pointers = async (sid) => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(join(TANGU_HOME, 'state.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT id, status, result FROM agent_runs WHERE session_id = ? ORDER BY created_at, updated_at').all(sid).map((r) => { let x = {}; try { x = JSON.parse(r.result || '{}') || {}; } catch { /* */ } return { runId: r.id, status: r.status, ext: x.externalSession?.id || x.externalSessionId || null, reset: !!x.externalSessionReset }; }); }
  finally { db.close(); }
};
const has = (body, needle) => JSON.stringify(body?.messages || []).includes(needle);

const results = [];
const record = (key, title, checks, note = '') => {
  const ok = checks.every((c) => c[1]);
  results.push({ key, title, ok, checks, note });
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${key} — ${title}`);
  for (const [name, pass, detail] of checks) console.log(`   ${pass ? '✓' : '✗'} ${name}${detail ? `:${clean(detail)}` : ''}`);
  if (note) console.log(`   · ${clean(note)}`);
};

const SCENARIOS = {
  // 模型下拉:能力探测读出 DSH 的模型和思考档
  caps: async () => {
    const caps = await api('/agent/engines/dsh/capabilities');
    const models = caps.models || [];
    record('caps', '模型和思考档读得出来', [
      ['模型清单不为空', models.length > 0, models.map((m) => m.name).join(' / ')],
      ['当前模型在清单里', models.some((m) => m.id === caps.currentModelId), String(caps.currentModelId)],
      ['思考档读出来了', (caps.thoughtLevels || []).length > 0, `${(caps.thoughtLevels || []).map((l) => l.id).join(' / ')},当前 ${caps.currentThoughtLevel}`],
    ]);
    return caps;
  },
  // 第二句记得第一句:两轮各是一个新的 DSH 进程(一轮一进程,跑完就杀)
  twoturn: async () => {
    const sid = await newSession('twoturn');
    stub.script([{ text: 'Noted: the code word is ZEBRA-42.' }]);
    const a = await run(sid, 'Remember the code word ZEBRA-42.');
    const n = stub.mark(); stub.script([{ text: 'The code word is ZEBRA-42.' }]);
    const b = await run(sid, 'What is the code word?');
    const req = stub.since(n)[0]; const ps = await pointers(sid);
    record('twoturn', '第二句记得第一句', [
      ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
      ['第二轮交给模型的请求里有第一句的原话', has(req, 'Remember the code word ZEBRA-42.')],
      ['……也有第一句的回答', has(req, 'Noted: the code word is ZEBRA-42.')],
      ['两轮用的是同一个 DSH 会话', ps.length === 2 && !!ps[0].ext && ps[0].ext === ps[1].ext, ps.map((p) => p.ext?.slice(0, 8)).join(' → ')],
    ], `第二轮的请求共 ${req?.messages?.length ?? 0} 条消息`);
  },
  // 换模型之后仍然记得(模型选择每轮核对一次当前值)
  model: async (caps) => {
    const other = (caps?.models || []).find((m) => m.id !== caps.currentModelId);
    if (!other) return record('model', '换模型之后仍然记得', [['清单里有第二个模型可换', false]]);
    const sid = await newSession('model');
    stub.script([{ text: 'Noted: the code word is MODEL-7.' }]);
    const a = await run(sid, 'Remember the code word MODEL-7.');
    const first = stub.requests.at(-1)?.model;
    const n = stub.mark(); stub.script([{ text: 'MODEL-7.' }]);
    const b = await run(sid, 'What is the code word?', { engineModelId: other.id });
    const req = stub.since(n)[0];
    record('model', '换模型之后仍然记得', [
      ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
      ['第二轮发给模型接口的 model 换了', !!req && req.model !== first, `${first} → ${req?.model}(选的是 ${other.name})`],
      ['第二轮仍带着第一句', has(req, 'Remember the code word MODEL-7.')],
    ]);
  },
  // 改写重发 / 重新生成:被删掉的那一轮不该还留在 DSH 的上文里
  edit: async () => {
    const sid = await newSession('edit');
    stub.script([{ text: 'Noted: the code word is EDIT-1.' }]); const a = await run(sid, 'Remember the code word EDIT-1.');
    stub.script([{ text: 'DELETED-ANSWER-9 the code word is EDIT-1.' }]); const b = await run(sid, 'DELETED-QUESTION-9 what is the code word?');
    const msgs = await messages(sid); const last2 = msgs.slice(-2).map((m) => m.id);
    await api(`/agent/sessions/${sid}/messages/delete`, { method: 'POST', body: JSON.stringify({ ids: last2 }) });
    const n = stub.mark(); stub.script([{ text: 'fresh' }]);
    const c = await run(sid, 'Say hi.');
    const req = stub.since(n)[0]; const ps = await pointers(sid);
    record('edit', '删掉重发的那一轮,DSH 不再记得', [
      ['三轮都跑完', a.done && b.done && c.done, a.error || b.error || c.error || ''],
      ['删掉的提问不在请求里', !has(req, 'DELETED-QUESTION-9')],
      ['删掉的回答不在请求里', !has(req, 'DELETED-ANSWER-9')],
      ['重发的那一轮换了一个 DSH 会话', ps.length === 3 && ps[2].ext !== ps[1].ext, ps.map((p) => p.ext?.slice(0, 8)).join(' → ')],
    ], '重发的这一轮是全新的 DSH 会话,连第一轮也不带(已知的限制)');
  },
  // 分支:两场 Forsion 对话不共用一个 DSH 会话
  branch: async () => {
    const sid = await newSession('branch');
    stub.script([{ text: 'Noted: the code word is BRANCH-3.' }]); const a = await run(sid, 'Remember the code word BRANCH-3.');
    const at = (await messages(sid)).filter((m) => m.role === 'model').at(-1)?.id; // 回答在库里的 role 是 'model'
    const br = (await api(`/agent/sessions/${sid}/branch`, { method: 'POST', body: JSON.stringify({ message_id: at }) }));
    const bid = br.session?.id || br.id;
    stub.script([{ text: 'branch reply' }]); const b = await run(bid, 'ONLY-IN-BRANCH-5 hello.');
    const n = stub.mark(); stub.script([{ text: 'BRANCH-3.' }]); const c = await run(sid, 'What is the code word?');
    const req = stub.since(n)[0]; const pa = await pointers(sid), pb = await pointers(bid);
    record('branch', '分支和原对话不共用一个 DSH 会话', [
      ['三轮都跑完', a.done && b.done && c.done, a.error || b.error || c.error || ''],
      ['分支里说的话不在原对话的请求里', !has(req, 'ONLY-IN-BRANCH-5')],
      ['原对话仍记得自己的第一句', has(req, 'Remember the code word BRANCH-3.')],
      ['两场对话各用各的 DSH 会话', !!pb[0]?.ext && pb[0].ext !== pa[0]?.ext, `原 ${pa[0]?.ext?.slice(0, 8)} / 分支 ${pb[0]?.ext?.slice(0, 8)}`],
    ]);
  },
  // 中途按停止,再接着说:仍然记得
  stop: async () => {
    const sid = await newSession('stop');
    stub.script([{ text: 'Noted: the code word is STOP-4.' }]); const a = await run(sid, 'Remember the code word STOP-4.');
    const n0 = stub.mark(); stub.script([{ hang: true }]);
    const b = await run(sid, 'STOPPED-TURN-6 think about it for a long time.', {}, { stopOn: () => stub.mark() > n0 });
    const n = stub.mark(); stub.script([{ text: 'STOP-4.' }]); const c = await run(sid, 'What is the code word?');
    const req = stub.since(n)[0]; const ps = await pointers(sid);
    record('stop', '中途停掉一轮,下一句仍然记得', [
      ['第一轮跑完、第二轮被停、第三轮跑完', a.done && b.aborted && c.done, `${a.error || ''} ${b.error || ''} ${c.error || ''}`],
      ['第三轮仍带着第一句', has(req, 'Remember the code word STOP-4.')],
      ['三轮是同一个 DSH 会话', ps.length === 3 && !!ps[0].ext && ps.every((p) => p.ext === ps[0].ext), ps.map((p) => `${p.status}:${p.ext?.slice(0, 8)}`).join(' → ')],
    ], `被停的那一句${has(req, 'STOPPED-TURN-6') ? '也在' : '不在'} DSH 的上文里`);
  },
  // 第一句就被停掉:第二句接得上同一个 DSH 会话
  stopfirst: async () => {
    const sid = await newSession('stopfirst');
    const n0 = stub.mark(); stub.script([{ hang: true }]);
    const a = await run(sid, 'FIRST-STOPPED-8 the code word is FS-8.', {}, { stopOn: () => stub.mark() > n0 });
    const n = stub.mark(); stub.script([{ text: 'ok' }]); const b = await run(sid, 'Continue.');
    const req = stub.since(n)[0]; const ps = await pointers(sid);
    record('stopfirst', '第一句就被停掉,第二句接的是同一个 DSH 会话', [
      ['第一轮被停、第二轮跑完', a.aborted && b.done, `${a.error || ''} ${b.error || ''}`],
      ['两轮是同一个 DSH 会话', ps.length === 2 && !!ps[0].ext && ps[0].ext === ps[1].ext, ps.map((p) => `${p.status}:${p.ext?.slice(0, 8)}`).join(' → ')],
    ], `被停的那一句${has(req, 'FIRST-STOPPED-8') ? '在' : '不在'} DSH 的上文里`);
  },
  // 审批卡:DSH 来问时,卡上写的是哪个工具、什么参数;批准 / 拒绝各一次,到盘上看
  approval: async () => {
    const esc = { sandbox_permissions: 'danger-full-access', justification: 'check: retry the exact operation the sandbox denied' };
    const leg = async (tag, action) => {
      const sid = await newSession(`approval-${tag}`); const file = join(OUTSIDE, `${tag}.txt`);
      stub.script([{ tool: 'write', args: { file_path: file, content: `${tag}\n` } }, { tool: 'write', args: { file_path: file, content: `${tag}\n`, ...esc } }, { text: 'done' }]);
      const r = await run(sid, 'Write the file.', { engineId: 'dsh-ro' }, { onApproval: () => action });
      return { r, file, card: r.approvals[0] };
    };
    const ok = await leg('approved', 'approve'), no = await leg('rejected', 'reject');
    const argsOf = (c) => { try { return JSON.parse(c?.arguments || '{}'); } catch { return {}; } };
    record('approval', 'DSH 来问审批时,卡上有工具名和参数;批准 / 拒绝都生效', [
      ['两轮都跑完', ok.r.done && no.r.done, ok.r.error || no.r.error || ''],
      ['各来问了一次', ok.r.approvals.length === 1 && no.r.approvals.length === 1, `${ok.r.approvals.length} / ${no.r.approvals.length}`],
      ['卡上的工具名是 write(不是笼统的 tool)', ok.card?.name === 'write', String(ok.card?.name)],
      ['卡上带着要写的路径', argsOf(ok.card).file_path === ok.file, clean(ok.card?.preview || '').slice(0, 160)],
      ['批准的那次写进去了', existsSync(ok.file) && readFileSync(ok.file, 'utf8') === 'approved\n'],
      ['拒绝的那次没写', !existsSync(no.file)],
    ]);
  },
  // 续接被拒 · 那场会话正被另一个 DSH 进程占着:照实失败,放开后接得上
  busy: async () => {
    const sid = await newSession('busy');
    stub.script([{ text: 'Noted: the code word is BUSY-2.' }]); const a = await run(sid, 'Remember the code word BUSY-2.');
    const ext = (await pointers(sid))[0]?.ext;
    const holder = rawDsh(); await holder.init();
    const held = await holder.call('session/resume', { sessionId: ext, cwd: WS, mcpServers: [] });
    const n1 = stub.mark(); const b = await run(sid, 'What is the code word?');
    const askedModel = stub.mark() > n1;
    await holder.kill();
    const n = stub.mark(); stub.script([{ text: 'BUSY-2.' }]); const c = await run(sid, 'What is the code word?');
    const req = stub.since(n)[0];
    record('busy', '会话被另一个 DSH 进程占着:照实失败,放开后接得上', [
      ['第一轮跑完', a.done, a.error || ''],
      ['另一个进程占住了它', !!held.result, JSON.stringify(held.error || '')],
      ['占着的时候这一轮失败,说明了原因', !!b.error && /another window or process/.test(b.error), b.error || '(没报错)'],
      ['失败的那一轮没有偷偷新开会话去问模型', !askedModel],
      ['放开后再发,跑完并记得第一句', c.done && has(req, 'Remember the code word BUSY-2.'), c.error || ''],
    ]);
  },
  // 续接被拒 · 那场会话在 DSH 那边没有了:这一句照实失败,再发一次新开
  gone: async () => {
    const sid = await newSession('gone');
    stub.script([{ text: 'Noted.' }]); const a = await run(sid, 'Remember GONE-1.');
    // 把记下的指针改成一个 DSH 不认识的 id(等于用户删了 DSH 那边的会话 / 换了 DSH 目录)
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(TANGU_HOME, 'state.db'));
    try { db.prepare(`UPDATE agent_runs SET result = json_set(result, '$.externalSession.id', '00000000-0000-4000-8000-000000000000') WHERE session_id = ?`).run(sid); } finally { db.close(); }
    const n1 = stub.mark(); const b = await run(sid, 'Second.');
    const askedModel = stub.mark() > n1;
    const n = stub.mark(); stub.script([{ text: 'third' }]); const c = await run(sid, 'Third.');
    const ps = await pointers(sid);
    record('gone', '会话在 DSH 那边没有了:这一句照实失败,再发一次新开', [
      ['第一轮跑完', a.done, a.error || ''],
      ['第二轮失败,说明了原因和怎么办', !!b.error && /no longer has the earlier session/.test(b.error) && /Send your message again/.test(b.error), b.error || '(没报错)'],
      ['失败的那一轮没有偷偷新开会话去问模型', !askedModel],
      ['再发一次跑完,用的是新的 DSH 会话', c.done && !!ps[2]?.ext && ps[2].ext !== '00000000-0000-4000-8000-000000000000', c.error || ps.map((p) => `${p.status}:${p.reset ? 'reset' : p.ext?.slice(0, 8)}`).join(' → ')],
      ['新会话里没有之前的上文', stub.since(n)[0]?.messages?.length === 1, `${stub.since(n)[0]?.messages?.length} 条消息`],
    ]);
  },
  // 探测模型清单不在用户的 DSH 历史里攒空会话:重启引擎再探一次,探测目录下仍只有一个会话
  probe: async () => {
    const probeDir = join(TANGU_HOME, 'engines', 'dsh', 'probe');
    const count = async () => (await dshSessions()).filter((s) => real(s.cwd) === real(probeDir)).length;
    await api('/agent/engines/dsh/capabilities'); const one = await count();
    await stopEngine(); await startEngine();
    const caps = await api('/agent/engines/dsh/capabilities'); const two = await count();
    await stopEngine(); await startEngine();
    await api('/agent/engines/dsh/capabilities'); const three = await count();
    record('probe', '反复探测模型清单,DSH 历史里只留一个探测会话', [
      ['探测过后有 1 个', one === 1, String(one)],
      ['重启引擎再探,还是 1 个', two === 1 && three === 1, `${two} / ${three}`],
      ['重启后探到的清单照旧', (caps.models || []).length > 0],
    ]);
  },
};

let exitCode = 0;
try {
  await startEngine();
  let caps = null;
  for (const [key, fn] of Object.entries(SCENARIOS)) {
    if (ONLY.size && !ONLY.has(key) && !(key === 'caps' && ONLY.has('model'))) continue;
    try { const r = await fn(caps); if (key === 'caps') caps = r; }
    catch (e) { record(key, '场景自己出错', [['跑完', false, e.message]]); }
  }
} catch (e) { console.error(`\n台架出错:${clean(e.stack || e)}`); exitCode = 1; } finally {
  await stopEngine(); await stub.close();
}
await sleep(2500); // 引擎杀 DSH 是 SIGTERM → 2 秒 → SIGKILL
let leftover = '';
try { leftover = execFileSync('pgrep', ['-fl', BIN], { encoding: 'utf8' }).trim(); } catch { leftover = ''; }
console.log('\n汇总');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}\t${r.key}\t${r.title}`);
console.log(leftover ? `\n⚠ 还有 DSH 进程没退:\n${clean(leftover)}` : '\n没有留下 DSH 进程');
if (results.some((r) => !r.ok) || leftover) exitCode = 1;
process.exit(exitCode);
