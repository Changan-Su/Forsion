#!/usr/bin/env node
/**
 * 外部引擎多轮续接实测(走 session/load 的那几家):真 standalone 引擎 × 内置引擎定义(npx 拉起官方 ACP 适配器)× 真模型。
 *
 * ⚠ 用的是这台机器上那份 CLI 的登录,会消耗它的订阅额度,测试会话也落在那份 CLI 自己的历史里 —— 跑之前先征得账号主人同意。
 *   引擎自己的数据(TANGU_HOME / state.db / 桌面配置)全在 --root 下面;适配器照产品里那样读真实的家目录(登录、npm 缓存)。
 *   每场测试会话的工作目录都是 <root>/ws,跑完用 --cleanup 按这个目录把它们从 CLI 的历史里找出来删掉(别的会话一概不碰)。
 *
 * 看的是模型自己的回答(暗号每次现编,模型猜不到),外加三样接线:
 *   每轮 run 上记的引擎会话 id、续接那一轮引擎丢掉了多少条回放(引擎日志里的 session/load 那一行)、
 *   界面收到的事件流和落库的回答里有没有上一轮的原文。
 *
 * 用法:
 *   npm run build
 *   node scripts/engine-resume.check.mjs --engine codex --root <全新目录>
 *     [--only twoturn,stop,…]        只跑某几项(见 SCENARIOS 的 key)
 *     [--repeat stop=3,stopretry=3]  某几项多跑几次:停止类是「引擎边写会话文件边被杀」的时序,一次绿不算
 *     [--engine-entry <别处的 dist/standalone/main.js>]   负对照:拿没有这次改动的构建跑同一套,twoturn 应当红
 *     [--model <清单里的模型 id>]    model 那一项用哪个模型(缺省:清单里第一个不是当前的)
 *     [--long-turns 200,2000]        long 那一项把历史放大多少轮(缺省 200,2000)
 *     [--long-from <引擎会话 id>]    long 那一项的种子会话(之前在同一个 --root 下跑出来的);缺省现跑两轮
 *     [--cleanup]                    只做清理:列出并删掉工作目录是 <root>/ws 的引擎会话(让那份 CLI 自己删,连同它状态库里的记录)
 *
 * 已实跑:codex(@agentclientprotocol/codex-acp)。别的引擎要先在 ENGINES 里补一行(会话文件在哪、怎么认工作目录)。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync, appendFileSync, statSync, readdirSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ENGINE = opt('engine', 'codex');
const ROOT_ARG = opt('root', '');
const ENTRY = resolve(opt('engine-entry', join(root, 'dist', 'standalone', 'main.js')));
const ONLY = new Set((opt('only', '') || '').split(',').filter(Boolean));
const REPEAT = Object.fromEntries((opt('repeat', '') || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Math.max(1, Number(v) || 1)]; }));
const LONG_TURNS = (opt('long-turns', '200,2000') || '').split(',').map(Number).filter((n) => n > 0);
const CLEANUP = argv.includes('--cleanup');
const MODEL = opt('model', ''); // model 那一项用哪个模型(缺省:清单里第一个不是当前的)
const LONG_FROM = opt('long-from', ''); // long 那一项拿哪场已有的引擎会话当种子(它的工作目录得是 <root>/ws);缺省现跑两轮

/** 每家引擎:握手里报的适配器名(续接放行名单认它)、会话文件放哪、怎么从文件里读出工作目录和会话 id。 */
const ENGINES = {
  codex: {
    agent: '@agentclientprotocol/codex-acp',
    sessionsDir: join(homedir(), '.codex', 'sessions'),
    // rollout-<时间>-<会话 id>.jsonl,第一行是 session_meta(payload.id / payload.cwd)
    isSessionFile: (name) => /^rollout-.*\.jsonl$/.test(name),
    meta: (firstLine) => { try { const m = JSON.parse(firstLine); return m?.type === 'session_meta' ? { id: m.payload?.id, cwd: m.payload?.cwd } : null; } catch { return null; } },
    /** 正式删掉几场会话:走 Codex 自己的 app-server(适配器包里带的那份 codex)的 thread/delete,会话文件、状态库和历史索引里的记录一起清。 */
    remove: async (ids) => {
      const c = spawn('npx', ['-y', '-p', '@agentclientprotocol/codex-acp@latest', 'codex', 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '', n = 0; const waiters = new Map();
      c.stderr.on('data', () => {});
      c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && !m.method) { waiters.get(m.id)?.(m); waiters.delete(m.id); } } });
      const call = (method, params) => new Promise((res) => { const my = ++n; const t = setTimeout(() => { waiters.delete(my); res({ error: { message: 'timeout' } }); }, 30_000); waiters.set(my, (m) => { clearTimeout(t); res(m); }); c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`); });
      const failed = []; let deleted = 0;
      try {
        const init = await call('initialize', { clientInfo: { name: 'engine-resume-check', title: 'engine-resume check cleanup', version: '0' } });
        if (init.error) return { deleted, failed: ids.map((id) => ({ id, error: `app-server initialize: ${JSON.stringify(init.error).slice(0, 160)}` })) };
        c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
        for (const threadId of ids) { const r = await call('thread/delete', { threadId }); if (r.error) failed.push({ id: threadId, error: JSON.stringify(r.error).slice(0, 160) }); else deleted += 1; }
      } finally { c.kill('SIGTERM'); }
      return { deleted, failed };
    },
    /**
     * 把一场真实的会话放大:最后一轮(task_started … task_complete)那几行原样复制 copies 份,每份换一套 turn / item id,
     * 回答的原文前面加「COPY<n>-」。copies = 0 就是原样拷贝、只换会话 id(自检用)。返回 { id, file }。
     * ⚠ 每行有一个递增的 ordinal,Codex 的历史索引靠它认「读到哪了」—— 复制出来的行不重排的话全被当成已经读过的,
     *   文件变大了、重放出来的却还是原来那两轮(2026-11-14 踩过:那样量出来的「很快」是假的)。
     */
    synthesize: (src, copies, mark) => {
      const lines = readFileSync(src, 'utf8').split('\n').filter((l) => l.trim());
      const objs = lines.map((l) => JSON.parse(l));
      const oldId = objs[0].payload.id; const newId = oldId.slice(0, -12) + randomUUID().replace(/-/g, '').slice(0, 12);
      const isEv = (o, t) => o.type === 'event_msg' && o.payload?.type === t;
      const a = objs.findLastIndex((o) => isEv(o, 'task_started')); const b = objs.findIndex((o, i) => i > a && isEv(o, 'task_complete'));
      if (a < 0 || b < 0) throw new Error('这份会话文件里找不到一轮完整的对话');
      const ids = new Set([objs[a].payload.turn_id]);
      for (const o of objs.slice(a, b + 1)) { const p = o.payload || {}; if (typeof p.item?.id === 'string') ids.add(p.item.id); if (o.type === 'response_item' && typeof p.id === 'string') ids.add(p.id); }
      const out = lines.slice(0, b + 1).map((l) => l.split(oldId).join(newId)); // 最后一轮之后的行(每次 load 追加的设置事件)不要
      for (let c = 1; c <= copies; c++) for (let l of lines.slice(a, b + 1)) {
        l = l.split(oldId).join(newId);
        const tag = c.toString(16).padStart(12, '0');
        for (const i of ids) if (i) l = l.split(i).join(i.length > 12 ? i.slice(0, -12) + tag : i + tag);
        out.push(l.split(mark).join(`COPY${c}-${mark}`));
      }
      const file = join(dirname(src), basename(src).replace(oldId, newId));
      writeFileSync(file, `${out.map((l, n) => l.replace(/"ordinal":\d+/, `"ordinal":${n}`)).join('\n')}\n`);
      return { id: newId, file };
    },
  },
};
const E = ENGINES[ENGINE];
if (!E) { console.error(`--engine 只认:${Object.keys(ENGINES).join(' / ')}(别的引擎先在 ENGINES 里补一行)`); process.exit(2); }
if (!ROOT_ARG) { console.error('用法见文件头:--engine codex --root <全新目录>'); process.exit(2); }
if (!CLEANUP && !existsSync(ENTRY)) { console.error(`找不到引擎入口(先 npm run build):${ENTRY}`); process.exit(2); }
mkdirSync(ROOT_ARG, { recursive: true });
const R = realpathSync(ROOT_ARG);
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 300) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };
const D = (name) => { const p = join(R, name); mkdirSync(p, { recursive: true }); return p; };
const WS = D('ws');
const TANGU_HOME = D(join('forsion', 'tangu'));
const LOG = join(R, 'engine.log');
const clean = (s) => String(s).split(R).join('<root>').replace(/\/Users\/[^/\s"'\\]+/g, '/Users/<user>');

// ── 引擎会话文件(那份 CLI 自己的历史):只认工作目录是 <root>/ws 的
function firstLineOf(file) {
  const fd = openSync(file, 'r');
  try { const chunks = []; const buf = Buffer.alloc(65536); let pos = 0;
    for (;;) { const n = readSync(fd, buf, 0, buf.length, pos); if (n <= 0) break; const i = buf.subarray(0, n).indexOf(10); if (i >= 0) { chunks.push(Buffer.from(buf.subarray(0, i))); break; } chunks.push(Buffer.from(buf.subarray(0, n))); pos += n; if (pos > 8 * 1024 * 1024) break; }
    return Buffer.concat(chunks).toString('utf8');
  } finally { closeSync(fd); }
}
function walk(dir, out = []) { let names = []; try { names = readdirSync(dir, { withFileTypes: true }); } catch { return out; } for (const d of names) { const p = join(dir, d.name); if (d.isDirectory()) walk(p, out); else if (E.isSessionFile(d.name)) out.push(p); } return out; }
/** 工作目录是 <root>/ws 的会话文件:[{ file, id }]。 */
function ourSessionFiles() {
  const mine = [];
  for (const file of walk(E.sessionsDir)) { let meta = null; try { meta = E.meta(firstLineOf(file)); } catch { meta = null; } if (meta?.cwd && real(meta.cwd) === real(WS)) mine.push({ file, id: meta.id }); }
  return mine;
}
const sessionFileOf = (id) => ourSessionFiles().find((s) => s.id === id)?.file || null;

if (CLEANUP) {
  const mine = ourSessionFiles();
  console.log(`工作目录是 ${clean(WS)} 的 ${ENGINE} 会话:${mine.length} 个`);
  for (const s of mine) console.log(`  ${s.id}  ${clean(s.file)}`);
  // 先让那份 CLI 自己删(会话文件和它状态库里的记录一起清),删不掉的再直接删文件
  const { deleted, failed } = mine.length ? await E.remove(mine.map((s) => s.id)) : { deleted: 0, failed: [] };
  for (const f of failed) console.log(`  CLI 没删掉 ${f.id}:${f.error}`);
  const left = ourSessionFiles();
  for (const s of left) { console.log(`  直接删文件 ${clean(s.file)}(CLI 状态库里可能还留着它的记录)`); rmSync(s.file, { force: true }); }
  console.log(`CLI 删了 ${deleted} 个,直接删文件 ${left.length} 个`);
  process.exit(0);
}

// ── 内置引擎定义(启动命令原样取自这份构建,不在这里另抄一遍)
process.env.TANGU_HOME = TANGU_HOME; // 下面这次 import 不该碰真实的 ~/.tangu
const { loadEngines } = await import(pathToFileURL(join(dirname(ENTRY), '..', 'engines', 'config.js')).href);
const DEF = loadEngines(join(R, 'no-such-engines.json')).find((e) => e.id === ENGINE);
if (!DEF) { console.error(`这份构建里没有内置引擎 ${ENGINE}`); process.exit(2); }

// 引擎进程的环境:家目录是真的(适配器要读登录和 npm 缓存,和产品里一样),引擎自己的数据另指。
const EXTRA_BIN = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')].filter((d) => existsSync(d));
const ENGINE_ENV = {
  PATH: [dirname(process.execPath), ...EXTRA_BIN, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  HOME: homedir(), USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '', SHELL: process.env.SHELL || '/bin/sh',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), LANG: 'en_US.UTF-8',
  TANGU_HOME, TANGU_DEFAULT_WORKSPACE: WS, TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0',
  FORSION_DESKTOP_CONFIG: join(R, 'userData', 'tangu-desktop-config.json'),
};

// ── 直接和适配器说 ACP(不经引擎):看握手报了什么、session/load 回放了什么、回包之后还有没有迟到的回放
function rawAdapter() {
  const c = spawn(DEF.command, DEF.args || [], { env: { ...ENGINE_ENV, ...(DEF.env || {}) }, cwd: WS, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let buf = '', id = 0, seq = 0; const waiters = new Map(); const notes = []; let stderr = '';
  c.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    seq += 1; // 到达的先后只认这个序号:回包和它后面那几条通知常常落在同一毫秒里
    if (m.id != null && !m.method) { waiters.get(m.id)?.({ ...m, seq }); waiters.delete(m.id); }
    else if (m.id != null && m.method) c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'check: not available' } })}\n`); // 适配器反过来问的(审批等)一律回绝
    else if (m.method) notes.push({ at: Date.now(), seq, method: m.method, update: m.params?.update }); } });
  const call = (method, params, ms = 60_000) => new Promise((res) => { const my = ++id; const t0 = Date.now(); const t = setTimeout(() => { waiters.delete(my); res({ timeout: method, ms: Date.now() - t0 }); }, ms);
    waiters.set(my, (m) => { clearTimeout(t); res({ ...m, ms: Date.now() - t0, at: Date.now() }); }); c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`); });
  const alive = () => c.exitCode === null && c.signalCode === null;
  const killGroup = (sig) => { try { process.kill(-c.pid, sig); } catch { try { c.kill(sig); } catch { /* 已退 */ } } };
  const kill = async () => { killGroup('SIGTERM'); for (let i = 0; i < 25 && alive(); i++) await sleep(100); if (alive()) killGroup('SIGKILL'); await sleep(150); };
  return { call, kill, notes, stderr: () => stderr, init: () => call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }) };
}
const CONTENT_KINDS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update', 'plan']);
const updatesOnly = (notes) => notes.filter((n) => n.method === 'session/update'); // 引擎数的是这一种(_auth/… 之类的扩展通知不经它)
const lateText = (notes) => notes.filter((n) => CONTENT_KINDS.has(n.update?.sessionUpdate)).map((n) => `${n.update.sessionUpdate}@+${n.afterMs}ms ${JSON.stringify(String(n.update?.content?.text ?? n.update?.title ?? '').slice(0, 60))}`).join(';') || '(没有内容类的)';
const kindsOf = (notes) => { const m = {}; for (const n of notes) { const k = n.update?.sessionUpdate || n.method; m[k] = (m[k] || 0) + 1; } return m; };
const kindsText = (m) => Object.entries(m).map(([k, v]) => `${k}×${v}`).join(' ') || '(无)';
const textOf = (notes, kind) => notes.filter((n) => n.update?.sessionUpdate === kind).map((n) => (n.update?.content?.type === 'text' ? n.update.content.text : '')).join('');
const NO_LOAD = { ok: false, error: '', ms: 0, firstAt: null, before: [], late: [], stamps: [], resultKeys: [] };
/** 裸 session/load:回包前后各收到了什么。listenMs = 回包后再听多久。 */
async function rawLoad(sessionId, { listenMs = 4000, timeoutMs = 300_000 } = {}) {
  const a = rawAdapter();
  try {
    const init = await a.init();
    if (!init.result) return { ...NO_LOAD, error: `initialize: ${JSON.stringify(init.error || init)} ${a.stderr().slice(-300)}` };
    const t0 = Date.now(); const stamps = [];
    const watch = setInterval(() => stamps.push([Date.now() - t0, a.notes.length]), 250);
    const res = await a.call('session/load', { sessionId, cwd: WS, mcpServers: [] }, timeoutMs);
    clearInterval(watch);
    await sleep(listenMs);
    const before = a.notes.filter((n) => !res.seq || n.seq < res.seq);
    const late = a.notes.filter((n) => res.seq && n.seq > res.seq).map((n) => ({ ...n, afterMs: n.at - res.at }));
    const firstAt = before.length ? before[0].at - t0 : null;
    return { ok: !!res.result, error: res.error ? JSON.stringify(res.error).slice(0, 300) : res.timeout ? `timeout after ${res.ms}ms` : '', ms: res.ms, firstAt, before, late, stamps, resultKeys: Object.keys(res.result || {}) };
  } finally { await a.kill(); }
}

// ── 真 standalone 引擎
const TOKEN = randomUUID();
let engine = null, base = '';
async function startEngine() {
  const port = await new Promise((r) => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
  base = `http://127.0.0.1:${port}`;
  engine = spawn(process.execPath, [ENTRY, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(TANGU_HOME, 'state.db'), '--sandbox', 'auto', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN], { cwd: WS, env: ENGINE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = (d) => appendFileSync(LOG, d);
  engine.stdout.on('data', log); engine.stderr.on('data', log);
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
const lastAnswer = async (sid) => { const m = (await messages(sid)).filter((x) => x.role === 'model').at(-1); return m ? { id: m.id, content: String(m.content || '') } : null; };
const logMark = () => { try { return statSync(LOG).size; } catch { return 0; } };
const logSince = (n) => { try { return readFileSync(LOG).subarray(n).toString('utf8'); } catch { return ''; } };
/** 引擎日志里这一轮的 session/load 那一行(续接才有):耗时、丢掉的重放条数、回包之后到发这一句之前又丢掉的条数。 */
const loadLine = (text) => { const m = /\[engine:[^\]]+\] session\/load \S+ took (\d+)ms, dropped (\d+) replayed updates and (\d+) sent after the response/.exec(text); return m ? { ms: Number(m[1]), dropped: Number(m[2]), trailing: Number(m[3]) } : null; };

let turns = 0; // 一共问了模型多少轮(写进汇总:额度花在哪)
/** 起一轮并读事件到结束。cfg 并进 agent_config;stopOn(ev) 为真时按停止键;来问审批一律拒绝(这些场景不该用到工具)。 */
async function run(sid, message, cfg = {}, { stopOn, timeoutMs = 240_000 } = {}) {
  turns += 1;
  const mark = logMark(); const t0 = Date.now();
  const { runId } = await api('/agent/runs', { method: 'POST', body: JSON.stringify({ session_id: sid, model_id: `engine/${ENGINE}`, message, agent_config: { engineId: ENGINE, execMode: 'host', cwd: WS, preset: null, ...cfg } }) });
  const ev = { runId, text: '', reasoning: '', tools: [], results: [], approvals: [], frames: [], done: false, error: null, aborted: false, t0, firstMs: null, ms: 0, stoppedAt: null, load: null };
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  let stopped = false; const maybeStop = async () => { if (!stopped && stopOn?.(ev)) { stopped = true; ev.stoppedAt = { ms: Date.now() - t0, text: ev.text.length, reasoning: ev.reasoning.length, tools: ev.tools.length }; await api(`/agent/runs/${runId}/abort`, { method: 'POST' }).catch(() => {}); } };
  const poll = stopOn ? setInterval(() => { void maybeStop(); }, 150) : null;
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
          if (['token', 'reasoning', 'tool_call', 'tool_result', 'done', 'error'].includes(e.type)) ev.frames.push(`${e.type}:${JSON.stringify(p)}`);
          if ((e.type === 'token' || e.type === 'reasoning') && ev.firstMs === null) ev.firstMs = Date.now() - t0;
          if (e.type === 'token') ev.text += p.delta || '';
          else if (e.type === 'reasoning') ev.reasoning += p.delta || '';
          else if (e.type === 'tool_call') ev.tools.push({ name: p.name, arguments: p.arguments });
          else if (e.type === 'tool_result') ev.results.push({ name: p.name, isError: !!p.isError, result: String(p.result || '') });
          else if (e.type === 'approval_request') {
            ev.approvals.push({ name: p.name, preview: p.preview });
            await api(`/agent/runs/${runId}/approvals/${p.approvalId}`, { method: 'POST', body: JSON.stringify({ action: 'reject' }) });
          } else if (e.type === 'done') { ev.done = true; break outer; }
          else if (e.type === 'error') { ev.error = String(p.error || 'error'); ev.aborted = !!p.aborted; break outer; }
        }
      }
    }
  } catch (e) { ev.error = ev.error || `events: ${e.message}`; } finally { clearTimeout(timer); if (poll) clearInterval(poll); ac.abort(); }
  ev.ms = Date.now() - t0;
  // done 事件之后引擎才把这一轮标成结束:等它标完再发下一句。**不多等** —— 下一句紧跟着上一句发,是要测的时序之一
  // (上一轮的适配器进程刚被杀、可能还没退干净)。
  await until(async () => !((await api(`/agent/runs?session_id=${sid}`)).runs || []).some((x) => ['queued', 'running'].includes(x.status)), 8000, 100);
  ev.load = loadLine(logSince(mark));
  return ev;
}
/** 直接读隔离的 state.db(只读):某场会话各轮 run 记下的引擎会话指针。 */
const pointers = async (sid) => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(join(TANGU_HOME, 'state.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT id, status, result FROM agent_runs WHERE session_id = ? ORDER BY created_at, rowid').all(sid).map((r) => { let x = {}; try { x = JSON.parse(r.result || '{}') || {}; } catch { /* */ } return { runId: r.id, status: r.status, ext: x.externalSession?.id || null, reset: !!x.externalSessionReset }; }); }
  finally { db.close(); }
};
// 只印 id 的末 6 位:这类 id 的开头是时间,同一分钟里建的几个会话前 8 位一模一样,看不出换没换
const chain = (ps) => ps.map((p) => `${p.status}:${p.reset ? 'reset' : p.ext ? `…${p.ext.slice(-6)}` : '无'}`).join(' → ');
const sameSession = (ps, n) => ps.length === n && !!ps[0].ext && ps.every((p) => p.ext === ps[0].ext);

const results = [];
const record = (key, title, checks, note = '') => {
  const ok = checks.every((c) => c[1]);
  results.push({ key, title, ok, checks: checks.map(([name, pass, detail]) => ({ name, pass: !!pass, detail: detail ? clean(detail) : '' })), note: clean(note) });
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${key} — ${title}`);
  for (const [name, pass, detail] of checks) console.log(`   ${pass ? '✓' : '✗'} ${name}${detail ? `:${clean(detail)}` : ''}`);
  if (note) console.log(`   · ${clean(note)}`);
};

// 暗号每次现编,模型猜不到。
const codeWord = (prefix) => `${prefix}-${1000 + Math.floor(Math.random() * 9000)}`;
const ASK = 'What code word did I ask you to remember? Reply with just the code word.';
const ASK_ALL = 'List every code word I asked you to remember in this conversation. Reply with just the code words.';
const LONG_TASK = 'Write the numbers from 1 to 2000, one per line, as plain text in your reply. Do not use any tool.';
const said = (r) => `模型原话:${(r.text || '').trim().replace(/\s+/g, ' ').slice(0, 160) || '(空)'}`;
const timing = (r) => `${r.ms}ms${r.firstMs != null ? `,首字 ${r.firstMs}ms` : ''}${r.load ? `,其中 session/load ${r.load.ms}ms、丢掉重放 ${r.load.dropped} 条 + 回包后 ${r.load.trailing} 条` : ''}`;
const truncate = (sid, ids) => api(`/agent/sessions/${sid}/messages/delete`, { method: 'POST', body: JSON.stringify({ ids }) });
/** 停在哪:0 = 回答刚出字;1 = 还在想(没出字)或刚发出去几秒;2 = 回答出了一段之后。都带时间上限,免得模型一直不出字。 */
const STOP_POINTS = [
  { name: '回答刚出字', when: (ev) => ev.text.length > 20 || Date.now() - ev.t0 > 20_000 },
  { name: '还在想 / 刚发出去', when: (ev) => ev.reasoning.length > 0 || Date.now() - ev.t0 > 6000 },
  { name: '回答出了一段', when: (ev) => ev.text.length > 300 || Date.now() - ev.t0 > 25_000 },
];
const stoppedTurn = (sid, message, i = 0) => run(sid, message, {}, { stopOn: STOP_POINTS[i % STOP_POINTS.length].when });
const stopNote = (r, i) => `停在「${STOP_POINTS[i % STOP_POINTS.length].name}」:第 ${r.stoppedAt?.ms ?? '?'}ms,已出字 ${r.stoppedAt?.text ?? 0}、思考 ${r.stoppedAt?.reasoning ?? 0}、工具 ${r.stoppedAt?.tools ?? 0}`;
/** 续接的那一轮:引擎确实走了 session/load 并丢掉了回放(光看「事件流里没有上一轮的原文」证不了 —— 没回放时也成立)。 */
const loadChecks = (r, label = '续接那一轮') => [[`${label}走了 session/load,回放被丢掉(引擎日志)`, !!r.load && r.load.dropped > 0, r.load ? `${r.load.ms}ms,丢 ${r.load.dropped} 条重放 + 回包后 ${r.load.trailing} 条` : '日志里没有 session/load 那一行']];
/** 上一轮的原文没有被当成这一轮的输出:事件流(正文 / 思考 / 工具)和落库的回答里都不该有。markers = 只在更早的轮次里出现过的串。 */
const leakChecks = (r, answer, markers, earlierReasoning = '') => {
  const frames = r.frames.join('\n');
  const hit = markers.filter((m) => frames.includes(m));
  const replayedThought = earlierReasoning.trim().length >= 24 && r.reasoning.includes(earlierReasoning.trim().slice(0, 80));
  return [
    ['界面收到的事件里没有上一轮的原文', hit.length === 0 && !replayedThought, hit.length ? `出现了 ${hit.join(' / ')}` : replayedThought ? '上一轮的思考被重发了' : `正文 ${r.text.length} 字、思考 ${r.reasoning.length} 字、工具 ${r.tools.length} 次`],
    ['落库的回答里也没有', !!answer && !markers.some((m) => answer.content.includes(m)), answer ? JSON.stringify(answer.content.slice(0, 80)) : '(没落库)'],
  ];
};

const state = { firstExt: null, firstMark: '' };
const SCENARIOS = {
  // 握手里报了什么:续接放行名单认的就是这里的适配器名
  handshake: async () => {
    const a = rawAdapter();
    try {
      const init = await a.init(); const info = init.result?.agentInfo || {}; const caps = init.result?.agentCapabilities || {};
      const listed = await api(`/agent/engines/${ENGINE}/capabilities`).catch((e) => ({ error: e.message }));
      record('handshake', '握手报的适配器名和续接能力', [
        ['握手成功', !!init.result, init.error ? JSON.stringify(init.error) : `${init.ms}ms`],
        ['适配器名就是放行名单里写的那个', info.name === E.agent, `${info.name} ${info.version || ''}`.trim()],
        ['报了 loadSession', caps.loadSession === true, `loadSession=${caps.loadSession};sessionCapabilities 有 ${Object.keys(caps.sessionCapabilities || {}).join(' / ') || '(无)'}`],
      ], `启动命令:${DEF.command} ${(DEF.args || []).join(' ')};模型清单 ${(listed.models || []).map((m) => m.id).join(' / ') || listed.error || '(空)'},当前 ${listed.currentModelId}`);
    } finally { await a.kill(); }
  },
  // 第二句记得第一句;续接那一轮的回放确实被丢掉了,界面没收到上一轮的原文。两轮各是一个新的适配器进程。
  twoturn: async () => {
    const word = codeWord('QUOKKA'), ack = codeWord('NOTED'); const sid = await newSession('twoturn');
    const a = await run(sid, `Remember this code word for later: ${word}. Reply with exactly: ${ack}`);
    const ext = (await pointers(sid))[0]?.ext; if (ext) { state.firstExt = ext; state.firstMark = word; }
    // 适配器自己回放了什么(不经引擎):回放里确实有第一轮的回答,丢弃逻辑才有东西可丢
    const raw1 = ext ? await rawLoad(ext) : { ...NO_LOAD, error: '第一轮没记下引擎会话' };
    const b = await run(sid, ASK);
    const answer = await lastAnswer(sid);
    const raw2 = ext ? await rawLoad(ext) : { ...NO_LOAD, error: '第一轮没记下引擎会话' };
    const c = await run(await newSession('twoturn-control'), ASK);
    const ps = await pointers(sid);
    // 回包之后适配器还会补发几条(实测 Codex:一条当正文发的配置警告 + 上一轮的用量)。它们的原文拿来当记号:不该出现在第二轮里。
    const strays = [...raw1.late, ...raw2.late].filter((n) => n.update?.sessionUpdate === 'agent_message_chunk' || n.update?.sessionUpdate === 'agent_thought_chunk').map((n) => String(n.update?.content?.text || '').trim().slice(0, 48)).filter((t) => t.length >= 12);
    const lateHistory = [...raw1.late, ...raw2.late].some((n) => JSON.stringify(n.update || {}).includes(ack) || JSON.stringify(n.update || {}).includes('Remember this code word for later'));
    const total = b.load ? b.load.dropped + b.load.trailing : -1; const lo = updatesOnly(raw1.before).length, hi = lo + updatesOnly(raw1.late).length;
    record('twoturn', '第二句记得第一句,回放没有被当成这一轮的输出', [
      ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
      ['第二句的回答里有第一句给的暗号', b.text.includes(word), said(b)],
      ['两轮用的是同一个引擎会话', sameSession(ps, 2), chain(ps)],
      ['对照:另开一场对话问同一句,答不出这个暗号', c.done && !c.text.includes(word), said(c)],
      ['适配器的回放里确实带着第一轮的回答(裸 session/load)', !!raw1.ok && textOf(raw1.before, 'agent_message_chunk').includes(ack), raw1.error || `${raw1.ms}ms;${kindsText(kindsOf(raw1.before))}`],
      ...loadChecks(b),
      ['引擎丢掉的条数和适配器发的对得上(重放的全丢;回包后补发的看赶没赶在发这一句之前)', !!b.load && !!raw1.ok && b.load.dropped >= lo && total <= hi, `引擎丢 ${b.load?.dropped ?? '?'} + ${b.load?.trailing ?? '?'};适配器回包前 ${lo} 条、回包后 ${hi - lo} 条`],
      ['历史的重放都在回包之前到(裸 session/load,回包后再听 4 秒)', !!raw2.ok && !lateHistory, raw2.error || `两轮之后回包前:${kindsText(kindsOf(raw2.before))}`],
      ['回包之后补发的那几条没有混进第二轮', strays.every((t) => !b.frames.join('\n').includes(t)) && !!answer && strays.every((t) => !answer.content.includes(t)), `适配器补发:${lateText(raw1.late)}`],
      ...leakChecks(b, answer, [ack, 'Remember this code word for later'], a.reasoning),
    ], `第一轮 ${timing(a)};第二轮 ${timing(b)};对照那一轮 ${timing(c)};session/load 回包带的字段:${raw2.resultKeys.join(' / ') || '(无)'}`);
  },
  // 用户选过模型的对话每轮都带 engineModelId:续接之后设模型那一步照样走得通
  model: async () => {
    const caps = await api(`/agent/engines/${ENGINE}/capabilities`);
    const other = (caps.models || []).find((m) => (MODEL ? m.id === MODEL : m.id !== caps.currentModelId));
    if (!other) return record('model', '带着选好的模型续接', [['清单里有第二个模型可选', false, `共 ${(caps.models || []).length} 个`]]);
    const word = codeWord('MARMOT'), ack = codeWord('NOTED'); const sid = await newSession('model');
    const mark = logMark();
    const a = await run(sid, `Remember this code word for later: ${word}. Reply with exactly: ${ack}`, { engineModelId: other.id });
    const b = await run(sid, ASK, { engineModelId: other.id });
    const answer = await lastAnswer(sid); const ps = await pointers(sid);
    const setFailed = /set model\([^)]*\) failed[^\n]*/.exec(logSince(mark));
    record('model', '带着选好的模型续接', [
      ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
      ['第二句答得出暗号', b.text.includes(word), said(b)],
      ['两轮用的是同一个引擎会话', sameSession(ps, 2), chain(ps)],
      ['设模型那一步没有报错', !setFailed, setFailed ? setFailed[0] : `选的是 ${other.name}(引擎当前 ${caps.currentModelId})`],
      ...loadChecks(b), ...leakChecks(b, answer, [ack], a.reasoning),
    ], `第一轮 ${timing(a)};第二轮 ${timing(b)}`);
  },
  // 重新生成 / 编辑重发:被删掉的那一轮不该还留在引擎的上文里
  regen: async () => {
    const keep = codeWord('WALRUS'), gone = codeWord('PELICAN'); const sid = await newSession('regen');
    const a = await run(sid, `Remember this code word for later: ${keep}. Reply with just: OK`);
    const b = await run(sid, `Remember a second code word: ${gone}. Reply with just: OK`);
    await truncate(sid, (await messages(sid)).slice(-1).map((m) => m.id).concat('client-only-user-message'));
    const c = await run(sid, ASK_ALL);
    const ps = await pointers(sid);
    record('regen', '重新生成后,不记得被删掉的那一轮', [
      ['三轮都跑完', a.done && b.done && c.done, a.error || b.error || c.error || ''],
      ['删之前第二轮接的是第一轮的引擎会话', !!ps[0]?.ext && ps[0].ext === ps[1]?.ext, chain(ps)],
      ['被删掉的那一轮里的暗号,模型答不出来', !c.text.includes(gone), said(c)],
      ['重发的那一轮换了一个引擎会话', ps.length === 3 && !!ps[2].ext && ps[2].ext !== ps[1].ext, chain(ps)],
    ], `第一轮的暗号${c.text.includes(keep) ? '还' : '也不'}在回答里(重发后是全新的引擎会话,连第一轮也不带:已知的限制)`);
  },
  // 中途按停止,再接着说:仍然记得。引擎是边写会话文件边被杀的,所以在同一场对话里连着停几次(--repeat stop=3),每次停在不同的地方。
  stop: async () => {
    const word = codeWord('OTTER'), ack = codeWord('NOTED'); const sid = await newSession('stop');
    const a = await run(sid, `Remember this code word for later: ${word}. Reply with exactly: ${ack}`);
    for (let i = 0; i < (REPEAT.stop || 1); i++) {
      const b = await stoppedTurn(sid, LONG_TASK, i);
      const c = await run(sid, ASK);
      const answer = await lastAnswer(sid); const ps = await pointers(sid);
      const partial = b.text.trim().length >= 30 ? [b.text.trim().slice(0, 40)] : []; // 被停的那一轮已经出的字,也不该在下一轮里重发
      record(`stop#${i + 1}`, '中途停掉一轮,下一句仍然记得', [
        ['第一轮跑完、这一轮被停、下一轮跑完', a.done && b.aborted && c.done, `${a.error || ''} ${b.error || ''} ${c.error || ''}`.trim()],
        ['停掉之后还答得出第一句给的暗号', c.text.includes(word), said(c)],
        ['到这里每一轮都是同一个引擎会话', sameSession(ps, 3 + 2 * i), chain(ps)],
        ...loadChecks(c, '停掉之后那一轮'), ...leakChecks(c, answer, [ack, ...partial], a.reasoning),
      ], `${stopNote(b, i)};下一轮 ${timing(c)}`);
    }
  },
  // 停掉一轮之后把那一句改了重发:被弃掉的那一句不该还留在引擎的上文里
  stopedit: async (i = 0) => {
    const keep = codeWord('BADGER'), gone = codeWord('PUFFIN'); const sid = await newSession(`stopedit-${i}`);
    const a = await run(sid, `Remember this code word for later: ${keep}. Reply with just: OK`);
    const b = await stoppedTurn(sid, `Remember a second code word: ${gone}. Then write the numbers from 1 to 2000, one per line, as plain text in your reply. Do not use any tool.`, i);
    await truncate(sid, ['client-only-user-message', 'client-only-placeholder']); // 客户端的「改了再发」:那一句和它的空占位只在客户端有
    const c = await run(sid, ASK_ALL);
    const ps = await pointers(sid);
    record(REPEAT.stopedit ? `stopedit#${i + 1}` : 'stopedit', '停掉一轮后把那一句改了重发,不记得被弃掉的那一句', [
      ['第一轮跑完、第二轮被停、第三轮跑完', a.done && b.aborted && c.done, `${a.error || ''} ${b.error || ''} ${c.error || ''}`.trim()],
      ['被弃掉的那一句里的暗号,模型答不出来', !c.text.includes(gone), said(c)],
      ['改写后的这一轮换了一个引擎会话', ps.length === 3 && !!ps[1].ext && !!ps[2].ext && ps[2].ext !== ps[1].ext, chain(ps)],
    ], `${stopNote(b, i)};改写后是全新的引擎会话,连第一轮也不带(已知的限制)`);
  },
  // 停掉一轮之后原样重试(客户端的「重试」也走删消息入口):同一句话再说一遍,没有被弃掉的东西,仍然接着原来的会话
  stopretry: async () => {
    const word = codeWord('HERON'), ack = codeWord('NOTED'); const sid = await newSession('stopretry');
    const again = 'What code word did I ask you to remember? Put the code word alone on the first line, then explain in about 150 words why people use code words.';
    const a = await run(sid, `Remember this code word for later: ${word}. Reply with exactly: ${ack}`);
    for (let i = 0; i < (REPEAT.stopretry || 1); i++) {
      const b = await stoppedTurn(sid, again, i);
      await truncate(sid, ['client-only-user-message', 'client-only-placeholder']);
      const c = await run(sid, again);
      const answer = await lastAnswer(sid); const ps = await pointers(sid);
      record(`stopretry#${i + 1}`, '停掉一轮后原样重试,仍然记得前面的', [
        ['第一轮跑完、这一轮被停、重试跑完', a.done && b.aborted && c.done, `${a.error || ''} ${b.error || ''} ${c.error || ''}`.trim()],
        ['重试的这一轮答得出第一句给的暗号', c.text.includes(word), said(c)],
        ['到这里每一轮都是同一个引擎会话', sameSession(ps, 3 + 2 * i), chain(ps)],
        ...loadChecks(c, '重试的那一轮'), ...leakChecks(c, answer, [ack], a.reasoning),
      ], `${stopNote(b, i)};重试那一轮 ${timing(c)}`);
    }
  },
  // 历史很长时 session/load 多久回包:超过握手时限(30 秒)的话,续接的那一句失败,而且之后每一句都会再去 load 同一个会话、
  // 再失败。把一场真实的两轮会话放大成几百、几千轮(见 ENGINES.*.synthesize),直接和适配器说 session/load 来量 —— 不问模型。
  long: async () => {
    let ext = LONG_FROM || state.firstExt; let mark = state.firstMark;
    if (!ext) {
      mark = codeWord('QUOKKA'); const sid = await newSession('long-seed');
      await run(sid, `Remember this code word for later: ${mark}. Reply with exactly: ${codeWord('NOTED')}`); await run(sid, ASK);
      ext = (await pointers(sid))[0]?.ext;
    }
    const src = ext ? sessionFileOf(ext) : null;
    if (!src) return record('long', '历史很长时,session/load 多久回包', [['找得到种子会话的文件(工作目录得是 <root>/ws)', false, String(ext)]]);
    if (!mark) mark = (/\b[A-Z]{4,8}-\d{4}\b/.exec(readFileSync(src, 'utf8').split('"role":"user"').at(-2) || '') || [''])[0] || 'QUOKKA-'; // --long-from:暗号从文件里认
    const turnsIn = (r) => r.before.filter((n) => n.update?.sessionUpdate === 'user_message_chunk').length;
    const base = await rawLoad(ext, { listenMs: 1000 }); const baseTurns = turnsIn(base);
    const checks = [['种子会话载入得回来', base.ok && baseTurns > 0, base.error || `${baseTurns} 轮,${updatesOnly(base.before).length} 条通知,${base.ms}ms 回包`]];
    for (const n of [0, ...LONG_TURNS]) {
      const syn = E.synthesize(src, n, mark);
      const r1 = await rawLoad(syn.id, { listenMs: 1000 }), r2 = await rawLoad(syn.id, { listenMs: 1000 });
      const lastCopyReplayed = n === 0 || textOf(r1.before, 'agent_message_chunk').includes(`COPY${n}-`);
      const detail = r1.error || r2.error || `重放 ${turnsIn(r1)} 轮、${updatesOnly(r1.before).length} 条通知;${r1.ms}ms 回包,再载一次 ${r2.ms}ms;会话文件 ${(statSync(syn.file).size / 1e6).toFixed(1)}MB`;
      checks.push(n === 0
        ? ['自检:原样拷贝(只换会话 id)重放出来的和种子一样多', r1.ok && turnsIn(r1) === baseTurns && updatesOnly(r1.before).length === updatesOnly(base.before).length, detail]
        : [`放大到 ${baseTurns + n} 轮:每一轮都被重放了,回包离握手时限(30 秒)还远`, r1.ok && r2.ok && turnsIn(r1) === baseTurns + n && lastCopyReplayed && Math.max(r1.ms, r2.ms) < 15_000, detail]);
    }
    record('long', '历史很长时,session/load 多久回包(直接问适配器,不问模型)', checks, '放大出来的轮次每轮只有一问一答、各几十个字;真实对话的一轮更大(长回答、工具调用),耗时按文件大小估更准');
  },
};

const SELF_REPEAT = new Set(['stop', 'stopretry']); // 这两项自己在同一场对话里循环 --repeat 次
let exitCode = 0;
const startedAt = Date.now();
const adapterPidsBefore = (() => { try { return new Set(execFileSync('pgrep', ['-f', E.agent.split('/').pop()], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)); } catch { return new Set(); } })();
try {
  await startEngine();
  console.log(`引擎 ${ENGINE}:${DEF.command} ${(DEF.args || []).join(' ')};构建 ${clean(ENTRY)}`);
  for (const [key, fn] of Object.entries(SCENARIOS)) {
    if (ONLY.size && !ONLY.has(key)) continue;
    for (let i = 0; i < (SELF_REPEAT.has(key) ? 1 : REPEAT[key] || 1); i++) {
      try { await fn(i); }
      catch (e) { record(REPEAT[key] ? `${key}#${i + 1}` : key, '场景自己出错', [['跑完', false, e.message]]); }
    }
  }
} catch (e) { console.error(`\n台架出错:${clean(e.stack || e)}`); exitCode = 1; } finally {
  await stopEngine();
}
await sleep(2500); // 引擎杀适配器是 SIGTERM → 2 秒 → SIGKILL
let leftover = [];
try { leftover = execFileSync('pgrep', ['-fl', E.agent.split('/').pop()], { encoding: 'utf8' }).trim().split('\n').filter((l) => l && !adapterPidsBefore.has(l.split(' ')[0])); } catch { leftover = []; }
const sessionFiles = ourSessionFiles();
console.log('\n汇总');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}\t${r.key}\t${r.title}`);
console.log(`\n一共问了模型 ${turns} 轮,用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒;${ENGINE} 的历史里现在有 ${sessionFiles.length} 个工作目录是 <root>/ws 的会话文件(--cleanup 删)`);
console.log(leftover.length ? `⚠ 还有适配器进程没退:\n${clean(leftover.join('\n'))}` : '没有留下适配器进程');
writeFileSync(join(R, 'results.json'), JSON.stringify({ engine: ENGINE, command: `${DEF.command} ${(DEF.args || []).join(' ')}`, entry: clean(ENTRY), turns, seconds: Math.round((Date.now() - startedAt) / 1000), leftover: leftover.length, results }, null, 2));
if (results.some((r) => !r.ok) || leftover.length) exitCode = 1;
process.exit(exitCode);
