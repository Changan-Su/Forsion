/** 续接与模型选择走的是真 runAcpEngine / probeAcpEngine(真子进程、真 SDK 连接),对面是一个照 DSH 的样子说话的假 agent:
 *  只报 resume(没有 loadSession)、模型在 configOptions 里、会话存在盘上(换一个进程还在)。
 *  真 DSH 的同一套实测在 scripts/dsh-engine.check.mjs(本机跑,要装官方包)。 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeAcpEngine, runAcpEngine } from './acpEngine.js';
import { createEngineManager } from './manager.js';
import type { EngineDef } from './config.js';
import type { EngineRunCtx } from './manager.js';

const FAKE_AGENT = String.raw`
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
const store = process.env.FAKE_STORE;
const log = (m) => appendFileSync(store + '.log', m + '\n');
const load = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : { sessions: {} });
const save = (s) => writeFileSync(store, JSON.stringify(s));
const A = '["p","a"]', B = '["p","b"]';
const options = (s) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: [{ group: 'p', name: 'Provider', options: [{ value: A, name: 'Model A' }, { value: B, name: 'Model B', description: 'bigger' }] }] },
  { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }] },
];
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
process.stdin.on('end', () => process.exit(0));
function handle(m) {
  if (!m.method) return;
  log(m.method);
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const err = (code, message, data) => send({ jsonrpc: '2.0', id: m.id, error: { code, message, ...(data ? { data } : {}) } });
  const st = load(); const p = m.params || {};
  if (m.method === 'initialize') return ok({ protocolVersion: 1, agentInfo: { name: 'fake-resume-agent', version: '0' }, agentCapabilities: { sessionCapabilities: { resume: {}, close: {}, list: {} } } });
  if (m.method === 'session/new') { const id = 'sess-' + (Object.keys(st.sessions).length + 1); st.sessions[id] = { turns: 0, model: A, cwd: p.cwd }; save(st); return ok({ sessionId: id, configOptions: options(st.sessions[id]) }); }
  if (m.method === 'session/resume') {
    if (process.env.FAKE_BUSY === p.sessionId) return err(-32603, 'Internal error', { details: 'session "' + p.sessionId + '" is already owned by an active write handle' });
    const s = st.sessions[p.sessionId];
    if (!s) return err(-32602, 'Invalid params: session is not resumable: ' + p.sessionId);
    return ok({ configOptions: options(s) });
  }
  if (m.method === 'session/set_config_option') { const s = st.sessions[p.sessionId]; log('set ' + p.configId + '=' + p.value); if (p.configId === 'model') s.model = p.value; save(st); return ok({ configOptions: options(s) }); }
  if (m.method === 'session/close') return ok({});
  if (m.method === 'session/prompt') {
    const s = st.sessions[p.sessionId]; s.turns += 1; save(st);
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turns=' + s.turns + ' model=' + s.model } } } });
    return ok({ stopReason: 'end_turn' });
  }
  if (m.id != null) return err(-32601, 'Method not found: ' + m.method);
}
`;

let dir = '';
let store = '';
let agentFile = '';
const def = (env: Record<string, string> = {}): EngineDef => ({ id: 'fake', name: 'Fake Harness', command: process.execPath, args: [agentFile], env: { FAKE_STORE: store, ...env } });
const lines = (): string[] => (existsSync(`${store}.log`) ? readFileSync(`${store}.log`, 'utf8').split('\n').filter(Boolean) : []);
const sessions = (): Record<string, { turns: number; model: string }> => JSON.parse(readFileSync(store, 'utf8')).sessions;

function ctx(over: Partial<EngineRunCtx> = {}): EngineRunCtx & { seen: Array<{ id: string; resumable: boolean; resumed: boolean; via?: string }> } {
  const seen: Array<{ id: string; resumable: boolean; resumed: boolean; via?: string }> = [];
  return {
    engineId: 'fake', runId: 'r', sessionId: 's', userId: 'u', message: 'hi', cwd: dir,
    signal: new AbortController().signal,
    publish: () => {},
    requestApproval: async () => ({ action: 'reject' }),
    onSession: (info) => { seen.push(info); },
    seen,
    ...over,
  };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tangu-acp-resume-'));
  agentFile = path.join(dir, 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
beforeEach(() => { store = path.join(dir, `store-${++n}.json`); });

describe('runAcpEngine × 只会 resume 的引擎', () => {
  it('第二轮在新进程里续接同一个会话:走 session/resume,不再 session/new', async () => {
    const c1 = ctx();
    const first = await runAcpEngine(def(), c1);
    expect(first.content).toBe('turns=1 model=["p","a"]');
    expect(first.externalSessionId).toBe('sess-1');
    expect(c1.seen).toEqual([{ id: 'sess-1', resumable: true, resumed: false, via: 'resume' }]);

    const c2 = ctx({ resumeSessionId: 'sess-1' });
    const second = await runAcpEngine(def(), c2);
    expect(second.content).toBe('turns=2 model=["p","a"]'); // 引擎那边记着上一轮
    expect(second.externalSessionId).toBe('sess-1');
    expect(c2.seen).toEqual([{ id: 'sess-1', resumable: true, resumed: true, via: 'resume' }]);
    expect(lines().filter((l) => l === 'session/new')).toHaveLength(1);
    expect(lines().filter((l) => l === 'session/resume')).toHaveLength(1);
    expect(lines()).not.toContain('session/load');
  }, 20_000);

  it('模型在 configOptions 里:选了别的才发 set_config_option;续接时当前值已是它就不再发;清单里没有的不发', async () => {
    const B = '["p","b"]';
    const first = await runAcpEngine(def(), ctx({ engineModelId: B }));
    expect(first.content).toBe(`turns=1 model=${B}`);
    expect(lines().filter((l) => l.startsWith('set '))).toEqual([`set model=${B}`]);
    expect(lines()).not.toContain('session/set_model'); // 这类引擎没有 session/set_model

    const second = await runAcpEngine(def(), ctx({ engineModelId: B, resumeSessionId: 'sess-1' }));
    expect(second.content).toBe(`turns=2 model=${B}`);
    expect(lines().filter((l) => l.startsWith('set '))).toHaveLength(1);

    const third = await runAcpEngine(def(), ctx({ engineModelId: 'no-such-model', resumeSessionId: 'sess-1' }));
    expect(third.content).toBe(`turns=3 model=${B}`); // 照引擎当前的跑
    expect(lines().filter((l) => l.startsWith('set '))).toHaveLength(1);
  }, 30_000);

  it('要续接的会话在引擎那边没有了 → 失败并标 externalSessionGone,不悄悄新开', async () => {
    const c = ctx({ resumeSessionId: 'sess-404' });
    const err: any = await runAcpEngine(def(), c).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.externalSessionGone).toBe(true);
    expect(err.message).toMatch(/Fake Harness no longer has the earlier session.*not resumable: sess-404/);
    expect(lines()).not.toContain('session/new');
    expect(lines()).not.toContain('session/prompt');
    expect(c.seen).toEqual([]);
  }, 20_000);

  it('会话被另一个进程占着 → 失败并说明原因,不标「没有了」', async () => {
    await runAcpEngine(def(), ctx());
    const err: any = await runAcpEngine(def({ FAKE_BUSY: 'sess-1' }), ctx({ resumeSessionId: 'sess-1' })).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.externalSessionGone).toBeUndefined();
    expect(err.message).toMatch(/open in another window or process.*already owned by an active write handle/);
    expect(sessions()['sess-1'].turns).toBe(1); // 没有发出第二句
    expect(lines().filter((l) => l === 'session/new')).toHaveLength(1);
  }, 20_000);
});

describe('probeAcpEngine × 只会 resume 的引擎', () => {
  it('模型和思考档从 configOptions 里读;反复探测复用同一个会话,不在引擎的历史里攒空会话', async () => {
    const a = await probeAcpEngine(def(), { reuseCwd: dir });
    expect(a.models).toEqual([
      { id: '["p","a"]', name: 'Model A', description: 'Provider' },
      { id: '["p","b"]', name: 'Model B', description: 'bigger' },
    ]);
    expect(a.currentModelId).toBe('["p","a"]');
    expect(a.thoughtLevels?.map((l) => l.id)).toEqual(['off', 'high']);
    expect(a.currentThoughtLevel).toBe('high');
    expect(a.resume).toBe(true);
    expect(a.loadSession).toBe(false);
    expect(a.probeSessionId).toBe('sess-1');

    const b = await probeAcpEngine(def(), { reuseSessionId: a.probeSessionId, reuseCwd: dir });
    expect(b.probeSessionId).toBe('sess-1');
    expect(b.models).toEqual(a.models);
    expect(Object.keys(sessions())).toEqual(['sess-1']);
    expect(lines().filter((l) => l === 'session/close')).toHaveLength(2);

    // 记着的那个探测会话没了 → 新建一个并报回新的 id
    const c = await probeAcpEngine(def(), { reuseSessionId: 'sess-404', reuseCwd: dir });
    expect(c.probeSessionId).toBe('sess-2');
  }, 30_000);
});

describe('引擎管理器 × 同时来问能力清单', () => {
  const savedHome = process.env.TANGU_HOME;
  afterAll(() => { if (savedHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = savedHome; });

  it('缓存没命中时两处同时问 → 只探测一次,不因为抢同一个探测会话而多留空会话', async () => {
    process.env.TANGU_HOME = path.join(dir, `home-${n}`);
    const cfg = path.join(dir, `engines-${n}.json`);
    writeFileSync(cfg, JSON.stringify({ engines: [def()] }));
    const mgr = createEngineManager(cfg);
    const [a, b] = await Promise.all([mgr.capabilities('fake'), mgr.capabilities('fake')]);
    expect(a.models.map((m) => m.id)).toEqual(['["p","a"]', '["p","b"]']);
    expect(b).toBe(a);
    expect(lines().filter((l) => l === 'initialize')).toHaveLength(1);
    expect(Object.keys(sessions())).toEqual(['sess-1']);
    expect((a as any).probeSessionId).toBeUndefined(); // 探测会话的 id 不外露
    await mgr.dispose();
  }, 30_000);
});
