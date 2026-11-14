/** 走 session/load 的引擎的续接:真 runAcpEngine(真子进程、真 SDK 连接),对面是一个照 Codex 适配器的样子说话的假 agent ——
 *  报 loadSession(也报 resume)、续接时先把历史当成 session/update 重放一遍再回包、会话存在盘上(换一个进程还在)。
 *  真 Codex 的同一套实测在 scripts/engine-resume.check.mjs(本机跑,要用账号主人的登录)。 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatResumeVerified, runAcpEngine } from './acpEngine.js';
import type { EngineDef } from './config.js';
import type { EngineRunCtx } from './manager.js';

const FAKE_AGENT = String.raw`
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
const store = process.env.FAKE_STORE;
const log = (m) => appendFileSync(store + '.log', m + '\n');
const load = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : { sessions: {} });
const save = (s) => writeFileSync(store, JSON.stringify(s));
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const note = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
const text = (t) => ({ type: 'text', text: t });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) void handle(JSON.parse(line)); } });
process.stdin.on('end', () => process.exit(0));
async function handle(m) {
  if (!m.method) return;
  log(m.method);
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const err = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  const st = load(); const p = m.params || {};
  if (m.method === 'initialize') return ok({ protocolVersion: 1, agentInfo: { name: process.env.FAKE_NAME || 'fake-load-agent', version: '0' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
  if (m.method === 'session/new') { const id = 'sess-' + (Object.keys(st.sessions).length + 1); st.sessions[id] = { turns: [] }; save(st); return ok({ sessionId: id }); }
  if (m.method === 'session/load') {
    const s = st.sessions[p.sessionId];
    if (!s) return err(-32002, 'Resource not found: session ' + p.sessionId);
    const gap = Number(process.env.FAKE_REPLAY_GAP_MS || 0);
    const copies = Number(process.env.FAKE_REPLAY_COPIES || 1); // 把历史多放几遍 = 一场很长的对话
    for (let c = 0; c < copies; c++) for (const t of s.turns) {
      note(p.sessionId, { sessionUpdate: 'user_message_chunk', content: text(t.q) });
      note(p.sessionId, { sessionUpdate: 'agent_thought_chunk', content: text('old thought about ' + t.q) });
      note(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'old-' + t.n, title: 'old tool', rawInput: { n: t.n } });
      note(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'old-' + t.n, status: 'completed', content: [{ type: 'content', content: text('old result') }] });
      note(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text(t.a) });
      note(p.sessionId, { sessionUpdate: 'usage_update', used: 990, size: 200000 });
      if (gap) await sleep(gap);
    }
    if (process.env.FAKE_LOAD_SILENT_MS) await sleep(Number(process.env.FAKE_LOAD_SILENT_MS)); // 重放完了(或根本没有)却迟迟不回包
    ok({});
    // 真 Codex 适配器的样子:回包之后紧跟着补发一条当正文发的警告和上一轮的用量,过几十毫秒再来一条
    if (process.env.FAKE_TRAILING) {
      note(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('Warning: stray right after load\n\n') });
      note(p.sessionId, { sessionUpdate: 'usage_update', used: 990, size: 200000 });
      await sleep(Number(process.env.FAKE_TRAILING));
      note(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('Warning: stray a moment later\n\n') });
    }
    return;
  }
  if (m.method === 'session/resume') return err(-32603, 'the engine should have used session/load');
  if (m.method === 'session/prompt') {
    const s = st.sessions[p.sessionId]; const q = (p.prompt && p.prompt[0] && p.prompt[0].text) || ''; const n = s.turns.length + 1;
    const a = 'answer ' + n + ' (history: ' + s.turns.map((t) => t.q).join(' | ') + ')';
    s.turns.push({ n, q, a }); save(st);
    note(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text(a) });
    return ok({ stopReason: 'end_turn' });
  }
  if (m.id != null) return err(-32601, 'Method not found: ' + m.method);
}
`;

let dir = '';
let store = '';
let agentFile = '';
const def = (env: Record<string, string> = {}): EngineDef => ({ id: 'fake', name: 'Fake Loader', command: process.execPath, args: [agentFile], env: { FAKE_STORE: store, ...env } });
const lines = (): string[] => (existsSync(`${store}.log`) ? readFileSync(`${store}.log`, 'utf8').split('\n').filter(Boolean) : []);
type Seen = { id: string; resumable: boolean; resumed: boolean; via?: string; verifiedForChat?: boolean };

function ctx(over: Partial<EngineRunCtx> = {}): EngineRunCtx & { seen: Seen[]; events: Array<[string, any]> } {
  const seen: Seen[] = [];
  const events: Array<[string, any]> = [];
  return {
    engineId: 'fake', runId: 'r', sessionId: 's', userId: 'u', message: 'hi', cwd: dir,
    signal: new AbortController().signal,
    publish: (type, payload) => { events.push([type, payload]); },
    requestApproval: async () => ({ action: 'reject' }),
    onSession: (info) => { seen.push(info); },
    seen, events,
    ...over,
  };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tangu-acp-load-'));
  agentFile = path.join(dir, 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
beforeEach(() => { store = path.join(dir, `store-${++n}.json`); });

describe('runAcpEngine × 走 session/load 的引擎', () => {
  it('第二轮在新进程里续接:重放的旧消息不上屏,也不进这一轮的结果', async () => {
    const first = await runAcpEngine(def(), ctx({ message: 'first question' }));
    expect(first.content).toBe('answer 1 (history: )');
    expect(first.externalSessionId).toBe('sess-1');

    const c2 = ctx({ message: 'second question', resumeSessionId: 'sess-1' });
    const second = await runAcpEngine(def(), c2);
    expect(second.content).toBe('answer 2 (history: first question)'); // 引擎那边记着上一轮
    // 重放里有上一轮的回答、思考、工具调用和用量 —— 一样都不该出现在这一轮
    expect(second.reasoning).toBe('');
    expect(second.toolCalls).toEqual([]);
    expect(second.toolResults).toEqual([]);
    expect(c2.events).toEqual([['token', { delta: 'answer 2 (history: first question)' }]]); // 重放里的用量也没有当成这一轮的发出去
    expect(c2.seen).toEqual([{ id: 'sess-1', resumable: true, resumed: true, via: 'load', verifiedForChat: false }]);
    // 两样都报的引擎走 session/load,不走 session/resume
    expect(lines().filter((l) => l === 'session/new')).toHaveLength(1);
    expect(lines().filter((l) => l === 'session/load')).toHaveLength(1);
    expect(lines()).not.toContain('session/resume');
  }, 20_000);

  // 真 Codex 适配器(2.6.0)每次 load 回包后 1~2 毫秒补发一条当正文发的配置警告和上一轮的用量:回包一到就放开的话,
  // 它们成了这一轮回答的开头(实测落库的回答是「Warning: clamping SessionEnd hook timeout …\n\n<真正的回答>」)。
  it('回包之后、发出这一句之前补发的通知也不算这一轮:紧跟着回包的和隔几十毫秒才到的都丢掉', async () => {
    await runAcpEngine(def(), ctx({ message: 'first question' }));
    const c2 = ctx({ message: 'second question', resumeSessionId: 'sess-1' });
    const second = await runAcpEngine(def({ FAKE_TRAILING: '40' }), c2);
    expect(second.content).toBe('answer 2 (history: first question)');
    expect(c2.events).toEqual([['token', { delta: 'answer 2 (history: first question)' }]]);
  }, 20_000);

  // 续接的每一轮都要把重放过一遍(经 SDK 逐条校验再丢掉):几千轮的历史也得远在握手时限之内。
  // 真 Codex 实测 2002 轮的会话约 1 秒回包(scripts/engine-resume.check.mjs 的 long 那一项);这里量的是本引擎这一侧。
  it('历史很长(一万多条重放)也接得上,一样不上屏', async () => {
    await runAcpEngine(def(), ctx({ message: 'first question' }));
    const c2 = ctx({ message: 'second question', resumeSessionId: 'sess-1' });
    const started = Date.now();
    const second = await runAcpEngine(def({ FAKE_REPLAY_COPIES: '2000' }), c2); // 2000 × 6 条
    expect(second.content).toBe('answer 2 (history: first question)');
    expect(c2.events).toEqual([['token', { delta: 'answer 2 (history: first question)' }]]);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('普通对话续接的放行按握手里的适配器名:Codex 的适配器算核过,别的不算', async () => {
    const codex = ctx();
    await runAcpEngine(def({ FAKE_NAME: '@agentclientprotocol/codex-acp' }), codex);
    expect(codex.seen).toEqual([{ id: 'sess-1', resumable: true, resumed: false, via: 'load', verifiedForChat: true }]);
    const claude = ctx();
    await runAcpEngine(def({ FAKE_NAME: '@zed-industries/claude-code-acp' }), claude);
    expect(claude.seen[0]).toMatchObject({ via: 'load', verifiedForChat: false });
  }, 20_000);

  it('要续接的会话在引擎那边没有了 → 失败并标 externalSessionGone,不悄悄新开', async () => {
    const err: any = await runAcpEngine(def(), ctx({ resumeSessionId: 'sess-404' })).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.externalSessionGone).toBe(true);
    expect(lines()).not.toContain('session/new');
    expect(lines()).not.toContain('session/prompt');
  }, 20_000);
});

describe('chatResumeVerified', () => {
  it('走 resume 的都算;走 load 的只认名单里的适配器名;认不出怎么接的不算', () => {
    expect(chatResumeVerified('resume', 'anything')).toBe(true);
    expect(chatResumeVerified('resume', undefined)).toBe(true);
    expect(chatResumeVerified('load', '@agentclientprotocol/codex-acp')).toBe(true);
    expect(chatResumeVerified('load', '@zed-industries/claude-code-acp')).toBe(false);
    expect(chatResumeVerified('load', undefined)).toBe(false);
    expect(chatResumeVerified('load', { name: '@agentclientprotocol/codex-acp' })).toBe(false);
    expect(chatResumeVerified(undefined, '@agentclientprotocol/codex-acp')).toBe(false);
  });
});
