#!/usr/bin/env node
/**
 * DSH 引擎实测:真 standalone 引擎 × 真 DSH(官方包,`dsh --profile acp`)× 本机假模型。
 * 不带真 key、不连外网、不碰真实的 ~/.dsh 与 ~/.tangu —— HOME / DSH_HOME / TANGU_HOME / XDG_* / TMPDIR 全指到 --root 下面。
 * 证的是「接线」:引擎把哪个 DSH 会话续上了、交给模型的请求里有没有上一句、审批卡上写的是什么。模型配不配合要另用真模型验。
 *
 * 用法:
 *   npm run build
 *   node scripts/dsh-engine.check.mjs --node <Node ≥ 24 的可执行文件> --dsh <@deepseek-ai/dsh 的 lib/bin.js> --root <全新目录>
 *     [--only twoturn,model,…]   只跑某几项(见下面 SCENARIOS 的 key;nokey = 当前模型缺 API key 时的失败原因;
 *                                agent = 「由谁来跑」设成 DSH 的 Agent,底层第 2 步;
 *                                handoff = 交接,底层第 3 步;resident = 融合插件第 1 档的常驻进程)
 *     [--engine-entry <别处的 dist/standalone/main.js>]   负对照:拿没有这次改动的旧构建跑同一套,twoturn 应当红
 *     [--live --key-file <一行 key 的文件> | --live --dsh-home <已登录的 DSH 目录>]   真模型:看模型自己的回答(caps / twoturn /
 *                                    model / edit / stop / stopedit / approval / handoff / resident);key 只进子进程环境,不落盘、不打印。
 *                                    resident 要同时带 --dsh-tools-off,会在那份 DSH 目录里临时建 profiles/fusion、跑完拿走
 *     [--live-dry]                   不要凭据,用假模型里的自动脑把真模型那套走一遍,只证台架没写错
 *     [--dsh-tools-off]              开跑前在那份 DSH 目录的对话入口组合(profiles/acp/cordis.patch.yml)里关掉 DSH 自带的
 *                                    跑命令、读写文件、搜文件、后台任务(tool-bash / tool-pwsh / tool-fs / tool-fs-search / tool-jobs),
 *                                    模型手里只剩桥里的 Forsion 工具;跑完把那份补丁原样还原。真模型跑交接时用它
 *     [--dump-requests <文件>]       假模型模式:跑完把假模型收到的带工具请求原样写进这个文件(比两版交给模型的东西用)
 *
 * 交接那几项真模型红了、想分清是交过去的东西变了还是模型变了:先用 --dump-requests 比两版请求,再用
 * scripts/dsh-instructions.probe.mjs 拿同一份指令目录对真模型多问几次。
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
import { mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
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
// 真模型模式:DSH 不指到假模型,断言看模型自己的回答。凭据二选一:--key-file(文件里一行 DeepSeek key,只进子进程的环境,
// 不落盘、不打印)或 --dsh-home(一份已经登录过的 DSH 目录,原样用它)。--live-dry:不要凭据,用假模型里一个「记得住暗号」的
// 自动脑把真模型那套场景走一遍,只证台架自己没写错。
const LIVE = argv.includes('--live'), LIVE_DRY = argv.includes('--live-dry');
const TOOLS_OFF = argv.includes('--dsh-tools-off');
// DSH 自带的这几样被关掉后不该再出现在交给模型的工具里(0.2.2-rc.3 的工具名:tool-fs / tool-fs-search / tool-bash / tool-jobs 各自注册的)
const NATIVE_DISK_TOOLS = ['read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'bash', 'pwsh', 'job_kill', 'job_list', 'job_output'];
const TOOLS_OFF_PATCH = `# dsh-engine.check.mjs --dsh-tools-off 临时写的:关掉 DSH 自带的跑命令、读写文件、搜文件、后台任务,跑完还原。
- id: tool-bash
  disabled: true
- id: tool-pwsh
  disabled: true
- id: tool-jobs
  disabled: true
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
`;
const KEY_FILE = opt('key-file', ''), DSH_HOME_ARG = opt('dsh-home', '');
// --dump-requests <文件>:跑完把假模型收到的带工具请求(system / tools / messages 原样)写进这个文件,比两版交给模型的东西用
const DUMP_REQUESTS = opt('dump-requests', '') ? resolve(opt('dump-requests', '')) : '';
// --model <片段>:真模型那套每一轮都用清单里 id 或名字含这段文字的那个模型。用账号登录(不是 API key)的 DSH,新会话的缺省模型
// 走的是要 key 的那条线(deepseek-official),不指定的话每一句都是「no API key for provider route」。
const LIVE_MODEL = opt('model', '');
if (LIVE && !KEY_FILE && !DSH_HOME_ARG) { console.error('--live 要 --key-file <文件> 或 --dsh-home <已登录的 DSH 目录>'); process.exit(2); }
if (LIVE && KEY_FILE && !existsSync(KEY_FILE)) { console.error(`找不到 --key-file:${KEY_FILE}`); process.exit(2); }
const LIVE_KEY = LIVE && KEY_FILE ? readFileSync(KEY_FILE, 'utf8').trim() : '';
if (LIVE && KEY_FILE && !LIVE_KEY) { console.error('--key-file 是空的'); process.exit(2); }
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
const HOME = D('home'), DSH_HOME = LIVE && DSH_HOME_ARG ? resolve(DSH_HOME_ARG) : D('dsh'), WS = D('ws'), OUTSIDE = D('outside'), TMP = D('tmp');
const TANGU_HOME = D(join('forsion', 'tangu'));
// DSH 以 .git 定项目根,把根到工作目录一路上的 AGENTS.md / CLAUDE.md 都发给模型(dsh-agent-instructions)。--root 常在
// 某个仓里面:不立这个标记,那个仓自己的说明会整份进每一次请求(真模型时还会发给模型方),判据跟着它的规矩漂(2026-11-16 实测)。
mkdirSync(join(WS, '.git'), { recursive: true });
const LOG = join(R, 'engine.log');
const clean = (s) => (LIVE_KEY ? String(s).split(LIVE_KEY).join('<key>') : String(s)).split(R).join('<root>').replace(/\/Users\/[^/\s"'\\]+/g, '/Users/<user>');

// ── 本机假模型(Anthropic Messages 格式,DSH 0.2.2 调的是 POST {DEEPSEEK_BASE_URL}/v1/messages)。只听 127.0.0.1。
//    剧本的每一步对应一次带工具的模型请求:{ text } | { tool, args } | { hang: true }(一直不回,等这一轮被停掉)。剧本用完回「ok」。
// --live-dry 的自动脑:记得住上文里出现过的暗号(形如 QUOKKA-1234),被要求数数就一直不回(等着被停)。
function autoBrain(body) {
  // 只看最新的那一句。它不一定是最后一个文本块:DSH 会在提问前后夹环境说明 / 换模型提示;被停掉的一轮没有回答,
  // 它的提问还会和下一句并进同一条 user 消息。所以在最后一条 user 消息里从后往前找第一个像我们发的话的文本块。
  const msgs = body?.messages || []; const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const blocks = typeof lastUser?.content === 'string' ? [lastUser.content] : (lastUser?.content || []).map((b) => b.text).filter((t) => typeof t === 'string');
  const last = [...blocks].reverse().find((t) => /numbers from 1 to|code word/i.test(t)) || '';
  if (/numbers from 1 to/i.test(last)) return { hang: true };
  if (/What code word did I ask|List every code word/i.test(last)) {
    const earlier = JSON.stringify(msgs).split(JSON.stringify(last).slice(1, -1)).join(''); // 上文 = 整个请求去掉这一句自己
    const seen = [...new Set(earlier.match(/\b[A-Z]{4,8}-\d{4}\b/g) || [])];
    return { text: seen.length ? seen.join(' ') : 'I do not know any code word.' };
  }
  return { text: 'OK' };
}
// ── 同一个假模型的 OpenAI 兼容口(/v1/chat/completions):给 Forsion 这边的后台模型(Historian 判官)用,只在 agent 那一项打开。
//    判官那一问回一份判断(日志 + 一条记忆候选,内容取对话里出现的暗号);别的旁路请求回一句短话。
function judgeReply(body) {
  const text = JSON.stringify(body?.messages || []);
  if (!/\[Task: judge\]/.test(text)) return 'OK';
  const word = (text.match(/\b[A-Z]{4,8}-\d{2,4}\b/) || ['nothing'])[0];
  return JSON.stringify({ title: 'Code word', summary: `The user shared the code word ${word}.`, log: `Talked about the code word ${word}.`, memory_candidates: [`The user's test code word is ${word}.`] });
}
const stub = await (async () => {
  const requests = []; const judged = []; let queue = []; const hanging = new Set();
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const path = (req.url || '').split('?')[0];
      if (req.method === 'GET' && /\/models$/.test(path)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'judge', object: 'model' }] })); }
      if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
        judged.push(body); const content = judgeReply(body);
        const base = { id: `chatcmpl_${judged.length}`, created: Math.floor(Date.now() / 1000), model: body?.model || 'judge' };
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (!body?.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })); }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
        chunk({ role: 'assistant', content }); chunk({}, 'stop', { usage }); res.write('data: [DONE]\n\n'); return res.end();
      }
      if (req.method === 'POST' && /\/messages\/count_tokens$/.test(path)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 10 })); }
      if (!(req.method === 'POST' && /\/messages$/.test(path))) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `stub: no such route ${path}` } })); }
      const withTools = Array.isArray(body?.tools) && body.tools.length > 0;
      let step = withTools ? (queue.shift() || {}) : { text: 'check session' }; // 不带工具的是起标题之类的旁路请求,不占剧本
      if (withTools && LIVE_DRY) step = autoBrain(body);
      if (withTools) requests.push(body);
      if (step.hang) { hanging.add(res); req.on('close', () => hanging.delete(res)); return; }
      const blocks = [];
      if (step.text || !step.tool) blocks.push({ type: 'text', text: step.text ?? 'ok' });
      // tool 可以是函数:按这次请求里交给模型的工具清单挑名字(DSH 会把超 64 字符的名字截断加哈希)
      if (step.tool) blocks.push({ type: 'tool_use', id: `toolu_${randomUUID().slice(0, 8)}`, name: typeof step.tool === 'function' ? step.tool(body) : step.tool, input: step.args || {} });
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
    url: `http://127.0.0.1:${server.address().port}`, requests, judged,
    script: (steps) => { queue = [...steps]; }, mark: () => requests.length,
    since: (n) => requests.slice(n),
    close: async () => { for (const r of hanging) r.destroy(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
})();

// ── DSH 子进程的环境:全部另指,假 key 只会发给上面那个假模型
//    真模型模式:不指到假模型;真 key(--key-file)只放进引擎进程和这里直接起的 DSH 的环境里(引擎会把自己的环境传给它起的 DSH),
//    不写进下面那份 engines.json。
const modelEnv = LIVE ? (LIVE_KEY ? { DEEPSEEK_API_KEY: LIVE_KEY } : {}) : { DEEPSEEK_BASE_URL: stub.url, DEEPSEEK_API_KEY: 'stub-not-a-real-key' };
const dshEnvOnDisk = (extra = {}) => ({
  PATH: `${dirname(NODE)}:/usr/bin:/bin`, HOME, DSH_HOME, TMPDIR: TMP,
  XDG_CACHE_HOME: D('xc'), XDG_DATA_HOME: D('xd'), XDG_STATE_HOME: D('xs'),
  DSH_TELEMETRY_DISABLED: '1', ...(LIVE ? {} : modelEnv), ...extra,
});
const dshEnv = (extra = {}) => ({ ...dshEnvOnDisk(extra), ...modelEnv });
// 引擎清单:按 id 覆盖内置的 dsh(内置那条跑的是 PATH 上的 `dsh`,这里指到 --dsh 给的那份);dsh-ro = 只读模式,给审批那一项用;
// dsh-nokey = 一份什么凭据都没有的 DSH(自己的空目录,环境里不带 key、也不指到假模型),给 nokey 那一项用
const noKeyEnv = () => { const { DEEPSEEK_API_KEY: _key, DEEPSEEK_BASE_URL: _url, ...rest } = dshEnvOnDisk({ DSH_HOME: D('dsh-nokey') }); return rest; };
writeFileSync(join(TANGU_HOME, 'engines.json'), JSON.stringify({ engines: [
  { id: 'dsh', name: 'DeepSeek Harness', command: NODE, args: [BIN, '--profile', 'acp'], env: dshEnvOnDisk() },
  { id: 'dsh-ro', name: 'DeepSeek Harness (read-only)', command: NODE, args: [BIN, '--profile', 'acp'], env: dshEnvOnDisk({ DSH_PERMISSION_MODE: 'read-only' }) },
  { id: 'dsh-nokey', name: 'DeepSeek Harness (no key)', command: NODE, args: [BIN, '--profile', 'acp'], env: noKeyEnv() },
] }, null, 2));

// Forsion 这边的直连 provider(假模型的 OpenAI 兼容口):provider 只在引擎启动时读一次,所以开跑前写好;Historian 缺省关着,
// agent 那一项开跑时才打开(每一轮都评),跑完关掉 —— 别的项不受影响。config.json 每次现读,改了立即生效。
const JUDGE_MODEL = 'stubjudge/judge';
// config.json 在 TANGU_HOME 的上一级(目录名是 tangu 时,见 core/tanguHome.ts 的 forsionSharedDir)。读出来再改:引擎启动时
// 会往里迁别的段(engines.json 就被它收走了、specialAgents 补缺省),整份覆盖会把那些冲掉。
const CONFIG_FILE = join(dirname(TANGU_HOME), 'config.json');
const readConfig = () => { try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { return {}; } };
const writeConfigFile = (cur) => writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2));
{ const cur = readConfig(); cur.providers = [{ providerId: 'stubjudge', baseUrl: `${stub.url}/v1`, apiKey: 'stub-not-a-real-key', modelIds: ['judge'] }]; writeConfigFile(cur); }
// 一个最小的本机 MCP 服务(stdio,官方 SDK):一个短名工具、一个桥接后超 64 字符的长名工具(DSH 会截断加哈希)。
// 每次被调用往 mcp-calls.txt 追加一行,用来数执行了几次。引擎启动时连上(handoffmcp 那一项用)。
const MCP_CALLS = join(R, 'mcp-calls.txt');
const MCP_LONG = 'record_a_very_long_named_observation_for_the_name_cap';
{
  const sdk = (p) => JSON.stringify(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', p));
  const srv = join(R, 'probe-mcp.mjs');
  writeFileSync(srv, `import { Server } from ${sdk('server/index.js')};
import { StdioServerTransport } from ${sdk('server/stdio.js')};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${sdk('types.js')};
import { appendFileSync } from 'node:fs';
const s = new Server({ name: 'probe', version: '0.0.0' }, { capabilities: { tools: {} } });
const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo_note', description: 'Probe only. Notes the text.', inputSchema: schema },
  { name: ${JSON.stringify(MCP_LONG)}, description: 'Probe only. Notes the text (long name).', inputSchema: schema },
] }));
s.setRequestHandler(CallToolRequestSchema, async (r) => { appendFileSync(${JSON.stringify(MCP_CALLS)}, r.params.name + ' ' + String(r.params.arguments?.text) + '\\n'); return { content: [{ type: 'text', text: 'noted: ' + String(r.params.arguments?.text) }] }; });
await s.connect(new StdioServerTransport());
`);
  const cur = readConfig(); cur.mcp = { mcpServers: { probe: { command: process.execPath, args: [srv] } } }; writeConfigFile(cur);
}
/** 打开 Historian(每轮都评、判官用假模型)跑 fn,跑完把原来那段放回去。 */
async function withHistorian(fn) {
  const cur = readConfig(); const prev = cur.specialAgents?.historian;
  cur.specialAgents = { ...(cur.specialAgents || {}), historian: { ...(prev || {}), enabled: true, everyRounds: 1, firstRoundTrigger: true, modelId: JUDGE_MODEL } };
  writeConfigFile(cur);
  try { return await fn(); } finally {
    const back = readConfig(); back.specialAgents = { ...(back.specialAgents || {}) };
    if (prev === undefined) delete back.specialAgents.historian; else back.specialAgents.historian = prev;
    writeConfigFile(back);
  }
}

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
/** 某一项要给引擎多带的环境(resident 那项用它挂测试插件),跑完置回空。 */
let engineExtraEnv = {};
async function startEngine() {
  const port = await new Promise((r) => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
  base = `http://127.0.0.1:${port}`;
  engine = spawn(process.execPath, [ENTRY, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(TANGU_HOME, 'state.db'), '--sandbox', 'auto', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN], {
    cwd: WS,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME, TMPDIR: TMP, TANGU_HOME, TANGU_DEFAULT_WORKSPACE: WS, TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0',
      FORSION_DESKTOP_CONFIG: join(R, 'userData', 'tangu-desktop-config.json'), LANG: 'en_US.UTF-8', ...(LIVE ? modelEnv : {}), ...engineExtraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = (d) => appendFileSync(LOG, LIVE_KEY ? String(d).split(LIVE_KEY).join('<key>') : d);
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
/** 起一轮并读事件到结束。cfg 并进 agent_config;onApproval(p) 回 'approve' | 'reject';stopOn(ev) 为真时按停止键。 */
async function run(sid, message, cfg = {}, { onApproval, stopOn, timeoutMs = 120_000, modelId = 'engine/dsh' } = {}) {
  const { runId } = await api('/agent/runs', { method: 'POST', body: JSON.stringify({ session_id: sid, model_id: modelId, message, agent_config: { engineId: 'dsh', execMode: 'host', cwd: WS, preset: null, ...cfg } }) });
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
/** 某场会话库里的消息行(只读):用户那一句落没落、回答记在谁名下。 */
const chatRows = async (sid) => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(join(TANGU_HOME, 'state.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT role, content, agent_slug FROM chat_messages WHERE session_id = ? ORDER BY timestamp, id').all(sid); } finally { db.close(); }
};
/** 一个 Agent 名下 Historian 写的东西:当天日志(LOG/<日期>.md)与记忆候选收件箱(.memory-raw.md)。 */
const agentDir = (slug) => join(TANGU_HOME, 'agents', slug);
const memoryTrail = (slug) => {
  const logDir = join(agentDir(slug), 'LOG');
  const logs = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(logDir, f), 'utf8')).join('\n') : '';
  const rawFile = join(agentDir(slug), '.memory-raw.md');
  return { logs, raw: existsSync(rawFile) ? readFileSync(rawFile, 'utf8') : '' };
};
const KESTREL_SAY = 'Remember the code word KESTREL-77. It is written on the shelf that holds the spare keys for the lab cabinet, next to the blue toolbox.';
/** 「由谁来跑」那一项的 Agent:建一个跑在 DSH 上的(走保存接口,顺带证 engine 字段收得下)。 */
const makeDshAgent = async (slug) => {
  await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name: 'DSH mate', systemPrompt: 'You are a test agent.', engine: 'dsh' }) });
  return (((await api('/agent/agents')).agents) || []).find((a) => a.slug === slug);
};

const results = [];
const record = (key, title, checks, note = '') => {
  const ok = checks.every((c) => c[1]);
  results.push({ key, title, ok, checks, note });
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${key} — ${title}`);
  for (const [name, pass, detail] of checks) console.log(`   ${pass ? '✓' : '✗'} ${name}${detail ? `:${clean(detail)}` : ''}`);
  if (note) console.log(`   · ${clean(note)}`);
};

// ── 常驻进程(融合插件第 1 档):一个测试插件替 dsh 登记常驻进程。它起的是官方包拼成的「网页界面 + 对话入口」同进程组合
//    (DSH_HOME/profiles/fusion,同方案目录 instrument/fusion-profile/ 再打开 agent-instructions 等几行),stdout 里不是 JSON 的行
//    (就绪行带网页界面的启动令牌)滤掉、只数条数,不落盘不打印。插件停用 / 引擎退出时把进程收掉。
const RESIDENT_PLUGIN_ROOT = join(R, 'resident-plugins');
const RESIDENT_ROUTE = '/extensions/resident-dsh-check/resident-dsh-check/state';
const FUSION_PATCH = `# dsh-engine.check.mjs resident 那项写的:同一个进程里既开网页界面,又开对话入口(ACP)。
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    publicUrl: !!js ctx.webStartup.publicUrl
    surfaceContext: true
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
    tls: !!js ctx.webStartup.tls
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
# 网页界面那份接线把这些关了、改由「预设」按会话挂;对话入口建的会话不挂预设,所以在全局重新打开
${['agent-instructions', 'tool-web', 'tool-todo', 'tool-workflow', 'workflow-ptc', 'command-goal', 'plan-mode', 'command-compact',
  'tool-goal', 'compaction-basic', 'tool-result-pruner', 'skill-filesystem', 'tool-skill', 'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork',
  ...(TOOLS_OFF ? [] : ['tool-bash', 'tool-jobs', 'tool-fs', 'tool-fs-search'])].map((id) => `- id: ${id}\n  disabled: false\n`).join('')}${TOOLS_OFF ? TOOLS_OFF_PATCH.split('\n').slice(1).join('\n') : ''}`;
function writeResidentFixture() {
  const prof = join(DSH_HOME, 'profiles', 'fusion'); mkdirSync(prof, { recursive: true });
  writeFileSync(join(prof, 'package.json'), JSON.stringify({ name: 'dsh-profile-fusion', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-acp-app'] } } }, null, 2));
  writeFileSync(join(prof, 'cordis.patch.yml'), FUSION_PATCH);
  const dir = join(RESIDENT_PLUGIN_ROOT, 'resident-dsh-check'); mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'tangu-plugin.json'), JSON.stringify({ id: 'resident-dsh-check', name: 'Resident DSH (check)', version: '1.0.0', apiVersion: 1, entry: 'dist/index.js' }));
  // 假模型模式下环境里只有假 key;真模型的 key(--key-file)不写进这份文件,插件从引擎自己的环境里拿
  writeFileSync(join(dir, 'resident.json'), JSON.stringify({ node: NODE, bin: BIN, cwd: WS, env: dshEnvOnDisk() }));
  writeFileSync(join(dir, 'dist', 'index.js'), `import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../resident.json', import.meta.url), 'utf8'));
let cur = null, n = 0, started = 0;
const events = [];
function start() {
  const env = { ...cfg.env };
  if (!env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  const child = spawn(cfg.node, [cfg.bin, '--profile', 'fusion'], { env, cwd: cfg.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = new PassThrough();
  const me = { child, id: child.pid + '-' + (++n), output, dropped: 0, web: false };
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trimStart().startsWith('{')) output.write(line + '\\n');
    else if (line.trim()) { me.dropped += 1; if (/https?:\\/\\/127\\.0\\.0\\.1:\\d+\\//.test(line)) me.web = true; } } });
  child.stdout.on('end', () => output.end());
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  me.closed = new Promise((r) => child.once('exit', () => { if (cur === me) cur = null; r(); }));
  started += 1; cur = me; return me;
}
const stop = () => { const c = cur; cur = null; if (c && c.child.exitCode === null) { c.child.kill('SIGTERM'); setTimeout(() => { if (c.child.exitCode === null) c.child.kill('SIGKILL'); }, 3000).unref(); } };
process.once('exit', () => { if (cur) cur.child.kill('SIGKILL'); });
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { if (cur) cur.child.kill('SIGKILL'); });
export default {
  activate(ctx) {
    ctx.registerPlugin({ id: 'resident-dsh-check', name: 'Resident DSH (check)', description: 'check:dsh fixture', defaultEnabled: true });
    ctx.registerResidentEngine({ engineId: 'dsh', connect: async () => { const c = cur || start(); return { id: c.id, input: c.child.stdin, output: c.output, closed: c.closed }; },
      onSession: (e) => { events.push(e.type); } });
    ctx.registerScopedRoutes((r) => {
      r.get('/state', (_q, res) => res.json({ pid: cur ? cur.child.pid : null, started, dropped: cur ? cur.dropped : 0, web: !!(cur && cur.web), events }));
      // 扮「装了插件 / 崩了,后台 DSH 重启」:引擎不动,只杀进程;下一轮宿主该连上新起的那个、续上同一场
      r.post('/restart', (_q, res) => { const c = cur; if (c) c.child.kill('SIGKILL'); res.json({ killed: !!c }); });
    });
  },
  deactivate() { stop(); },
};
`);
}
const fusionPids = () => dshPids().filter((l) => l.includes('--profile fusion')).map((l) => l.split(' ')[0]);
const sysText = (b) => (typeof b?.system === 'string' ? b.system : Array.isArray(b?.system) ? b.system.map((x) => x.text || '').join('\n') : '');
const engineLog = () => { try { return readFileSync(LOG, 'utf8'); } catch { return ''; } };

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
  // 停掉一轮之后把那一句改了重发:被弃掉的那一句不该还留在 DSH 的上文里。被停的那一轮在引擎库里什么都没留
  // (用户消息引擎这边不落库,回答还没有),认出「改写过」靠的是删消息入口记的那一次改写。
  stopedit: async () => {
    const sid = await newSession('stopedit');
    stub.script([{ text: 'Noted: the code word is SE-5.' }]); const a = await run(sid, 'Remember the code word SE-5.');
    const n0 = stub.mark(); stub.script([{ hang: true }]);
    const b = await run(sid, 'DISCARDED-PROMPT-7 remove the build folder.', {}, { stopOn: () => stub.mark() > n0 });
    // 客户端的「改了再发」:把被停的那一句和它的空占位的 id 交给删消息入口(这两条只在客户端有)
    await api(`/agent/sessions/${sid}/messages/delete`, { method: 'POST', body: JSON.stringify({ ids: ['client-only-user-message', 'client-only-placeholder'] }) });
    const n = stub.mark(); stub.script([{ text: 'fresh' }]); const c = await run(sid, 'REPLACEMENT-PROMPT-7 list the build folder.');
    const req = stub.since(n)[0]; const ps = await pointers(sid);
    record('stopedit', '停掉一轮后把那一句改了重发,DSH 不再记得被弃掉的那一句', [
      ['第一轮跑完、第二轮被停、第三轮跑完', a.done && b.aborted && c.done, `${a.error || ''} ${b.error || ''} ${c.error || ''}`],
      ['被弃掉的那一句不在请求里', !has(req, 'DISCARDED-PROMPT-7')],
      ['改写后的这一轮换了一个 DSH 会话', ps.length === 3 && !!ps[1].ext && !!ps[2].ext && ps[2].ext !== ps[1].ext, ps.map((p) => `${p.status}:${p.ext?.slice(0, 8)}`).join(' → ')],
    ], '改写后的这一轮是全新的 DSH 会话,连第一轮也不带(已知的限制)');
  },
  // 停掉一轮之后原样重试(客户端的「重试」也走删消息入口):同一句话再说一遍,没有被弃掉的东西,仍然接着原来的会话
  stopretry: async () => {
    const sid = await newSession('stopretry');
    stub.script([{ text: 'Noted: the code word is SR-6.' }]); const a = await run(sid, 'Remember the code word SR-6.');
    const n0 = stub.mark(); stub.script([{ hang: true }]);
    const b = await run(sid, 'RETRIED-PROMPT-8 what is the code word?', {}, { stopOn: () => stub.mark() > n0 });
    await api(`/agent/sessions/${sid}/messages/delete`, { method: 'POST', body: JSON.stringify({ ids: ['client-only-user-message', 'client-only-placeholder'] }) });
    const n = stub.mark(); stub.script([{ text: 'SR-6.' }]); const c = await run(sid, 'RETRIED-PROMPT-8 what is the code word?');
    const req = stub.since(n)[0]; const ps = await pointers(sid);
    record('stopretry', '停掉一轮后原样重试,仍然记得前面的', [
      ['第一轮跑完、第二轮被停、第三轮跑完', a.done && b.aborted && c.done, `${a.error || ''} ${b.error || ''} ${c.error || ''}`],
      ['重试的这一轮仍带着第一句', has(req, 'Remember the code word SR-6.')],
      ['三轮是同一个 DSH 会话', ps.length === 3 && !!ps[0].ext && ps.every((p) => p.ext === ps[0].ext), ps.map((p) => `${p.status}:${p.ext?.slice(0, 8)}`).join(' → ')],
    ]);
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
    // 放开后用户点的是「重试」:客户端先把失败的那一句交给删消息入口(截断重发),再原样发一遍
    await api(`/agent/sessions/${sid}/messages/delete`, { method: 'POST', body: JSON.stringify({ ids: ['client-only-user-message', 'client-only-placeholder'] }) });
    const n = stub.mark(); stub.script([{ text: 'BUSY-2.' }]); const c = await run(sid, 'What is the code word?');
    const req = stub.since(n)[0];
    record('busy', '会话被另一个 DSH 进程占着:照实失败,放开后接得上', [
      ['第一轮跑完', a.done, a.error || ''],
      ['另一个进程占住了它', !!held.result, JSON.stringify(held.error || '')],
      ['占着的时候这一轮失败,说明了原因', !!b.error && /another window or process/.test(b.error), b.error || '(没报错)'],
      ['失败的那一轮没有偷偷新开会话去问模型', !askedModel],
      ['放开后点重试,跑完并记得第一句', c.done && has(req, 'Remember the code word BUSY-2.'), c.error || ''],
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
  // 由谁来跑(底层第 2 步「身份合一」):一个设成 DSH 来跑的 Agent,在普通对话里选它(不带 engineId,model_id 是 Forsion 这边的模型,
  // 和输入框发的一样)—— 交给 DSH、Tangu 自己的循环一次没调;第二句记得第一句;用户那一句和回答都记在它名下;
  // Historian 的日志和记忆候选写进它的文件夹,缺省 Agent(xyra)那边什么都没多。另看自带的 DSH 在不在名册里。
  agent: async () => {
    const roster = ((await api('/agent/agents')).agents) || [];
    const builtin = roster.find((a) => a.slug === 'dsh');
    const mate = await makeDshAgent('dshmate');
    const before = memoryTrail('xyra');
    await withHistorian(async () => {
      const sid = await newSession('agent');
      const cfg = { engineId: undefined, agentSlug: 'dshmate' };
      const n0 = stub.mark(), j0 = stub.judged.length;
      // 第一句写长一点:Historian 自上次维护以来新增不到 120 个字符的一轮当琐碎轮跳过(产品规则),两句短话评不到
      stub.script([{ text: 'Noted: the code word is KESTREL-77, the label of the shelf with the spare keys for the lab cabinet.' }]);
      const a = await run(sid, `${KESTREL_SAY}`, cfg, { modelId: JUDGE_MODEL });
      const n1 = stub.mark(); stub.script([{ text: 'The code word is KESTREL-77.' }]);
      const b = await run(sid, 'What is the code word?', cfg, { modelId: JUDGE_MODEL });
      const req = stub.since(n1)[0]; const ps = await pointers(sid); const rows = await chatRows(sid);
      // Historian 在每轮结束后的后台跑:等日志和候选都写下(最多 40 秒)
      const trail = (await until(() => { const t = memoryTrail('dshmate'); return t.logs.includes('KESTREL-77') && t.raw.includes('KESTREL-77') ? t : null; }, 40_000, 500)) || memoryTrail('dshmate');
      const after = memoryTrail('xyra');
      const tanguLoop = stub.judged.slice(j0).filter((x) => Array.isArray(x?.tools) && x.tools.length > 0).length;
      record('agent', '设成 DSH 来跑的 Agent:交给 DSH、第二句记得第一句、记忆和日志记在它名下', [
        ['自带的 DSH 在名册里,由 DSH 来跑', builtin?.engine === 'dsh', builtin ? `engine=${builtin.engine}` : '名册里没有 dsh'],
        ['保存接口收下了「由 DSH 来跑」', mate?.engine === 'dsh', `engine=${mate?.engine}`],
        ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
        ['两轮都交给了 DSH,Tangu 自己的循环一次没调', stub.since(n0).length >= 2 && tanguLoop === 0, `DSH 请求 ${stub.since(n0).length} 次,Tangu 带工具的请求 ${tanguLoop} 次`],
        ['第二轮交给模型的请求里有第一句的原话', has(req, KESTREL_SAY)],
        ['两轮用的是同一个 DSH 会话', ps.length === 2 && !!ps[0].ext && ps[0].ext === ps[1].ext, ps.map((p) => p.ext?.slice(0, 8)).join(' → ')],
        ['用户那两句落了库', rows.filter((r) => r.role === 'user').map((r) => r.content).join(' | ') === `${KESTREL_SAY} | What is the code word?`, rows.filter((r) => r.role === 'user').length + ' 条'],
        ['回答记在它名下', rows.filter((r) => r.role === 'model').length === 2 && rows.filter((r) => r.role === 'model').every((r) => r.agent_slug === 'dshmate'), rows.filter((r) => r.role === 'model').map((r) => r.agent_slug).join(' / ')],
        ['Historian 的日志写在它的文件夹里', trail.logs.includes('KESTREL-77'), `判官被问了 ${stub.judged.length - j0} 次`],
        ['记忆候选写在它的文件夹里', trail.raw.includes('KESTREL-77')],
        ['缺省 Agent(xyra)那边什么都没多', after.logs === before.logs && after.raw === before.raw],
      ]);
    });
  },
  // 交接(底层第 3 步):设成 DSH 来跑的 Agent 在普通对话里,Forsion 的工具经桥交给 DSH,人设 / 记忆 / 技能写进指令目录。
  // 同一场对话三轮:① 桥里直接调 remember(卡片由 Forsion 按原名画、记忆记在它名下);② 审批规则要求 remember 先问,
  // 用户过了 50 秒才批 —— 桥在 45 秒回编号,模型用 forsion_wait 取到结果,工具只执行一次,DSH 的 60 秒时限一次没撞;
  // ③ 用户拒了 —— 模型拿到拒绝原因,记忆没写。另核:交给模型的工具里有桥的、没有和 DSH 自带重复的(读写文件 / 跑命令),
  // 指令目录里有人设、记忆、用户自己 ~/.agents 的 AGENTS.md,技能目录里链着它的技能和用户的技能。
  handoff: async () => {
    const SLUG = 'handmate', PERSONA = 'HANDOFF-PERSONA-41', SKILL = 'HANDOFF-SKILL-42', USER_SHARED = 'HANDOFF-USER-43', USER_SKILL = 'HANDOFF-USER-SKILL-44';
    const userRoot = join(HOME, '.agents');
    mkdirSync(join(userRoot, 'skills', 'user-probe'), { recursive: true });
    writeFileSync(join(userRoot, 'AGENTS.md'), `Shared note for every coding agent: ${USER_SHARED}.\n`);
    writeFileSync(join(userRoot, 'skills', 'user-probe', 'SKILL.md'), `---\nname: user-probe\ndescription: User probe skill ${USER_SKILL}. Use only when asked about the user probe.\n---\nNothing to do.\n`);
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: SLUG, name: 'Hand mate', systemPrompt: `You are a test agent. ${PERSONA}.`, engine: 'dsh' }) });
    mkdirSync(join(agentDir(SLUG), 'skills', 'handoff-probe'), { recursive: true });
    writeFileSync(join(agentDir(SLUG), 'skills', 'handoff-probe', 'SKILL.md'), `---\nname: handoff-probe\ndescription: Probe skill ${SKILL}. Use only when asked about the probe.\n---\nNothing to do.\n`);
    const memText = (slug) => { const f = join(agentDir(slug), 'MEMORY.md'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
    const count = (hay, needle) => hay.split(needle).length - 1;
    const lastMsg = (body) => JSON.stringify((body?.messages || []).slice(-1));
    const xyraBefore = memText('xyra');
    const sid = await newSession('handoff');
    const cfg = { engineId: undefined, agentSlug: SLUG };

    // ① 直接调
    const n0 = stub.mark();
    stub.script([{ tool: 'mcp__forsion__remember', args: { action: 'add', fact: 'The user drinks jasmine tea. HANDOFF-REM-51', scope: 'agent' } }, { text: 'Saved it.' }]);
    const a = await run(sid, 'Please remember that I drink jasmine tea.', cfg, { modelId: JUDGE_MODEL });
    const reqA = stub.since(n0); const firstA = reqA[0] || {};
    const toolNames = (firstA.tools || []).map((t) => t.name);
    const native = toolNames.filter((n) => !n.startsWith('mcp__'));
    const bridged = (firstA.tools || []).filter((t) => t.name.startsWith('mcp__forsion__'));
    const bridgedBytes = Buffer.byteLength(JSON.stringify(bridged));
    const allToolBytes = Buffer.byteLength(JSON.stringify(firstA.tools || []));
    const dup = bridged.map((t) => t.name.slice('mcp__forsion__'.length)).filter((n) => ['read_file', 'write_file', 'edit_file', 'run_bash', 'list_dir', 'grep', 'glob', 'apply_patch', 'git_commit', 'kill_process', 'browser_task', 'computer_use', 'desk_screenshot', 'manage_automation', 'use_skill', 'load_tools'].includes(n));
    const homeDir = join(TANGU_HOME, 'engines', 'dsh', 'agents', sid);
    const agentsMd = existsSync(join(homeDir, 'AGENTS.md')) ? readFileSync(join(homeDir, 'AGENTS.md'), 'utf8') : '';
    const skillLinks = existsSync(join(homeDir, 'skills')) ? readdirSync(join(homeDir, 'skills')) : [];
    const msgsA = await messages(sid); const modelA = msgsA.filter((m) => m.role === 'model' || m.role === 'assistant').slice(-1)[0] || {};
    record('handoff', '交接:Forsion 的工具经桥直接调,卡片由 Forsion 画,记忆记在它名下;人设、技能、用户共用指令都交过去了', [
      ['这一轮跑完', a.done, a.error || ''],
      ['卡片按 Tangu 原名画(remember),不出现 mcp__forsion__ 那张', a.tools.some((t) => t.name === 'remember') && !a.tools.some((t) => String(t.name).startsWith('mcp__')), a.tools.map((t) => t.name).join(', ')],
      ['工具结果成功', a.results.some((r) => r.name === 'remember' && !r.isError), a.results.map((r) => `${r.name}:${r.isError ? 'err' : 'ok'}`).join(', ')],
      ['记忆写在它名下(执行了一次)、缺省 Agent 那边没多', count(memText(SLUG), 'HANDOFF-REM-51') === 1 && memText('xyra') === xyraBefore, `它名下 ${count(memText(SLUG), 'HANDOFF-REM-51')} 处`],
      ['交给模型的工具里有桥的 remember 与 forsion_wait', toolNames.includes('mcp__forsion__remember') && toolNames.includes('mcp__forsion__forsion_wait'), `桥 ${bridged.length} 个 / 全部 ${toolNames.length} 个`],
      ['和 DSH 自带重复的、截图类、循环内的没交', dup.length === 0, dup.join(', ')],
      ...(TOOLS_OFF ? [['--dsh-tools-off:DSH 自带的读写文件 / 搜文件 / 跑命令 / 后台任务一个都不在交给模型的工具里', !native.some((n) => NATIVE_DISK_TOOLS.includes(n)), native.filter((n) => NATIVE_DISK_TOOLS.includes(n)).join(', ')]] : []),
      ['人设进了模型的上下文', JSON.stringify(firstA).includes(PERSONA)],
      ['它的技能和用户共用根里的技能都进了模型的上下文', JSON.stringify(firstA).includes(SKILL) && JSON.stringify(firstA).includes(USER_SKILL)],
      ['用户自己 ~/.agents 的 AGENTS.md 并进来了', JSON.stringify(firstA).includes(USER_SHARED)],
      ['指令目录里技能是链接(它的 + 用户的)', skillLinks.includes('handoff-probe') && skillLinks.includes('user-probe'), skillLinks.join(', ')],
      ['落库的回答带着这次工具调用(重开对话卡片还在)', JSON.stringify(modelA).includes('HANDOFF-REM-51') && JSON.stringify(modelA).includes('remember'), Object.keys(modelA).join(',')],
    ], `桥的工具描述 ${bridgedBytes} 字节,全部工具 ${allToolBytes} 字节;AGENTS.md ${Buffer.byteLength(agentsMd)} 字节;桥的工具:${bridged.map((t) => t.name.slice('mcp__forsion__'.length)).join(' ')};DSH 自带的:${native.join(' ')}`);

    // ② 审批过了时限:规则要求 remember 先问,用户 50 秒后才批
    const prevCfg = readConfig(); const prevApproval = prevCfg.approval;
    writeConfigFile({ ...prevCfg, approval: { base: 'auto-edit', ask: ['remember'] } });
    try {
      const n1 = stub.mark(); const t1 = Date.now();
      stub.script([
        { tool: 'mcp__forsion__remember', args: { action: 'add', fact: 'The user keeps a cat named Miso. HANDOFF-REM-52', scope: 'agent' } },
        { tool: 'mcp__forsion__forsion_wait', args: { ticket: 'T1', attempt: 1 } },
        { text: 'Saved after you approved.' },
      ]);
      const b = await run(sid, 'Please remember my cat Miso.', { ...cfg, approvalMode: 'custom' }, { modelId: JUDGE_MODEL, timeoutMs: 180_000, onApproval: async () => { await sleep(50_000); return 'approve'; } });
      const secs = (Date.now() - t1) / 1000; const reqB = stub.since(n1);
      const all = JSON.stringify(reqB);
      record('handoffwait', '交接:审批等过了 45 秒,桥先回编号,模型用 forsion_wait 取到结果;只执行一次,DSH 的 60 秒时限没撞', [
        ['这一轮跑完', b.done, b.error || ''],
        ['来问了一次审批,卡上是 remember', b.approvals.length === 1 && b.approvals[0].name === 'remember', b.approvals.map((x) => x.name).join(', ')],
        ['第一次调用回的是编号', /ticket T1/.test(lastMsg(reqB[1])) && /waiting for the user to approve/.test(lastMsg(reqB[1])), clean(lastMsg(reqB[1])).slice(0, 200)],
        ['forsion_wait 取到了结果(不是又一个编号)', !!reqB[2] && !/Pending:|ticket T1/.test(lastMsg(reqB[2])), clean(lastMsg(reqB[2])).slice(0, 200)],
        ['工具只执行了一次', count(memText(SLUG), 'HANDOFF-REM-52') === 1, `${count(memText(SLUG), 'HANDOFF-REM-52')} 处`],
        ['模型一次也没收到超时', !/timed out/i.test(all)],
        ['等了 50 秒以上(真的过了时限)', secs >= 50, `${secs.toFixed(1)} 秒`],
      ]);

      // ③ 拒绝
      const n2 = stub.mark();
      stub.script([{ tool: 'mcp__forsion__remember', args: { action: 'add', fact: 'The user dislikes coffee. HANDOFF-REM-53', scope: 'agent' } }, { text: 'Understood, not saved.' }]);
      const c = await run(sid, 'Remember that I dislike coffee.', { ...cfg, approvalMode: 'custom' }, { modelId: JUDGE_MODEL, onApproval: () => 'reject' });
      const reqC = stub.since(n2);
      const ps = await pointers(sid);
      record('handoffreject', '交接:用户拒了桥里的工具,模型拿到拒绝原因,记忆没写;三轮是同一个 DSH 会话', [
        ['这一轮跑完', c.done, c.error || ''],
        ['来问了一次审批', c.approvals.length === 1],
        ['模型拿到的是拒绝', /denied|reject/i.test(lastMsg(reqC[1])), clean(lastMsg(reqC[1])).slice(0, 200)],
        ['记忆没写', count(memText(SLUG), 'HANDOFF-REM-53') === 0],
        ['卡片记成出错', c.results.some((r) => r.name === 'remember' && r.isError)],
        ['三轮续的是同一个 DSH 会话', ps.length === 3 && !!ps[0].ext && ps.every((x) => x.ext === ps[0].ext), ps.map((x) => x.ext?.slice(0, 8)).join(' → ')],
        ['指令目录在第二轮前按新记忆重写了', existsSync(join(homeDir, 'AGENTS.md')) && readFileSync(join(homeDir, 'AGENTS.md'), 'utf8').includes('HANDOFF-REM-51')],
      ]);
    } finally {
      const back = readConfig(); if (prevApproval === undefined) delete back.approval; else back.approval = prevApproval; writeConfigFile(back);
    }

    // ④ 委派:桥里调 delegate,起的是 Tangu 自己的子代理(用这一轮 Forsion 这边的模型),结论回到 DSH
    const sid2 = await newSession('handoff-delegate');
    const n3 = stub.mark(), j3 = stub.judged.length;
    stub.script([{ tool: 'mcp__forsion__delegate', args: { task: 'Reply with the single word OK.' } }, { text: 'Delegated.' }]);
    const d = await run(sid2, 'Delegate a tiny task.', cfg, { modelId: JUDGE_MODEL, timeoutMs: 180_000 });
    const reqD = stub.since(n3);
    record('handoffdelegate', '交接:桥里调 delegate,Tangu 的子代理跑完,结论回到 DSH', [
      ['这一轮跑完', d.done, d.error || ''],
      ['卡片是 delegate、成功', d.results.some((r) => r.name === 'delegate' && !r.isError), d.results.map((r) => `${r.name}:${r.isError ? 'err' : 'ok'} ${r.result.slice(0, 80)}`).join(' | ')],
      ['子代理用的是 Forsion 这边的模型(假模型的 OpenAI 口被调过)', stub.judged.length > j3, `${stub.judged.length - j3} 次`],
      ['结论交回给了 DSH 的模型', !!reqD[1] && /OK/.test(lastMsg(reqD[1])) && !/Error:/.test(lastMsg(reqD[1])), clean(lastMsg(reqD[1])).slice(0, 200)],
    ]);
  },
  // 交接 × Agent 勾的 MCP:走桥(不直接交给 DSH),审批和卡片照 Forsion 的来。名字桥接后是 mcp__forsion__mcp__probe__<工具>;
  // 超 64 字符的那个 DSH 会截断加哈希 —— 前缀还在,DSH 那张卡照样藏得住。自动编辑档下 MCP 工具要问。
  handoffmcp: async () => {
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'mcpmate', name: 'MCP mate', systemPrompt: 'You are a test agent.', engine: 'dsh' }) });
    const sid = await newSession('handoff-mcp');
    const n0 = stub.mark();
    const longName = (body) => (body.tools || []).map((t) => t.name).find((n) => n.startsWith('mcp__forsion__mcp__probe__record_')) || 'not-listed';
    stub.script([
      { tool: 'mcp__forsion__mcp__probe__echo_note', args: { text: 'MCP-PING-61' } },
      { tool: longName, args: { text: 'MCP-PING-62' } },
      { text: 'Both noted.' },
    ]);
    const r = await run(sid, 'Note two things with the probe tools.', { engineId: undefined, agentSlug: 'mcpmate' }, { modelId: JUDGE_MODEL, onApproval: () => 'approve' });
    const req = stub.since(n0); const names = (req[0]?.tools || []).map((t) => t.name);
    const hashed = names.find((n) => n.startsWith('mcp__forsion__mcp__probe__record_')) || '';
    const calls = existsSync(MCP_CALLS) ? readFileSync(MCP_CALLS, 'utf8').trim().split('\n').filter(Boolean) : [];
    // Tangu 自己的桥接名也封顶 64 字符(长名在 Tangu 这边就被截了),所以长名按前缀认
    const isTangu = (n) => n === 'mcp__probe__echo_note' || String(n).startsWith('mcp__probe__record_a_very_long');
    record('handoffmcp', '交接:Agent 勾的 MCP 走桥,模型拿得到(长名被 DSH 截断加哈希也行),卡片按 Forsion 的名字只画一张,自动编辑档下来问', [
      ['这一轮跑完', r.done, r.error || ''],
      ['交给模型的工具里有这两个 MCP 工具', names.includes('mcp__forsion__mcp__probe__echo_note') && !!hashed, `长名在 DSH 那边叫 ${hashed || '(没有)'}(${hashed.length} 字符)`],
      ['长名被 DSH 截断加了哈希,前缀还在', hashed.length === 64 && /_[0-9a-f]{12}$/.test(hashed)],
      ['两次都来问了审批,卡上是 Forsion 的名字', r.approvals.length === 2 && r.approvals.every((a) => isTangu(a.name)), r.approvals.map((a) => a.name).join(' / ')],
      ['卡片按 Forsion 的名字各一张,没有 mcp__forsion__ 那张', r.tools.length === 2 && r.tools.every((t) => isTangu(t.name)) && r.tools[0].name !== r.tools[1].name, r.tools.map((t) => t.name).join(' / ')],
      ['两个都成功', r.results.length === 2 && r.results.every((x) => !x.isError && /noted: MCP-PING-6[12]/.test(x.result)), r.results.map((x) => `${x.name}:${x.isError ? 'err' : 'ok'}`).join(', ')],
      ['MCP 服务各只执行了一次', calls.length === 2 && calls.some((l) => l.includes('MCP-PING-61')) && calls.some((l) => l.includes('MCP-PING-62')), calls.join(' | ')],
    ]);

    // 审批档取 Agent 自己设的:这一轮不带档、会话也没存档时,设成完全通行的 Agent 调同一个 MCP 工具不来问(同 Tangu 循环:缺了才用 Agent 定义的)
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'mcpauto', name: 'MCP auto', systemPrompt: 'You are a test agent.', engine: 'dsh', approvalMode: 'full-auto' }) });
    const saved = ((((await api('/agent/agents')).agents) || []).find((a) => a.slug === 'mcpauto') || {}).approvalMode;
    const sid2 = await newSession('handoff-mcp-auto');
    stub.script([{ tool: 'mcp__forsion__mcp__probe__echo_note', args: { text: 'MCP-PING-63' } }, { text: 'Noted.' }]);
    const a = await run(sid2, 'Note one thing with the probe tool.', { engineId: undefined, agentSlug: 'mcpauto' }, { modelId: JUDGE_MODEL, onApproval: () => 'approve' });
    record('handoffmcpmode', '交接:审批档取 Agent 自己设的(这一轮不带档时);设成完全通行的 Agent 调 MCP 工具不来问', [
      ['保存接口收下了完全通行', saved === 'full-auto', `approvalMode=${saved}`],
      ['这一轮跑完', a.done, a.error || ''],
      ['没来问审批', a.approvals.length === 0, `${a.approvals.length} 次`],
      ['工具成功', a.results.some((x) => x.name === 'mcp__probe__echo_note' && !x.isError), a.results.map((x) => `${x.name}:${x.isError ? 'err' : 'ok'}`).join(', ')],
    ]);
  },
  // 常驻进程(融合插件第 1 档):测试插件替 dsh 登记一个「网页界面 + 对话入口」同进程的官方 DSH。Forsion 的对话连它、不每轮起进程;
  // 人设 / 记忆 / 技能目录走每场会话那座桥的说明;一轮结束会话不关(工作台要接得上);交接内容变了才关掉重接;
  // 工作台打开前先替它接上(hold);引擎重启后照存下的那份接上;插件不在了照旧每轮起一个进程、续的还是同一场。
  resident: async () => {
    writeResidentFixture();
    const SLUG = 'resmate', PERSONA = 'RESIDENT-PERSONA-70', SKILL_DESC = 'RES-SKILL-72', SKILL_BODY = 'RES-SKILL-BODY-73', USER_SHARED = 'RES-USER-74';
    mkdirSync(join(HOME, '.agents'), { recursive: true });
    writeFileSync(join(HOME, '.agents', 'AGENTS.md'), `Shared note for every coding agent: ${USER_SHARED}.\n`);
    const memText = () => { const f = join(agentDir(SLUG), 'MEMORY.md'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
    const lastMsg = (body) => JSON.stringify((body?.messages || []).slice(-1));
    const logSince = (n) => engineLog().slice(n);
    const pluginState = () => api(RESIDENT_ROUTE).catch((e) => ({ error: e.message }));
    await stopEngine(); engineExtraEnv = { TANGU_PLUGINS: 'on', TANGU_PLUGINS_DIR: RESIDENT_PLUGIN_ROOT }; await startEngine();
    try {
      const list = (await api('/agent/engines')).engines || [];
      await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: SLUG, name: 'Resident mate', systemPrompt: `You are a test agent. ${PERSONA}.`, engine: 'dsh' }) });
      mkdirSync(join(agentDir(SLUG), 'skills', 'res-probe'), { recursive: true });
      writeFileSync(join(agentDir(SLUG), 'skills', 'res-probe', 'SKILL.md'), `---\nname: res-probe\ndescription: Probe skill ${SKILL_DESC}. Use only when asked about the probe.\n---\n${SKILL_BODY}: nothing to do.\n`);
      const caps = await api('/agent/engines/dsh/capabilities?fresh=1');
      const afterCaps = fusionPids();
      const sid = await newSession('resident');
      const cfg = { engineId: undefined, agentSlug: SLUG };

      // ① 第一轮:新建会话,桥带说明;调桥里的 remember
      let L = engineLog().length; const n0 = stub.mark();
      stub.script([{ tool: 'mcp__forsion__remember', args: { action: 'add', fact: 'The user grows basil. RES-REM-71', scope: 'agent' } }, { text: 'Saved.' }]);
      const a = await run(sid, 'Please remember that I grow basil.', cfg, { modelId: JUDGE_MODEL });
      const reqA = stub.since(n0); const firstA = reqA[0] || {};
      const pidsA = fusionPids(); const st = await pluginState();
      const homeDir = join(TANGU_HOME, 'engines', 'dsh', 'agents', sid);
      const ps1 = await pointers(sid);
      record('resident', '常驻进程:对话连插件起的那个进程(网页界面 + 对话入口同进程),人设 / 技能目录走桥上的说明,工具经桥、卡片照 Forsion 画', [
        ['引擎清单里 dsh 是可用的', list.some((e) => e.id === 'dsh' && e.available), JSON.stringify(list.find((e) => e.id === 'dsh') || {})],
        ['模型清单在常驻进程上探出来了(没另起进程)', (caps.models || []).length > 0 && afterCaps.length === 1, `${(caps.models || []).length} 个模型,fusion 进程 ${afterCaps.length} 个`],
        ['这一轮跑完', a.done, a.error || ''],
        ['只有一个常驻 DSH 进程,网页界面也起来了', pidsA.length === 1 && st.web === true && st.started === 1, `进程 ${pidsA.length} 个,起过 ${st.started} 次,网页界面 ${st.web}`],
        ['stdout 里不是 JSON 的行被插件滤掉了(就绪行)', st.dropped >= 1, `${st.dropped} 行`],
        ['日志里没有启动令牌', !/token=[A-Za-z0-9]/.test(engineLog()), ''],
        ['人设在系统提示里(桥的说明)', sysText(firstA).includes(PERSONA)],
        ['技能目录在系统提示里(名字 + 描述)', sysText(firstA).includes('res-probe') && sysText(firstA).includes(SKILL_DESC)],
        ['用户自己 ~/.agents 的 AGENTS.md 由 DSH 自己读进来了', JSON.stringify(firstA).includes(USER_SHARED)],
        ['桥上有 remember 和 forsion_skill', (firstA.tools || []).some((t) => t.name === 'mcp__forsion__remember') && (firstA.tools || []).some((t) => t.name === 'mcp__forsion__forsion_skill')],
        // 融合组合为了对话入口把读写 / 命令这几行重新打开了;--dsh-tools-off 要管得到常驻进程(真模型跑常驻场景靠它)。两个方向都核:
        // 不带时它们在(开关是真的),带了就一个都不在
        TOOLS_OFF
          ? ['--dsh-tools-off:常驻进程交给模型的工具里没有 DSH 自带的读写文件 / 搜文件 / 跑命令 / 后台任务', !(firstA.tools || []).some((t) => NATIVE_DISK_TOOLS.includes(t.name)), (firstA.tools || []).map((t) => t.name).filter((x) => NATIVE_DISK_TOOLS.includes(x)).join(', ')]
          : ['不带 --dsh-tools-off 时,融合组合给了 DSH 自带的读写文件和跑命令(上面那个开关关的是真东西)', ['read', 'write', 'bash'].every((x) => (firstA.tools || []).some((t) => t.name === x)), (firstA.tools || []).map((t) => t.name).filter((x) => !x.startsWith('mcp__')).join(', ')],
        ['卡片按 Tangu 原名画(remember)、成功', a.tools.some((t) => t.name === 'remember') && a.results.some((r) => r.name === 'remember' && !r.isError), a.results.map((r) => `${r.name}:${r.isError ? 'err' : 'ok'}`).join(', ')],
        ['记忆写在它名下', memText().includes('RES-REM-71')],
        ['没写指令目录(常驻进程不用 DSH_AGENTS_HOME)', !existsSync(homeDir)],
        ['新建了一场 DSH 会话', /resident session [0-9a-f-]{8}: new/.test(logSince(L)) && !!ps1[0]?.ext, ps1.map((x) => x.ext?.slice(0, 8)).join(',')],
      ], `桥的说明 ${(/bridge-instructions=(\d+)B/.exec(logSince(L)) || [])[1] || '?'} 字节`);

      // ② 记忆变了 → 交接内容变了 → 关掉重接(新说明带上新记忆);调 forsion_skill 读技能
      L = engineLog().length; const n1 = stub.mark();
      stub.script([{ tool: 'mcp__forsion__forsion_skill', args: { name: 'res-probe' } }, { text: 'Read it.' }]);
      const b = await run(sid, 'Open the probe skill.', cfg, { modelId: JUDGE_MODEL });
      const reqB = stub.since(n1); const pidsB = fusionPids(); const ps2 = await pointers(sid); const stB = await pluginState();
      record('residentreopen', '常驻进程:交接内容变了(新记忆)才关掉重接,新说明带上新记忆;技能经 forsion_skill 读到;同一个进程、同一场会话', [
        ['这一轮跑完', b.done, b.error || ''],
        ['日志:因交接变了重接', /resident session [0-9a-f-]{8}: reopened \(handoff changed\)/.test(logSince(L))],
        ['插件收到了「关掉重接」(工作台据此重载那一页)', (stB.events || []).includes('reopened'), JSON.stringify(stB.events)],
        ['新记忆在这一轮的系统提示里', sysText(reqB[0]).includes('RES-REM-71')],
        ['forsion_skill 回的是 SKILL.md 正文', !!reqB[1] && lastMsg(reqB[1]).includes(SKILL_BODY), clean(lastMsg(reqB[1])).slice(0, 160)],
        ['还是同一个进程', pidsB.length === 1 && pidsB[0] === pidsA[0], `${pidsA.join(',')} → ${pidsB.join(',')}`],
        ['还是同一场 DSH 会话', ps2.length === 2 && ps2[1].ext === ps2[0].ext, ps2.map((x) => x.ext?.slice(0, 8)).join(' → ')],
      ]);

      // ③ 什么都没变 → 会话一直开着,接着用;上文还在
      L = engineLog().length; const n2 = stub.mark();
      stub.script([{ text: 'Plain answer.' }]);
      const c = await run(sid, 'What did I ask you first?', cfg, { modelId: JUDGE_MODEL });
      const reqC = stub.since(n2);
      const held = await api('/agent/engines/dsh/hold', { method: 'POST', body: JSON.stringify({ sessionId: sid }) }).catch((e) => ({ error: e.message }));
      record('residentkeep', '常驻进程:交接没变就不重接(会话一直开着,工作台里开着的那一场不受影响);工作台打开前 hold 回「开着」', [
        ['这一轮跑完', c.done, c.error || ''],
        ['日志:会话一直开着', /resident session [0-9a-f-]{8}: kept open/.test(logSince(L)) && !/reopened|: resumed/.test(logSince(L))],
        ['上文还在(第一句在请求里)', JSON.stringify(reqC[0] || {}).includes('grow basil')],
        ['hold 回 open(本来就开着)', held.state === 'open', JSON.stringify(held)],
      ]);

      // ③b 后台 DSH 自己重启了(装插件、崩了),引擎不动:下一轮连上新起的那个、续上同一场,说明照旧带上
      const crashPid = fusionPids()[0];
      await api(RESIDENT_ROUTE.replace(/state$/, 'restart'), { method: 'POST', body: '{}' });
      await until(() => !fusionPids().includes(crashPid), 8000, 200);
      L = engineLog().length; const n2b = stub.mark();
      stub.script([{ text: 'New process.' }]);
      const cb = await run(sid, 'Still there after DSH restarted?', cfg, { modelId: JUDGE_MODEL });
      const reqCb = stub.since(n2b); const pidsCb = fusionPids(); const psCb = await pointers(sid); const stCb = await pluginState();
      record('residentcrash', '常驻进程:后台 DSH 自己重启(引擎不动),下一轮连上新进程、续上同一场,人设照旧', [
        ['这一轮跑完', cb.done, cb.error || ''],
        ['旧进程没了、新进程一个', !pidsCb.includes(crashPid) && pidsCb.length === 1 && stCb.started === 2, `${crashPid} → ${pidsCb.join(',')},起过 ${stCb.started} 次`],
        ['日志:续接(不是新建)', /resident session [0-9a-f-]{8}: resumed/.test(logSince(L)) && !/: new/.test(logSince(L))],
        ['还是同一场', psCb.length === 4 && psCb.every((x) => x.ext === psCb[0].ext), psCb.map((x) => x.ext?.slice(0, 8)).join(' → ')],
        ['人设和记忆在系统提示里', sysText(reqCb[0]).includes(PERSONA) && sysText(reqCb[0]).includes('RES-REM-71')],
      ]);

      // ④ 引擎重启(Forsion 退出再开):插件起新进程;hold 照存下的那份接上;下一轮指纹对得上、不再重接
      const oldPid = fusionPids()[0];
      await stopEngine(); await until(() => !fusionPids().includes(oldPid), 8000, 200);
      const oldGone = !fusionPids().includes(oldPid);
      await startEngine();
      L = engineLog().length;
      const held2 = await api('/agent/engines/dsh/hold', { method: 'POST', body: JSON.stringify({ sessionId: sid }) }).catch((e) => ({ error: e.message }));
      const holdLog = logSince(L);
      L = engineLog().length; const n3 = stub.mark();
      stub.script([{ text: 'Back again.' }]);
      const d = await run(sid, 'Are you there after the restart?', cfg, { modelId: JUDGE_MODEL });
      const reqD = stub.since(n3); const pidsD = fusionPids(); const ps4 = await pointers(sid);
      const wrongSid = await api('/agent/engines/dsh/hold', { method: 'POST', body: JSON.stringify({ sessionId: 'no-such-session' }) }).then(() => 'ok', (e) => e.message);
      record('residentrestart', '常驻进程:Forsion 退出时进程跟着退;再开后 hold 照存下的说明接上,下一轮不再重接、人设还在', [
        ['旧进程退了', oldGone],
        ['hold 回 resumed', held2.state === 'resumed', JSON.stringify(held2)],
        ['hold 用的是存下的说明', /held for the workbench/.test(holdLog) && !/no saved handoff/.test(holdLog)],
        ['这一轮跑完', d.done, d.error || ''],
        ['日志:会话一直开着(指纹对得上)', /resident session [0-9a-f-]{8}: kept open/.test(logSince(L))],
        ['人设和新记忆还在系统提示里', sysText(reqD[0]).includes(PERSONA) && sysText(reqD[0]).includes('RES-REM-71')],
        ['新进程只有一个', pidsD.length === 1 && pidsD[0] !== oldPid, pidsD.join(',')],
        ['续的还是同一场', ps4.length === 5 && ps4.every((x) => x.ext === ps4[0].ext), ps4.map((x) => x.ext?.slice(0, 8)).join(' → ')],
        ['插件收到了「替工作台接上」', ((await pluginState()).events || []).includes('held')],
        ['hold 一场不存在的对话 → 404', /404/.test(wrongSid), wrongSid],
      ]);

      // ⑤ 插件不在了:照旧每轮起一个进程,续的还是同一场;人设改走指令目录
      const pidE = pidsD[0];
      await stopEngine(); await until(() => !fusionPids().includes(pidE), 8000, 200);
      engineExtraEnv = {}; await startEngine();
      const n4 = stub.mark();
      stub.script([{ text: 'Per-turn again.' }]);
      const e = await run(sid, 'And now without the plugin?', cfg, { modelId: JUDGE_MODEL });
      const reqE = stub.since(n4); const ps5 = await pointers(sid);
      record('residentfallback', '常驻进程:插件不在了照旧每轮起一个进程,续的还是同一场;人设改走指令目录', [
        ['这一轮跑完', e.done, e.error || ''],
        ['没有常驻进程', fusionPids().length === 0, fusionPids().join(',')],
        ['续的还是同一场', ps5.length === 6 && ps5[5].ext === ps5[0].ext, ps5.map((x) => x.ext?.slice(0, 8)).join(' → ')],
        ['人设进了模型的上下文', JSON.stringify(reqE[0] || {}).includes(PERSONA)],
        ['写了指令目录', existsSync(homeDir)],
      ]);
    } finally {
      if (Object.keys(engineExtraEnv).length) { engineExtraEnv = {}; await stopEngine(); await startEngine(); }
    }
  },
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
  // 当前模型那条线要 API key 而没有配:失败原因要换成点名当前模型、说得出下一步的那句话,不是只有 DSH 的原话。
  // 实际遇到的是「只用账号登录的 DSH」:新会话的缺省模型走要 key 的那条线,不选模型每一句都失败(2026-11-14 真模型实跑)。
  // 账号登录在这里造不出来,用一份什么凭据都没有的 DSH 出同一个错 —— 这时清单里没有别的模型,提示走「去 DSH 里登录或填 key」
  // 那一支;「清单里有另一组的模型」那一支在单测里(src/engines/acpEngine.credential.test.ts,照这里实测到的样子写的假 agent)。
  nokey: async () => {
    const caps = await api('/agent/engines/dsh-nokey/capabilities');
    const names = (caps.models || []).map((m) => m.name);
    const sid = await newSession('nokey');
    const a = await run(sid, 'Say OK.', { engineId: 'dsh-nokey' });
    const again = await run(sid, 'Say OK.', { engineId: 'dsh-nokey' });
    const ps = await pointers(sid);
    const err = a.error || '';
    record('nokey', '当前模型缺 API key 时,失败原因说得出下一步', [
      // 提示分两支靠的是这一条:DSH 只列凭据探得到的模型,当前模型单独塞进清单。它哪天改成不管有没有凭据都列,这里先红。
      ['没有凭据时,清单里只有当前模型自己', names.length === 1 && (caps.models || [])[0]?.id === caps.currentModelId, names.join(' / ')],
      ['这一轮失败了(没有 key,到不了模型)', !a.done && !!a.error && !a.aborted, err],
      ['失败原因以固定的码开头', err.startsWith('engine_model_no_api_key {')],
      ['点名了引擎和当前模型', err.includes(`DeepSeek Harness (no key) needs an API key for its current model (${JSON.stringify(names[0] ?? '')}) and none is set up.`)],
      ['没有别的模型可换:说的是去 DSH 里登录或填 key,不叫人换模型', err.includes('It offers no other model: sign in or add an API key in DeepSeek Harness (no key) itself, then send again.') && !err.includes('Pick another model')],
      ['DSH 的原话留在最后的方括号里', /\[Internal error: turn failed: .*no API key for provider route "deepseek-official".*\]$/.test(err)],
      ['再发一句还是同一个原因、接的是同一个 DSH 会话(没有悄悄新开)', again.error === a.error && ps.length === 2 && !!ps[0].ext && ps[0].ext === ps[1].ext, ps.map((p) => p.ext?.slice(0, 8)).join(' → ')],
    ]);
  },
};

// ── 真模型那一套:看的是模型自己的回答(假模型那套看的是交给模型的请求)。暗号每次现编,模型猜不到。
const codeWord = (prefix) => `${prefix}-${1000 + Math.floor(Math.random() * 9000)}`;
// DSH 的 agent 有 shell,缺省能读整块盘:答不上来的问题它会自己去翻(2026-11-14 实跑:对照那一问它翻了测试库和本脚本的
// 输出,还列了项目里别的目录)。所以每一问都写明只凭上文、不许用工具,并且把「这一问用没用工具」记进判据 —— 用了工具,
// 答对答错都不作数(答案可能是从盘上翻来的)。
const NO_TOOLS = 'Answer only from what was said in this conversation. Do not use any tools, do not read files, do not run commands.';
const ASK = `${NO_TOOLS} What code word did I ask you to remember? Reply with just the code word, or NONE if I never gave you one.`;
const ASK_ALL = `${NO_TOOLS} List every code word I asked you to remember in this conversation. Reply with just the code words, or NONE.`;
const REMEMBER = (word, extra = '') => `Remember this code word for later: ${word}. ${extra}Do not use any tools. Reply with just: OK`;
const noTools = (r) => ['这一问没有动用工具(答案只能来自上文)', r.tools.length === 0, r.tools.length ? `用了 ${r.tools.length} 次:${[...new Set(r.tools.map((t) => t.name))].join(' / ')}` : ''];
const said = (r) => `模型原话:${(r.text || '').trim().replace(/\s+/g, ' ').slice(0, 200) || '(空)'}`;
const LIVE_MS = 180_000;
let liveModel = null; // --model 选中的那个(caps 之后定)
const routeOf = (m) => { try { const v = JSON.parse(m.id); return Array.isArray(v) ? v[0] : undefined; } catch { return undefined; } }; // 只是台架为了挑「同一条线上的另一个模型」
const liveRun = (sid, message, cfg = {}, o = {}) => run(sid, message, { ...(liveModel ? { engineModelId: liveModel.id } : {}), ...cfg }, { timeoutMs: LIVE_MS, ...o });
/** 发一句注定很长的话,模型开始回答(或过了几秒)就按停止键。 */
const stoppedTurn = async (sid, message) => {
  const n0 = stub.mark(), t0 = Date.now();
  return liveRun(sid, message, {}, { stopOn: (ev) => ev.text.length > 20 || (LIVE_DRY ? stub.mark() > n0 : Date.now() - t0 > 10_000) });
};
const truncate = (sid, ids) => api(`/agent/sessions/${sid}/messages/delete`, { method: 'POST', body: JSON.stringify({ ids }) });
const LIVE_SCENARIOS = {
  caps: async () => {
    const caps = await SCENARIOS.caps();
    if (LIVE_MODEL) {
      liveModel = (caps.models || []).find((m) => m.id.includes(LIVE_MODEL) || m.name.includes(LIVE_MODEL)) || null;
      console.log(liveModel ? `   · 这一套用的模型:${liveModel.name}(${liveModel.id})` : `   ✗ 清单里没有含「${LIVE_MODEL}」的模型:${(caps.models || []).map((m) => m.id).join(' | ')}`);
      if (!liveModel) throw new Error(`--model ${LIVE_MODEL}: no such model`);
    }
    return caps;
  },
  // 常驻进程(融合插件第 1 档)× 真模型:两轮暗号走的是插件起的那个进程。--live --dsh-home 用的是一份登录过的 DSH 目录:
  // 这一项会在里面建 profiles/fusion(带一个记号文件),跑完拿走;那里已经有一份不是本台架建的 fusion 组合就不跑。
  resident: async () => {
    const fusionDir = join(DSH_HOME, 'profiles', 'fusion');
    const mark = join(fusionDir, '.dsh-engine-check');
    const existed = existsSync(fusionDir);
    if (existed && !existsSync(mark)) return record('resident', '常驻进程 × 真模型', [['DSH 目录里没有别人的 fusion 组合', false, `${clean(fusionDir)} 已存在,不是本台架建的;不动它`]]);
    if (!TOOLS_OFF && !LIVE_DRY) return record('resident', '常驻进程 × 真模型', [['带了 --dsh-tools-off(融合组合会把读写 / 命令重新打开,真模型跑常驻场景必须关掉)', false]]);
    writeResidentFixture(); writeFileSync(mark, 'written by dsh-engine.check.mjs; removed after the run\n');
    await stopEngine(); engineExtraEnv = { TANGU_PLUGINS: 'on', TANGU_PLUGINS_DIR: RESIDENT_PLUGIN_ROOT }; await startEngine();
    try {
      const L = engineLog().length;
      const word = codeWord('OTTER'); const sid = await newSession('live-resident');
      const a = await liveRun(sid, REMEMBER(word));
      const b = await liveRun(sid, ASK);
      const ps = await pointers(sid);
      const pids = fusionPids(); const st = await api(RESIDENT_ROUTE).catch((e) => ({ error: e.message }));
      record('resident', '常驻进程 × 真模型:第二句记得第一句,两轮连的都是插件起的那个进程', [
        ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
        ['第二句的回答里有第一句给的暗号', b.text.includes(word), said(b)],
        ['第一句没有动用工具', a.tools.length === 0, a.tools.map((t) => t.name).join(' / ')],
        noTools(b),
        ['两轮用的是同一个 DSH 会话', ps.length === 2 && !!ps[0].ext && ps[0].ext === ps[1].ext, ps.map((p) => p.ext?.slice(0, 8)).join(' → ')],
        ['连的是常驻进程(日志里有常驻会话、只有一个 fusion 进程、只起过一次)', /resident session [0-9a-f-]{8}: new/.test(engineLog().slice(L)) && pids.length === 1 && st.started === 1, `进程 ${pids.length} 个,起过 ${st.started} 次`],
      ]);
    } finally {
      engineExtraEnv = {}; await stopEngine(); await startEngine();
      if (!existed) rmSync(fusionDir, { recursive: true, force: true });
    }
  },
  twoturn: async () => {
    const word = codeWord('QUOKKA'); const sid = await newSession('live-twoturn');
    const a = await liveRun(sid, REMEMBER(word));
    const b = await liveRun(sid, ASK);
    const c = await liveRun(await newSession('live-twoturn-control'), ASK);
    const ps = await pointers(sid);
    record('twoturn', '第二句记得第一句', [
      ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
      ['第二句的回答里有第一句给的暗号', b.text.includes(word), said(b)],
      noTools(b),
      ['两轮用的是同一个 DSH 会话', ps.length === 2 && !!ps[0].ext && ps[0].ext === ps[1].ext, ps.map((p) => p.ext?.slice(0, 8)).join(' → ')],
      ['对照:另开一场对话问同一句,没用工具、也答不出这个暗号', c.done && c.tools.length === 0 && !c.text.includes(word), `${said(c)}${c.tools.length ? `;用了 ${c.tools.length} 次工具,这条对照不作数` : ''}`],
    ]);
  },
  model: async (caps) => {
    const from = liveModel || (caps?.models || []).find((m) => m.id === caps.currentModelId);
    const other = (caps?.models || []).find((m) => m.id !== from?.id && routeOf(m) === routeOf(from || {})) || (caps?.models || []).find((m) => m.id !== from?.id);
    if (!other) return record('model', '换模型之后仍然记得', [['清单里有第二个模型可换', false]]);
    const word = codeWord('MARMOT'); const sid = await newSession('live-model');
    const a = await liveRun(sid, REMEMBER(word));
    const b = await liveRun(sid, ASK, { engineModelId: other.id });
    const ps = await pointers(sid);
    // 到 DSH 那边看这场会话的当前模型(上一轮的 DSH 进程刚被杀,可能还占着,等它放开)
    let current;
    await until(async () => { const d = rawDsh(); try { await d.init(); const r = await d.call('session/resume', { sessionId: ps[0]?.ext, cwd: WS, mcpServers: [] });
      current = (r.result?.configOptions || []).find((o) => o.category === 'model' || o.id === 'model')?.currentValue; return !!r.result; } finally { await d.kill(); } }, 12_000, 800);
    record('model', '换模型之后仍然记得', [
      ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
      ['换了模型的那一轮答得出暗号', b.text.includes(word), said(b)],
      noTools(b),
      ['两轮用的是同一个 DSH 会话', ps.length === 2 && !!ps[0].ext && ps[0].ext === ps[1].ext],
      ['DSH 那边这场会话的当前模型就是选的那个', current === other.id, `选的 ${other.name};DSH 报 ${current}`],
    ]);
  },
  edit: async () => {
    const keep = codeWord('WALRUS'), gone = codeWord('PELICAN'); const sid = await newSession('live-edit');
    const a = await liveRun(sid, REMEMBER(keep));
    const b = await liveRun(sid, `Remember a second code word: ${gone}. Do not use any tools. Reply with just: OK`);
    await truncate(sid, (await messages(sid)).slice(-1).map((m) => m.id).concat('client-only-user-message'));
    const c = await liveRun(sid, ASK_ALL);
    const ps = await pointers(sid);
    record('edit', '删掉重发的那一轮,DSH 不再记得', [
      ['三轮都跑完', a.done && b.done && c.done, a.error || b.error || c.error || ''],
      ['被删掉的那一轮里的暗号,模型答不出来', !c.text.includes(gone), said(c)],
      noTools(c),
      ['重发的那一轮换了一个 DSH 会话', ps.length === 3 && ps[2].ext !== ps[1].ext, ps.map((p) => p.ext?.slice(0, 8)).join(' → ')],
    ], `第一轮的暗号${c.text.includes(keep) ? '还' : '也不'}在回答里(重发后是全新的 DSH 会话,已知的限制)`);
  },
  stop: async () => {
    const word = codeWord('OTTER'); const sid = await newSession('live-stop');
    const a = await liveRun(sid, REMEMBER(word));
    const b = await stoppedTurn(sid, 'Without using any tools, write out the numbers from 1 to 300 in English words, one per line.');
    // 被停的那一句在 DSH 的会话里还算没答完:真模型下一轮常常先把它接着做完再回答新的(实跑见过),所以明说不用再做
    const c = await liveRun(sid, `Never mind the numbers, do not continue them. ${ASK}`);
    const ps = await pointers(sid);
    record('stop', '中途停掉一轮,下一句仍然记得', [
      ['第一轮跑完、第二轮被停、第三轮跑完', a.done && b.aborted && c.done, `${a.error || ''} ${b.error || ''} ${c.error || ''}`],
      ['停掉之后还答得出第一句给的暗号', c.text.includes(word), said(c)],
      noTools(c),
      ['三轮是同一个 DSH 会话', ps.length === 3 && !!ps[0].ext && ps.every((p) => p.ext === ps[0].ext), ps.map((p) => `${p.status}:${p.ext?.slice(0, 8)}`).join(' → ')],
    ]);
  },
  stopedit: async () => {
    const keep = codeWord('BADGER'), gone = codeWord('PUFFIN'); const sid = await newSession('live-stopedit');
    const a = await liveRun(sid, REMEMBER(keep));
    const b = await stoppedTurn(sid, `Remember a second code word: ${gone}. Then, without using any tools, write out the numbers from 1 to 300 in English words, one per line.`);
    await truncate(sid, ['client-only-user-message', 'client-only-placeholder']);
    const c = await liveRun(sid, ASK_ALL);
    const ps = await pointers(sid);
    record('stopedit', '停掉一轮后把那一句改了重发,DSH 不再记得被弃掉的那一句', [
      ['第一轮跑完、第二轮被停、第三轮跑完', a.done && b.aborted && c.done, `${a.error || ''} ${b.error || ''} ${c.error || ''}`],
      ['被弃掉的那一句里的暗号,模型答不出来', !c.text.includes(gone), said(c)],
      noTools(c),
      ['改写后的这一轮换了一个 DSH 会话', ps.length === 3 && !!ps[1].ext && !!ps[2].ext && ps[2].ext !== ps[1].ext, ps.map((p) => `${p.status}:${p.ext?.slice(0, 8)}`).join(' → ')],
    ]);
  },
  // 由谁来跑:真模型答第二句。DSH 的 agent 答不上来会翻盘,所以任何一次调工具都当场按停(stopOn),并记进判据。
  agent: async () => {
    const word = codeWord('HERON');
    const mate = (((await api('/agent/agents')).agents) || []).find((a) => a.slug === 'dshmate') || await makeDshAgent('dshmate');
    const before = memoryTrail('xyra');
    await withHistorian(async () => {
      const sid = await newSession('live-agent');
      const cfg = { engineId: undefined, agentSlug: 'dshmate' };
      const stopOn = (ev) => ev.tools.length > 0;
      const a = await liveRun(sid, REMEMBER(word, 'It is written on the shelf that holds the spare keys for the lab cabinet, next to the blue toolbox. '), cfg, { modelId: JUDGE_MODEL, stopOn });
      const b = await liveRun(sid, ASK, cfg, { modelId: JUDGE_MODEL, stopOn });
      const ps = await pointers(sid); const rows = await chatRows(sid);
      const trail = (await until(() => { const t = memoryTrail('dshmate'); return t.logs.includes(word) && t.raw.includes(word) ? t : null; }, 40_000, 500)) || memoryTrail('dshmate');
      const after = memoryTrail('xyra');
      record('agent', '设成 DSH 来跑的 Agent:第二句记得第一句,记忆和日志记在它名下', [
        ['保存接口收下了「由 DSH 来跑」', mate?.engine === 'dsh', `engine=${mate?.engine}`],
        ['两轮都跑完', a.done && b.done, a.error || b.error || ''],
        ['第二句的回答里有第一句给的暗号', b.text.includes(word), said(b)],
        noTools(a), noTools(b),
        ['两轮用的是同一个 DSH 会话', ps.length === 2 && !!ps[0].ext && ps[0].ext === ps[1].ext, ps.map((p) => p.ext?.slice(0, 8)).join(' → ')],
        ['回答记在它名下', rows.filter((r) => r.role === 'model').length === 2 && rows.filter((r) => r.role === 'model').every((r) => r.agent_slug === 'dshmate'), rows.filter((r) => r.role === 'model').map((r) => r.agent_slug).join(' / ')],
        ['Historian 的日志与记忆候选写在它的文件夹里', trail.logs.includes(word) && trail.raw.includes(word)],
        ['缺省 Agent(xyra)那边什么都没多', after.logs === before.logs && after.raw === before.raw],
      ]);
    });
  },
  // 交接(底层第 3 步):真模型自己会不会用桥里的 Forsion 工具、会不会照编号去取结果。每一问都写明不许读文件、不许跑命令;
  // 桥之外的工具(DSH 自带的读文件、跑命令…)一出现就当场按停,并记进判据(读到的东西会发给模型方)。
  handoff: async () => {
    if (LIVE_DRY) { console.log('\n(--live-dry 不演 handoff:自动脑不调工具;工具剧本在普通模式里测)'); return; }
    const SLUG = 'livehand', SIG = codeWord('SIG'), PHRASE = codeWord('LANTERN');
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: SLUG, name: 'Hand mate', systemPrompt: `You are a test agent. End every reply with the exact signature ${SIG} on its own line.`, engine: 'dsh' }) });
    mkdirSync(join(agentDir(SLUG), 'skills', 'tea-probe'), { recursive: true });
    writeFileSync(join(agentDir(SLUG), 'skills', 'tea-probe', 'SKILL.md'), `---\nname: tea-probe\ndescription: Test skill. Its secret phrase is ${PHRASE}. Never load it.\n---\nNothing to do.\n`);
    const mem = () => { const f = join(agentDir(SLUG), 'MEMORY.md'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
    const count = (hay, needle) => hay.split(needle).length - 1;
    const onlyBridge = (allowed) => (ev) => ev.tools.some((t) => !allowed.includes(t.name));
    const strays = (r, allowed) => ['没有动用桥之外的工具(DSH 自带的读文件 / 跑命令等)', r.tools.every((t) => allowed.includes(t.name)), r.tools.filter((t) => !allowed.includes(t.name)).map((t) => t.name).join(' / ')];
    const sid = await newSession('live-handoff');
    const cfg = { engineId: undefined, agentSlug: SLUG };
    const NOFILES = 'Do not read files, list directories or run commands.';

    // 人设和技能:只凭交过去的指令回答。交接这几问不写「Reply with just …」:DSH 把指令目录当「工作区说明,不压过用户的
    // 直接指示」包进请求,「只回那一句」和人设的「每条回复都署名」正面冲突,模型听谁全看当天(11-16 同一份 AGENTS.md
    // 带 just 5/8、不带 8/8),这一项就成了掷硬币。要证的是人设交没交到,不是两条指示谁优先。
    const d = await liveRun(sid, `${NO_TOOLS} Among the skills available to you there is one named tea-probe. What secret phrase does its description give?`, cfg, { modelId: JUDGE_MODEL, stopOn: onlyBridge([]) });
    record('handoff', '交接(真模型):人设和技能交过去了,模型只凭指令答得出', [
      ['这一轮跑完', d.done, d.error || ''],
      ['回答里有技能描述里的那句', d.text.includes(PHRASE), said(d)],
      ['回答带着人设要求的署名', d.text.includes(SIG), said(d)],
      noTools(d),
    ]);

    // 直接调
    const TEA = codeWord('TEA');
    const a = await liveRun(sid, `Please remember this about me using your Forsion remember tool: I drink jasmine tea (tag ${TEA}). ${NOFILES} When it is saved, reply with SAVED.`, cfg, { modelId: JUDGE_MODEL, stopOn: onlyBridge(['remember']) });
    record('handoffcall', '交接(真模型):模型用桥里的 remember 记下一件事,卡片由 Forsion 画,记在它名下', [
      ['这一轮跑完', a.done, a.error || ''],
      ['调了 remember,卡片按 Tangu 原名画、成功', a.results.some((r) => r.name === 'remember' && !r.isError), a.results.map((r) => `${r.name}:${r.isError ? 'err' : 'ok'}`).join(', ') || '(没调)'],
      ['记忆写在它名下,只写了一次', count(mem(), TEA) === 1, `${count(mem(), TEA)} 处`],
      ['回答 SAVED 并带署名', /SAVED/.test(a.text) && a.text.includes(SIG), said(a)],
      strays(a, ['remember']),
    ]);

    const prevCfg = readConfig(); const prevApproval = prevCfg.approval;
    writeConfigFile({ ...prevCfg, approval: { base: 'auto-edit', ask: ['remember'] } });
    try {
      // 审批过了时限:模型拿到编号后会不会照着去取
      const CAT = codeWord('CAT'); const t0 = Date.now();
      const b = await liveRun(sid, `Please remember this about me using your Forsion remember tool: I have a cat named Miso (tag ${CAT}). ${NOFILES} When it is saved, reply with SAVED.`,
        { ...cfg, approvalMode: 'custom' }, { modelId: JUDGE_MODEL, timeoutMs: 300_000, stopOn: onlyBridge(['remember']), onApproval: async () => { await sleep(50_000); return 'approve'; } });
      record('handoffwait', '交接(真模型):审批过了 45 秒,模型照编号用 forsion_wait 取到结果,工具只执行一次', [
        ['这一轮跑完', b.done, b.error || ''],
        ['只来问了一次审批(没有把 remember 重调一遍)', b.approvals.length === 1, `${b.approvals.length} 次`],
        ['批了之后拿到结果(卡片成功)', b.results.some((r) => r.name === 'remember' && !r.isError), b.results.map((r) => `${r.name}:${r.isError ? 'err' : 'ok'} ${r.result.slice(0, 60)}`).join(' | ')],
        ['记忆只写了一次', count(mem(), CAT) === 1, `${count(mem(), CAT)} 处`],
        ['等审批的时间真的过了时限', (Date.now() - t0) / 1000 >= 50, `${((Date.now() - t0) / 1000).toFixed(1)} 秒`],
        ['回答 SAVED', /SAVED/.test(b.text), said(b)],
        strays(b, ['remember']),
      ]);

      // 拒绝:模型不该绕开去写
      const COFFEE = codeWord('COFFEE');
      const c = await liveRun(sid, `Please remember this about me using your Forsion remember tool: I dislike coffee (tag ${COFFEE}). ${NOFILES} If it is not saved, reply with NOT SAVED.`,
        { ...cfg, approvalMode: 'custom' }, { modelId: JUDGE_MODEL, stopOn: onlyBridge(['remember']), onApproval: () => 'reject' });
      record('handoffreject', '交接(真模型):用户拒了,模型照实说没存,记忆没写', [
        ['这一轮跑完', c.done, c.error || ''],
        ['来问了审批', c.approvals.length >= 1, `${c.approvals.length} 次`],
        ['记忆没写', count(mem(), COFFEE) === 0],
        ['回答说没存', /NOT SAVED/i.test(c.text), said(c)],
        strays(c, ['remember']),
      ]);
    } finally {
      const back = readConfig(); if (prevApproval === undefined) delete back.approval; else back.approval = prevApproval; writeConfigFile(back);
    }
  },
  // 审批:真模型自己得走到「被沙箱拒了 → 带放宽权限重试」那一步,DSH 才会来问。这一项测的就是它走不走得到。
  approval: async () => {
    if (LIVE_DRY) { console.log('\n(--live-dry 不演 approval:自动脑不调工具;工具剧本在普通模式里测)'); return; }
    const leg = async (tag, action) => {
      const sid = await newSession(`live-approval-${tag}`); const file = join(OUTSIDE, `live-${tag}.txt`);
      const r = await liveRun(sid, `Create a file at the exact path ${file} whose content is the single line "${tag}". Use your file-writing tool. The sandbox will refuse because that path is outside the workspace; when it does, retry the same tool call with elevated sandbox permissions so that I am asked to approve it. Do not write anywhere else, and do not read or list any other file or directory.`,
        { engineId: 'dsh-ro' }, { onApproval: () => action });
      return { r, file, card: r.approvals[0] };
    };
    const ok = await leg('approved', 'approve'), no = await leg('rejected', 'reject');
    record('approval', 'DSH 来问审批时,卡上有工具名和参数;批准 / 拒绝都生效', [
      ['两轮都跑完', ok.r.done && no.r.done, ok.r.error || no.r.error || ''],
      ['模型走到了来问审批那一步(两轮各至少一次)', ok.r.approvals.length >= 1 && no.r.approvals.length >= 1, `${ok.r.approvals.length} / ${no.r.approvals.length};${said(ok.r)}`],
      ['卡上的工具名不是笼统的 tool', !!ok.card?.name && ok.card.name !== 'tool', String(ok.card?.name)],
      ['卡上带着要写的路径', String(ok.card?.arguments || '').includes(ok.file), clean(ok.card?.preview || '').slice(0, 200)],
      ['批准的那次写进去了', existsSync(ok.file), existsSync(ok.file) ? JSON.stringify(readFileSync(ok.file, 'utf8').slice(0, 40)) : ''],
      ['拒绝的那次没写', !existsSync(no.file)],
    ], `调过的工具:${[...new Set(ok.r.tools.map((t) => t.name))].join(' / ') || '(无)'}`);
  },
};

// 开跑前就在的 DSH 进程不算这次留下的(--dsh-home 时用户自己可能还开着那份 DSH 的界面)
const dshPids = () => { try { return execFileSync('pgrep', ['-fl', BIN], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };
const pidsBefore = new Set(dshPids().map((l) => l.split(' ')[0]));
let exitCode = 0;
// --dsh-tools-off:对话入口组合的补丁层(DSH 第一次以 acp 启动时才建出这个目录,没有就先起一次让它建好)
const toolsOffFile = join(DSH_HOME, 'profiles', 'acp', 'cordis.patch.yml');
let toolsOffBackup = null;
if (TOOLS_OFF) {
  if (!existsSync(toolsOffFile)) { const d = rawDsh(); try { await d.init(); } finally { await d.kill(); } }
  if (!existsSync(toolsOffFile)) { console.error(`--dsh-tools-off:DSH 没有建出 ${clean(toolsOffFile)},不跑`); process.exit(2); }
  toolsOffBackup = readFileSync(toolsOffFile, 'utf8');
  writeFileSync(toolsOffFile, TOOLS_OFF_PATCH);
  console.log(`已在 ${clean(toolsOffFile)} 关掉 DSH 自带的 ${NATIVE_DISK_TOOLS.join(' / ')}(跑完还原)`);
}
try {
  await startEngine();
  let caps = null;
  if (LIVE) console.log(`真模型模式:凭据来自${LIVE_KEY ? ' --key-file(只在子进程环境里)' : ` --dsh-home(${clean(DSH_HOME)})`}`);
  for (const [key, fn] of Object.entries(LIVE || LIVE_DRY ? LIVE_SCENARIOS : SCENARIOS)) {
    if (ONLY.size && !ONLY.has(key) && !(key === 'caps' && ONLY.has('model'))) continue;
    try { const r = await fn(caps); if (key === 'caps') caps = r; }
    catch (e) { record(key, '场景自己出错', [['跑完', false, e.message]]); }
  }
} catch (e) { console.error(`\n台架出错:${clean(e.stack || e)}`); exitCode = 1; } finally {
  await stopEngine(); await stub.close();
  // 写不出来也不能挡住下面还原补丁层
  if (DUMP_REQUESTS) try { mkdirSync(dirname(DUMP_REQUESTS), { recursive: true }); writeFileSync(DUMP_REQUESTS, JSON.stringify(stub.requests, null, 1)); console.log(`\n假模型收到的带工具请求(${stub.requests.length} 次)已写到 ${clean(DUMP_REQUESTS)}`); }
  catch (e) { console.error(`\n--dump-requests 没写成:${clean(e.message || e)}`); exitCode = 1; }
  if (toolsOffBackup !== null) { await sleep(2500); writeFileSync(toolsOffFile, toolsOffBackup); console.log(`\n已还原 ${clean(toolsOffFile)}`); }
}
await sleep(2500); // 引擎杀 DSH 是 SIGTERM → 2 秒 → SIGKILL
const leftover = dshPids().filter((l) => !pidsBefore.has(l.split(' ')[0])).join('\n');
console.log('\n汇总');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}\t${r.key}\t${r.title}`);
console.log(leftover ? `\n⚠ 还有 DSH 进程没退:\n${clean(leftover)}` : '\n没有留下 DSH 进程');
if (results.some((r) => !r.ok) || leftover) exitCode = 1;
process.exit(exitCode);
