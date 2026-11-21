/**
 * 长命令不挡插话(借鉴 dsh-superagent 方案第 5 条 A,11-20):前台 run_bash 跑着时用户插话 → 命令原样移交进后台进程表、
 * 工具立刻返回,模型下一步就读到插话;命令结束后结局交回(这一轮还在跑 → 进这一轮;已收尾 → 起一轮)。
 * 真内存 SQLite + 真 loop + 真 shell + 剧本 LLM,钉:
 *   ① 已收尾 → 命令结束时起一轮交回(<background_update>,不带命令输出);命令没被杀、只跑了一次
 *   ② 这一轮还在跑 → 结局进这一轮(迭代边界),不另起一轮
 *   ③ 不插话 → 和原来一样:等命令跑完、没有多出的模型调用、没有后台进程
 *   ④ 移交后到上限 → 停掉,起一轮告诉模型 [timed_out]
 *   ⑤ 停掉那一轮 → 被移交的命令一并停,不起轮
 *   ⑥ run_background 起的进程结束 → 不唤醒
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
import { enqueueRun, enqueueSteer, abortRun } from '../src/services/agentLoop.js';
import { BACKGROUND_UPDATE_OPEN } from '../src/services/steerHandoff.js';
import { disposeAllProcesses, listProcesses } from '../src/tools/processRegistry.js';

const USER = 'u1';
let home: string;
let ws: string;
let payloads: any[];
let script: Array<(o: any) => any>;
let runSeq = 0;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-handoff-'));
  process.env.TANGU_HOME = home;
  ws = join(home, 'ws');
  mkdirSync(ws, { recursive: true });
  payloads = [];
  script = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        payloads.push(o.payload);
        const step = script.shift();
        if (!step) throw new Error(`剧本耗尽:第 ${payloads.length} 次 LLM 调用没有出招`);
        return step(o);
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(async () => {
  delete process.env.TANGU_HANDOFF_MAX_MS;
  // 收尾:等 S 上的轮都停下(交回那一轮可能还在跑),再杀掉残留进程
  for (let i = 0; i < 100 && (await runsOf()).some((r) => !['done', 'failed', 'aborted'].includes(String(r.status))); i++) await sleep(30);
  disposeAllProcesses();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const usage = { prompt_tokens: 10, completion_tokens: 10 };
const bash = (id: string, command: string) => () => ({
  content: '', reasoning: '', finishReason: 'stop', usage,
  toolCalls: [{ id, type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command }) } }],
});
const background = (id: string, command: string) => () => ({
  content: '', reasoning: '', finishReason: 'stop', usage,
  toolCalls: [{ id, type: 'function', function: { name: 'run_background', arguments: JSON.stringify({ command }) } }],
});
const finalStep = (content: string) => () => ({ content, reasoning: '', toolCalls: [], usage, finishReason: 'stop' });
const toolMsgs = (p: any): string[] => (p.messages as any[]).filter((m) => m.role === 'tool').map((m) => String(m.content));
const userMsgs = (p: any): string[] => (p.messages as any[]).filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
const runsOf = async (): Promise<any[]> => query<any[]>(`SELECT id, status, input FROM agent_runs WHERE session_id = 'S'`);
const inputOf = (r: any): any => (typeof r.input === 'string' ? JSON.parse(r.input) : r.input || {});

/** 起一个本机交互 run;steerOn:看到这个工具调用后 steerAfterMs 毫秒插一句话。 */
async function start(opts: { steerOn?: string; steerAfterMs?: number } = {}): Promise<{ runId: string; settled: () => Promise<any>; results: any[] }> {
  const runId = `R${++runSeq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A${runSeq}`,
    input: {
      message: '跑一下检查', userMessageId: `U${runSeq}`, attachments: [], origin: 'client', client: 'desktop/2.14.0',
      agentConfig: { execMode: 'host', cwd: ws, approvalMode: 'full-auto' },
    },
  });
  const results: any[] = [];
  const off = subscribe(runId, (ev) => {
    if (ev.type === 'tool_result') results.push({ ...ev.payload, at: Date.now() });
    if (ev.type === 'tool_call' && opts.steerOn && ev.payload?.id === opts.steerOn) {
      setTimeout(() => { enqueueSteer(runId, { id: `steer-${runId}`, content: 'By the way, what is the default SSH port?' }); }, opts.steerAfterMs ?? 300);
    }
  });
  enqueueRun('S', runId);
  const settled = async (): Promise<any> => {
    const t0 = Date.now();
    try {
      for (;;) {
        const r = await getRun(runId);
        if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
        if (Date.now() - t0 > 20_000) throw new Error(`run 未结束(status=${r?.status})`);
        await sleep(20);
      }
    } finally { off(); }
  };
  return { runId, settled, results };
}
/** 等交回那一轮(input.backgroundUpdate)出现并结束。 */
const wakeRun = async (ms = 15_000): Promise<any> => {
  const t0 = Date.now();
  for (;;) {
    const w = (await runsOf()).find((r) => inputOf(r).backgroundUpdate === true);
    if (w && ['done', 'failed', 'aborted'].includes(String(w.status))) return w;
    if (Date.now() - t0 > ms) throw new Error(`等不到交回那一轮${w ? `(status=${w.status})` : ''}`);
    await sleep(30);
  }
};

describe('长命令不挡插话', () => {
  it('① 已收尾 → 命令结束时起一轮交回;结局行不带输出、命令只跑一次且没被杀', async () => {
    script = [
      bash('c-long', "sleep 4; printf 'LONG-%s-7781' MARK"), // 输出里的标记不在命令原文里
      finalStep('Port 22. The check is still running in the background.'),
      finalStep('The check finished.'),
    ];
    const r = await start({ steerOn: 'c-long' });
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(toolMsgs(payloads[1])[0]).toMatch(/Moved to the background after/);
    expect(toolMsgs(payloads[1])[0]).toMatch(/background process bg_/);
    expect(userMsgs(payloads[1]).some((u) => u.includes('default SSH port'))).toBe(true);
    const [proc] = listProcesses('S');
    expect(proc?.handoff?.toolCallId).toBe('c-long');
    // 插话在命令结束前就被读到:这一轮收尾时命令还在跑(没被杀、也没等它)
    expect(proc.status).toBe('running');

    const wake = await wakeRun();
    expect(wake.status).toBe('done');
    expect(payloads.length).toBe(3);
    const update = userMsgs(payloads[2]).find((u) => u.startsWith(BACKGROUND_UPDATE_OPEN));
    expect(update).toBeTruthy();
    expect(update).toContain(`[finished] process ${proc.id} (run_bash call c-long)`);
    expect(update).toContain('exited with code 0');
    // ⚠️ 结局行里绝不带命令输出(不可信数据不升格成 user 行)
    expect(update).not.toContain('LONG-MARK-7781');
    expect(proc.exitCode).toBe(0);
    expect(proc.output).toContain('LONG-MARK-7781');
    expect(proc.handoff?.delivered).toBe(true);
    // 命令只起了一次;交回只起了一轮
    expect([...new Set(payloads.flatMap((p) => (p.messages as any[]).filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls || []))
      .filter((c: any) => c.function?.name === 'run_bash').map((c: any) => c.id))]).toEqual(['c-long']);
    expect((await runsOf()).length).toBe(2);
  }, 30_000);

  it('② 这一轮还在跑 → 结局在迭代边界进这一轮,不另起一轮', async () => {
    script = [
      bash('c-long', "sleep 1.5; printf 'FIRST-%s' MARK"),
      bash('c-next', 'sleep 2.5; echo second'), // 读完插话接着干别的;这期间第一条结束
      finalStep('Both done.'),
    ];
    const r = await start({ steerOn: 'c-long' });
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(payloads.length).toBe(3);
    const update = userMsgs(payloads[2]).find((u) => u.startsWith(BACKGROUND_UPDATE_OPEN));
    expect(update).toContain('(run_bash call c-long)');
    expect(update).not.toContain('FIRST-MARK');
    // 第二条前台命令没有插话在排 → 照常跑完(没被挤进后台)
    expect(toolMsgs(payloads[2]).some((t) => t.includes('second') && t.includes('exit_code: 0'))).toBe(true);
    await sleep(400);
    expect((await runsOf()).length).toBe(1);
    expect(listProcesses('S').filter((p) => p.handoff).map((p) => p.handoff!.delivered)).toEqual([true]);
  }, 30_000);

  it('③ 不插话 → 和原来一样:等命令跑完,两次模型调用,没有后台进程', async () => {
    script = [bash('c-short', 'sleep 1.2; echo NORMAL-MARK'), finalStep('ok')];
    const r = await start();
    const run = await r.settled();
    expect(run.status).toBe('done');
    expect(payloads.length).toBe(2);
    expect(toolMsgs(payloads[1])[0]).toContain('NORMAL-MARK');
    expect(toolMsgs(payloads[1])[0]).toMatch(/exit_code: 0/);
    expect(toolMsgs(payloads[1])[0]).not.toContain('Moved to the background');
    expect(listProcesses('S')).toEqual([]);
    expect((await runsOf()).length).toBe(1);
  }, 30_000);

  it('④ 移交后到上限 → 停掉,起一轮告诉模型 [timed_out]', async () => {
    process.env.TANGU_HANDOFF_MAX_MS = '800';
    script = [bash('c-hang', 'sleep 30'), finalStep('Port 22.'), finalStep('It timed out.')];
    const r = await start({ steerOn: 'c-hang' });
    expect((await r.settled()).status).toBe('done');
    expect(toolMsgs(payloads[1])[0]).toMatch(/still running 1 second from now/);
    const wake = await wakeRun();
    expect(wake.status).toBe('done');
    const update = userMsgs(payloads[2]).find((u) => u.startsWith(BACKGROUND_UPDATE_OPEN));
    expect(update).toContain('[timed_out]');
    const [proc] = listProcesses('S');
    expect(proc.handoff?.timedOut).toBe(true);
    expect(proc.status).toBe('killed');
  }, 30_000);

  it('⑤ 停掉那一轮 → 被移交的命令一并停,不起轮', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    script = [
      bash('c-hang', 'sleep 30'),
      async () => { await held; return finalStep('never')(); }, // 第二轮挂住,等测试按停
    ];
    const r = await start({ steerOn: 'c-hang' });
    for (let i = 0; i < 200 && payloads.length < 2; i++) await sleep(20);
    expect(payloads.length).toBe(2);
    const [proc] = listProcesses('S');
    expect(proc.status).toBe('running');
    abortRun(r.runId, { byUser: true });
    release();
    expect((await r.settled()).status).toBe('aborted');
    for (let i = 0; i < 200 && !proc.handoff?.closed; i++) await sleep(20);
    expect(proc.killRequested).toBe(true);
    expect(proc.handoff?.closed).toBe(true);
    await sleep(300);
    expect((await runsOf()).length).toBe(1);
  }, 30_000);

  it('⑥ run_background 起的进程结束 → 不唤醒', async () => {
    script = [background('c-bg', 'sleep 0.5; echo dev-server-up'), finalStep('Started.')];
    const r = await start();
    expect((await r.settled()).status).toBe('done');
    const [proc] = listProcesses('S');
    expect(proc.handoff).toBeUndefined();
    for (let i = 0; i < 100 && proc.status === 'running'; i++) await sleep(30);
    expect(proc.status).toBe('exited');
    await sleep(400);
    expect((await runsOf()).length).toBe(1);
    expect(payloads.length).toBe(2);
  });
});
