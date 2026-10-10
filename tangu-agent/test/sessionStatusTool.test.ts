/**
 * session_status(agent 读「这段对话跑到哪了」)+ GET /agent/sessions/:id/status 的真源 services/runStatus.ts:
 *   - 排版:占用 / 窗口 / 压缩线 / 余量、本 run 的 token 与步数与用时、每步涨多少、更早的 run;估出来的明说是估的
 *   - 库时间按 UTC 读(SQLite 的 CURRENT_TIMESTAMP 不带时区标记)
 *   - 可见性:前台 run 三种预设都在按需目录里(chat 的聊天会话是 sandbox + chat 面)、计划模式与宿主沙箱下也在;
 *     子代理 / 讨论成员 / Muse / 自动化 / 一次性 run 不给
 *   - 真 loop:工具读到的是循环里的实数(调用次数、累计 token、步数),run 结束后登记撤掉
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { getToolDefinitions, listDeferredTools, executeTool, type ToolContext } from '../src/tools/registry.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { subscribe } from '../src/services/eventBus.js';
import { toolNeedsApproval } from '../src/services/approvals.js';
import { isHostSandboxToolAllowed } from '../src/sandbox/hostSandboxPolicy.js';
import { dbTimeMs, formatDuration, liveRunStatus, registerLiveRun, renderRunStatus, unregisterLiveRun, type RunStatus } from '../src/services/runStatus.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const status = (over: Omit<Partial<RunStatus>, 'context'> & { context?: Partial<RunStatus['context']> } = {}): RunStatus => ({
  runId: 'R', sessionId: 'S', modelId: 'gpt-6-luna', thinkingLevel: 'medium', startedAt: 1_000_000, iteration: 4, maxIterations: 90, llmCalls: 4,
  tokens: { prompt: 61_200, completion: 2_100, cached: 48_000, total: 63_300 },
  ...over,
  context: { window: 272_000, used: 41_200, measured: true, compactAt: 255_600, compactionEnabled: true, firstPrompt: 31_000, lastPrompt: 41_200, ...over.context },
});

describe('renderRunStatus', () => {
  it('实测口径:占用、压缩线前的余量、本 run 的 token / 步数 / 用时、每步涨幅与还能跑几步', () => {
    const text = renderRunStatus(status(), 1_000_000 + 72_000, { earlierRuns: 9, earlierTokens: 412_000, startedAt: 1_000_000 - 8_040_000 });
    expect(text.split('\n')).toEqual([
      'Model: gpt-6-luna · thinking: medium',
      'Context: about 41,200 of 272,000 tokens in use (15%). Older turns are summarized automatically once it passes 255,600, so about 214,400 tokens of room remain before that.',
      'This run: step 4 of at most 90 · 4 model calls so far · 1m 12s elapsed',
      'Tokens this run: 61,200 in (48,000 served from cache) + 2,100 out = 63,300',
      'Context growth: about 3,400 tokens per step so far; at this pace roughly 63 more steps fit in the remaining room.',
      'This conversation: 9 earlier runs used 412,000 tokens; it started 2h 15m ago.',
      "These numbers are about this conversation only. They are not the user's account quota or plan allowance.",
    ]);
  });

  it('还没有实测 → 明说是估的;关了自动压缩 → 余量按窗口算;第一步没有涨幅;没有更早的 run 不写那行', () => {
    const text = renderRunStatus(status({
      iteration: 1, llmCalls: 0, tokens: { prompt: 0, completion: 0, cached: 0, total: 0 },
      context: { used: 9_000, measured: false, compactionEnabled: false, firstPrompt: 0, lastPrompt: 0 },
    }), 1_000_000 + 4_000, { earlierRuns: 0, earlierTokens: 0 });
    expect(text).toContain('Context: roughly (estimated) 9,000 of 272,000 tokens in use (3%). About 263,000 tokens of room remain.');
    expect(text).toContain('This run: step 1 of at most 90 · 0 model calls so far · 4s elapsed');
    expect(text).toContain('Tokens this run: 0 in + 0 out = 0');
    expect(text).not.toContain('Context growth');
    expect(text).not.toContain('This conversation:');
  });

  it('压缩过(最近一次实测比头一次小)→ 不报涨幅;占用越过压缩线 → 余量 0,不出负数', () => {
    const shrunk = renderRunStatus(status({ context: { firstPrompt: 200_000, lastPrompt: 60_000 } }), 1_000_000);
    expect(shrunk).not.toContain('Context growth');
    const over = renderRunStatus(status({ context: { used: 260_000 } }), 1_000_000);
    expect(over).toContain('about 0 tokens of room remain before that');
  });

  it('formatDuration / dbTimeMs:SQLite 的 CURRENT_TIMESTAMP 按 UTC 读,带时区的原样,读不出给 undefined', () => {
    expect([0, 59_400, 60_000, 3_599_000, 3_600_000, 90_000_000].map(formatDuration)).toEqual(['0s', '59s', '1m 0s', '59m 59s', '1h 0m', '1d 1h']);
    expect(dbTimeMs('2026-10-10 10:00:00')).toBe(Date.UTC(2026, 9, 10, 10, 0, 0));
    expect(dbTimeMs('2026-10-10T10:00:00+08:00')).toBe(Date.UTC(2026, 9, 10, 2, 0, 0));
    expect(dbTimeMs(new Date(5))).toBe(5);
    expect([dbTimeMs(null), dbTimeMs(''), dbTimeMs('nope')]).toEqual([undefined, undefined, undefined]);
  });

  it('登记表:按会话取在跑的那条;撤掉后取不到', () => {
    registerLiveRun('R1', 'S1', () => status({ runId: 'R1', sessionId: 'S1' }));
    expect(liveRunStatus('S1')?.runId).toBe('R1');
    expect(liveRunStatus('other')).toBeUndefined();
    unregisterLiveRun('R1');
    expect(liveRunStatus('S1')).toBeUndefined();
  });
});

describe('可见性', () => {
  const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
  const base: ToolContext = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp', unlockTools: () => {} };
  const everywhere = (ctx: ToolContext) => [...listDeferredTools(ctx).map((d) => d.name), ...getToolDefinitions(ctx).map((t: any) => t.function?.name)];

  it('前台 run:work / coding / chat(聊天会话 = sandbox + chat 面)都在按需目录里,不进常驻定义;计划模式下也在', () => {
    configureTangu({ host: stub, brain: stub, billing: stub, profile });
    for (const ctx of [
      base, { ...base, preset: 'coding' as const }, { ...base, execMode: 'sandbox' as const },
      { ...base, preset: 'chat' as const, execMode: 'sandbox' as const, cwd: undefined }, { ...base, planMode: true },
    ]) {
      expect(listDeferredTools(ctx).map((d) => d.name), JSON.stringify({ preset: ctx.preset, execMode: ctx.execMode, planMode: ctx.planMode })).toContain('session_status');
      expect(getToolDefinitions(ctx).map((t: any) => t.function?.name)).not.toContain('session_status');
      expect(getToolDefinitions({ ...ctx, unlockedTools: new Set(['session_status']) }).map((t: any) => t.function?.name)).toContain('session_status');
    }
  });

  it('子代理(ctx 是父 run 的展开)/ 讨论成员 / Muse / 自动化 / 一次性 run:不给', () => {
    for (const ctx of [
      { ...base, subAgentDepth: 1 }, { ...base, inDiscussion: true }, { ...base, muse: true },
      { ...base, automationOrigin: 'rule-1' }, { ...base, ephemeral: true },
    ]) expect(everywhere(ctx)).not.toContain('session_status');
  });

  it('只读:任何档都不过审批;宿主沙箱开着也放行(不收路径、不执行东西)', () => {
    for (const m of ['readonly', 'auto-edit', 'full-auto', undefined] as const) expect(toolNeedsApproval('session_status', m)).toBe(false);
    expect(isHostSandboxToolAllowed('session_status', { execMode: 'host', hostSandbox: { mode: 'read-only', network: 'deny' } as any })).toBe(true);
  });

  it('没有循环给数的调用方(旁路循环):如实说拿不到,不编', async () => {
    const r = await executeTool({ id: 'c1', type: 'function', function: { name: 'session_status', arguments: '{}' } } as any, { ...base, unlockedTools: new Set(['session_status']) });
    expect(String(r.result)).toBe('Session status is not available in this kind of run.');
  });
});

// ── 真 SQLite + 真 loop(fake llm 按调用序号出剧本) ──
let home: string | null = null;
let calls = 0;
type Script = (call: number) => { content: string; toolCalls: any[]; finishReason: string };
let script: Script = () => ({ content: 'ok', toolCalls: [], finishReason: 'stop' });

async function setupReal(): Promise<void> {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const brain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => { calls++; return { messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }; },
      streamProviderCompletion: async () => {
        const s = script(calls);
        // 每次调用的输入涨 1000:涨幅那行有数可核
        return { content: s.content, reasoning: '', toolCalls: s.toolCalls, usage: { prompt_tokens: 10_000 + calls * 1_000, completion_tokens: 50, cached_tokens: 4_000 }, finishReason: s.finishReason };
      },
    },
    users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false, listModelsForProject: async () => ({ models: [{ id: 'm1', name: 'M1', provider: 'p' }], defaultModelId: 'm1' }) },
  };
  const billing: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain, billing, profile });
  await runMigration();
}
afterEach(() => {
  delete process.env.TANGU_HOME;
  if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } home = null; }
});

describe('真 loop', () => {
  beforeAll(setupReal);

  it('工具读到循环里的实数:第 3 步、2 次调用、累计 token、涨幅;run 结束后登记撤掉', async () => {
    home = mkdtempSync(join(tmpdir(), 'tangu-sstat-'));
    process.env.TANGU_HOME = home;
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES ('L', 'u1', 'tangu', 't', 'm1', 'user', '{}')`);
    // 更早的一条 run:tokens_total 已落库,建于 2 小时前(SQLite 口径的 UTC 串)
    const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString().slice(0, 19).replace('T', ' ');
    await query(`INSERT INTO agent_runs (id, session_id, user_id, app_id, status, tokens_total, created_at) VALUES ('OLD', 'L', 'u1', 'tangu', 'done', 5000, ?)`, [twoHoursAgo]);
    calls = 0;
    const tc = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    script = (n) => n === 1
      ? { content: '', toolCalls: [tc('t1', 'load_tools', { names: ['session_status'] })], finishReason: 'tool_calls' }
      : n === 2
        ? { content: '', toolCalls: [tc('t2', 'session_status', {})], finishReason: 'tool_calls' }
        : { content: 'done', toolCalls: [], finishReason: 'stop' };
    const results: any[] = [];
    let seenLive = false;
    const off = subscribe('RS', (ev) => {
      if (ev.type !== 'tool_result') return;
      results.push(ev.payload);
      if (ev.payload?.name === 'session_status') seenLive = liveRunStatus('L')?.runId === 'RS'; // 路由读的那份:run 在跑时取得到
    });
    await createRun({
      id: 'RS', sessionId: 'L', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'RS-a',
      input: { message: 'how much context is left?', userMessageId: 'RS-u', attachments: [], agentConfig: { execMode: 'host', cwd: home, approvalMode: 'full-auto' } },
    });
    enqueueRun('L', 'RS');
    const t0 = Date.now();
    for (;;) {
      const r = await getRun('RS');
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); break; }
      if (Date.now() - t0 > 8000) throw new Error('run 未结束');
      await new Promise((res) => setTimeout(res, 25));
    }
    off();
    const text = String(results.find((p) => p.name === 'session_status')?.result ?? '');
    expect(text).toContain('Model: m1');
    expect(text).toMatch(/Context: about [\d,]+ of [\d,]+ tokens in use/); // 第 2 次调用已有实测基准
    expect(text).toMatch(/This run: step 2 of at most \d+ · 2 model calls so far · \d+s elapsed/);
    expect(text).toContain('Tokens this run: 23,000 in (8,000 served from cache) + 100 out = 23,100'); // 11000 + 12000
    expect(text).toContain('Context growth: about 1,000 tokens per step so far');
    expect(text).toMatch(/This conversation: 1 earlier run used 5,000 tokens; it started 2h 0m ago\./);
    expect(seenLive).toBe(true);
    expect(liveRunStatus('L')).toBeUndefined();
  });
});
