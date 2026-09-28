/**
 * 设备能力 MCP 方案 P0 ④ · 真 loop(内存 SQLite + 真 agentLoop + 脚本化 fake llm):远程污点 run 的有效审批档与请求字段兜底。
 * 负对照都在修复前的代码上实跑为红;每条都带同形状的本机对照(本机不受影响)。
 *   ① 远端不带 approvalMode + Agent 定义 full-auto(agentActivation 填档)→ 钳到 auto-edit,run_bash 要批;
 *   ② 本机建成 full-auto 的会话被远程 run 继续(审批时现读会话存档)→ 钳;
 *   ③ verifyCommand 绕过路由抄进远程 run(会话存值 / 派生配置)→ loop 不跑;
 *   ④ 远程 run 里 delegate 出的子代理同样按远程钳;
 *   ⑤ 远程 run 进不了外部引擎私聊会话(不回落自有 loop)。
 *   ⑧ P1 · K1:远程 run 的 approval_request 带 remote(含调用方),子代理的卡同样带;本机 run 不带该键(S11 / S12 引擎半边)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { subscribe } from '../src/services/eventBus.js';
import { resolveApproval } from '../src/services/approvals.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { taintRunRemote, effectiveRemote } from '../src/services/remoteOrigin.js';

const USER = 'u1';
const REMOTE = { via: 'tunnel', marked: true };
let home: string;
let ws: string;
let script: Array<() => any>;
let engineRuns: number;

const bash = (cmd: string) => () => ({ content: '', reasoning: '', toolCalls: [{ id: `b-${Math.random()}`, type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: cmd }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' });
const write = (file: string) => () => ({ content: '', reasoning: '', toolCalls: [{ id: `w-${Math.random()}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'x' }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' });
const delegate = (task: string) => () => ({ content: '', reasoning: '', toolCalls: [{ id: `d-${Math.random()}`, type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ task }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' });
const final = (text = 'ok') => () => ({ content: text, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-loop-'));
  process.env.TANGU_HOME = home;
  ws = mkdtempSync(join(tmpdir(), 'tangu-remote-loop-ws-')); // 家目录之外:远程 run 在 Forsion 家目录里只许写 Library
  // Agent 定义把审批档设成完全通行:远端不带 approvalMode 时就是它被 applyAgentActivation 填进 run
  const dir = join(home, 'agents', 'yolo');
  mkdirSync(join(dir, 'Library'), { recursive: true });
  writeFileSync(join(dir, 'config.toml'), 'name = "yolo"\napproval_mode = "full-auto"\n');
  writeFileSync(join(dir, 'SOUL.md'), 'You are yolo.');
  script = [];
  engineRuns = 0;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        const step = script.shift();
        if (!step) return final('script exhausted')();
        return step();
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  const engines: any = {
    list: () => [{ id: 'codex', name: 'Codex', available: true, status: 'available' }], has: (id: string) => id === 'codex',
    capabilities: async () => ({ models: [], commands: [] }), setDefaultModel: () => {}, dispose: async () => {},
    run: async () => { engineRuns++; return { content: 'engine ran' }; },
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }), engines } as any);
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
});

let runSeq = 0;
/** 跑到终态;approval_request 一律拒(记下来),返回 { asked, status, error }。 */
async function run(agentConfig: Record<string, any>, remote: boolean | Record<string, unknown>, steered = false): Promise<{ asked: any[]; status: string; error?: string; runId: string }> {
  const asked: any[] = [];
  const runId = `L${++runSeq}`;
  // steered:本机起的 run,被远端 steer 染色(路由在 enqueueSteer 成功后登记;这里在起跑前登记 = 首个迭代边界就已染上)
  if (steered) taintRunRemote(runId, { via: 'p2p', marked: false });
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'host', cwd: ws, ...agentConfig }, origin: 'client', ...(remote ? { remote: remote === true ? REMOTE : remote } : {}) },
  });
  let error: string | undefined;
  const off = subscribe(runId, (ev) => {
    if (ev.type === 'error') error = String(ev.payload?.error || '');
    if (ev.type !== 'approval_request') return;
    asked.push(ev.payload);
    resolveApproval(ev.payload.approvalId, { action: 'reject' });
  });
  enqueueRun('S', runId);
  const t0 = Date.now();
  try {
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return { asked, status: String(r.status), error, runId };
      if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
  } finally { off(); }
}

describe('远程污点 run × 真 loop', () => {
  it('① 远端不带 approvalMode,Agent 定义 full-auto → 钳到 auto-edit,run_bash 要批(负对照:本机按定义放行)', async () => {
    script = [bash(`touch ${join(ws, 'local.txt')}`), final()];
    expect((await run({ agentSlug: 'yolo' }, false)).asked).toHaveLength(0);
    expect(existsSync(join(ws, 'local.txt'))).toBe(true);
    script = [bash(`touch ${join(ws, 'remote.txt')}`), final()];
    const r = await run({ agentSlug: 'yolo' }, true);
    expect(r.asked.map((a) => [a.name, a.reason?.mode])).toEqual([['run_bash', 'auto-edit']]);
    expect(existsSync(join(ws, 'remote.txt'))).toBe(false);
  });

  it('② 本机建成 full-auto 的会话被远程 run 继续 → 审批时现读存档之后再钳(负对照:本机继续照旧放行)', async () => {
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'`, [JSON.stringify({ approvalMode: 'full-auto' })]);
    script = [bash(`touch ${join(ws, 'a.txt')}`), final()];
    expect((await run({ approvalMode: 'auto-edit' }, false)).asked).toHaveLength(0);
    script = [bash(`touch ${join(ws, 'b.txt')}`), final()];
    expect((await run({ approvalMode: 'auto-edit' }, true)).asked.map((a) => a.name)).toEqual(['run_bash']);
    expect(existsSync(join(ws, 'b.txt'))).toBe(false);
  });

  it('③ verifyCommand 绕过路由抄进远程 run → 不执行(负对照:本机照跑)', async () => {
    const localMark = join(ws, 'verify-local.txt');
    const remoteMark = join(ws, 'verify-remote.txt');
    script = [write(join(ws, 'w1.txt')), final()];
    await run({ approvalMode: 'auto-edit', verifyCommand: `touch ${localMark}` }, false);
    expect(existsSync(localMark)).toBe(true);
    script = [write(join(ws, 'w2.txt')), final()];
    await run({ approvalMode: 'auto-edit', verifyCommand: `touch ${remoteMark}` }, true);
    expect(existsSync(join(ws, 'w2.txt'))).toBe(true); // 工作区内写在上限档下照常免批
    expect(existsSync(remoteMark)).toBe(false);
  });

  it('⑧ K1:远程 run 的审批事件带 remote(调用方随 input.remote 进闸,子代理的卡同样带);本机 run 的卡不带该键', async () => {
    const CALLER = { via: 'tunnel', marked: true, callerUnit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', callerKind: 'phone', callerName: 'Pixel 9' };
    script = [bash(`touch ${join(ws, 'k1-main.txt')}`), delegate('touch a file'), bash(`touch ${join(ws, 'k1-sub.txt')}`), final('sub done'), final()];
    const remote = await run({ approvalMode: 'full-auto' }, CALLER);
    expect(remote.asked.map((a) => a.name)).toEqual(['run_bash', 'run_bash']);
    for (const a of remote.asked) expect(a.remote).toEqual({ via: 'tunnel', callerUnit: CALLER.callerUnit, callerKind: 'phone', callerName: 'Pixel 9' });
    // 调用方不改判定:与不带调用方的远程 run 同样钳到 auto-edit(S13 的真 loop 版)
    expect(remote.asked.map((a) => a.reason?.mode)).toEqual(['auto-edit', 'auto-edit']);
    script = [bash(`touch ${join(ws, 'k1-anon.txt')}`), final()];
    const anon = await run({ approvalMode: 'full-auto' }, true);
    expect(anon.asked.map((a) => [a.reason?.mode, a.remote])).toEqual([['auto-edit', { via: 'tunnel' }]]);
    script = [bash(`touch ${join(ws, 'k1-local.txt')}`), final()];
    const local = await run({ approvalMode: 'auto-edit' }, false);
    expect(local.asked).toHaveLength(1);
    expect('remote' in local.asked[0]).toBe(false);
  });

  it('④ 远程 run 里 delegate 的子代理同样按远程钳(负对照:本机 full-auto 子代理不问)', async () => {
    script = [delegate('touch a file'), bash(`touch ${join(ws, 'sub-local.txt')}`), final('sub done'), final()];
    expect((await run({ approvalMode: 'full-auto' }, false)).asked).toHaveLength(0);
    expect(existsSync(join(ws, 'sub-local.txt'))).toBe(true);
    script = [delegate('touch a file'), bash(`touch ${join(ws, 'sub-remote.txt')}`), final('sub done'), final()];
    expect((await run({ approvalMode: 'full-auto' }, true)).asked.map((a) => a.name)).toEqual(['run_bash']);
    expect(existsSync(join(ws, 'sub-remote.txt'))).toBe(false);
  });

  it('⑥ 本机 run 被远端 steer 染色后:verifyCommand 不再执行、额外可写根不再免批;run 收尾即清色(负对照:未染色的同一配置照跑)', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'tangu-remote-loop-extra-'));
    try {
      const cfg = (mark: string) => ({ approvalMode: 'auto-edit', verifyCommand: `touch ${join(ws, mark)}`, extraRoots: [extra] });
      script = [write(join(extra, 'plain.txt')), final()];
      expect((await run(cfg('v-plain.txt'), false)).asked).toHaveLength(0);
      expect(existsSync(join(ws, 'v-plain.txt'))).toBe(true);
      script = [write(join(extra, 'steered.txt')), final()];
      const r = await run(cfg('v-steered.txt'), false, true);
      expect(r.asked.map((a) => [a.name, a.reason?.kind])).toEqual([['write_file', 'escalate']]);
      expect(existsSync(join(extra, 'steered.txt'))).toBe(false);
      expect(existsSync(join(ws, 'v-steered.txt'))).toBe(false);
      expect(effectiveRemote({ runId: r.runId })).toBeUndefined();
    } finally { rmSync(extra, { recursive: true, force: true }); }
  });

  it('⑦ 远端 steer 染的色在外部引擎分支收尾时同样清掉(不经 runLoop 的 finally;Codex 二轮)', async () => {
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'`, [JSON.stringify({ soloEngineId: 'codex' })]);
    const r = await run({}, false, true);
    expect(r.status).toBe('done');
    await new Promise((res) => setTimeout(res, 20)); // 任务 finally 在终态落库之后一拍
    expect(effectiveRemote({ runId: r.runId })).toBeUndefined();
  });

  it('⑤ 远程 run 进不了外部引擎私聊会话:明确失败、不回落自有 loop(负对照:本机交给引擎)', async () => {
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'`, [JSON.stringify({ soloEngineId: 'codex' })]);
    expect((await run({}, false)).status).toBe('done');
    expect(engineRuns).toBe(1);
    const r = await run({}, true);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('engine_unavailable_remote');
    expect(engineRuns).toBe(1);
  });
});
