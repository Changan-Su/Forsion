/**
 * Ultra 档(对标 Codex Ultra:max 思考 + 主动并行委派)与子代理计入 run 成本闸。
 *
 * loop 级(真内存 SQLite + 真 agentLoop,假模型按脚本出招):
 *   ① ultra ⇒ 系统提示末尾带 Ultra 段、请求档恒 max(存值 high 也不看);
 *   ② 负对照:不开 ultra / chat 预设(没有 delegate)/ Muse 无人值守 / toolsMode 拒掉 delegate → 都不注入;
 *      云端形态(没有 hostExec)在 registry 层就拿不到 delegate;
 *   ③ 成本闸:子代理(noopBilling)每轮的计价记进父 run —— 同一脚本在改动前是 done,现在按 run_cost_exceeded 收尾,
 *      且子代理把 run 推过上限后父 run 不再多调一次模型;上限 0 = 关闭,照旧 done;子代理越限前自己停(调模型之前查)。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createAiStudioProfile, createTanguProfile } from '../src/profiles/index.js';
import { resolveTools } from '../src/tools/toolRegistry.js';
import type { ToolContext } from '../src/tools/registry.js';
import { ULTRA_SECTION } from '../src/profiles/promptSections.js';
import { exhaustedReport } from '../src/services/subAgent.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { CONTEXT_WINDOW_TOKENS } from '../src/services/contextBudget.js';
import { resetModelOverridesForTest } from '../src/services/modelOverrides.js';

const ULTRA_HEAD = ULTRA_SECTION.split('\n')[0];

type Payload = { messages: any[]; tools?: any[]; thinkingLevel?: string; cacheKey?: string };
let cleanupHome: string | null = null;
let payloads: Payload[] = [];
/** 每次 LLM 调用的出招;缺省一轮直接收尾。子代理的调用按 cacheKey 带 `:sub:` 区分。 */
let respond: (p: Payload) => any = () => done('ok');
let costPerCall = 0;
/** 假模型对象上额外的字段(如 context_window:模型自报的窗口)。 */
let modelExtra: Record<string, unknown> = {};

const done = (content: string) => ({ content, reasoning: '', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'stop' });
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  content: '', reasoning: '', finishReason: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 5 },
  toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const isSub = (p: Payload) => String(p.cacheKey || '').includes(':sub:');

afterEach(() => {
  delete process.env.TANGU_HOME;
  delete process.env.TANGU_MAX_RUN_COST;
  if (cleanupHome) { try { rmSync(cleanupHome, { recursive: true, force: true }); } catch { /* ignore */ } cleanupHome = null; }
});

async function setupLoop(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'tangu-ultra-'));
  cleanupHome = home;
  process.env.TANGU_HOME = home;
  payloads = [];
  respond = () => done('ok');
  costPerCall = 0;
  modelExtra = {};
  resetModelOverridesForTest(); // 覆盖层钉成内存表:不读开发机 / 共享域里的 config.json
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', ...modelExtra }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools, thinkingLevel: o.thinkingLevel, cacheKey: o.cacheKey }),
    streamProviderCompletion: async (o: any) => { payloads.push(o.payload); return respond(o.payload); },
  };
  const fakeBrain: any = {
    llm: fakeLlm,
    users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => costPerCall,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
}

let sessionSeq = 0;
/** 新建一个空白会话(可带存值配置)并跑一个 run 到终态,返回终态行。 */
async function runOnce(agentConfig: Record<string, unknown>, stored?: Record<string, unknown>): Promise<any> {
  const sid = `S${++sessionSeq}`;
  const rid = `R${sessionSeq}`;
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES (?, 'u1', 'tangu', 't', 'm1', 'user', ?)`,
    [sid, stored ? JSON.stringify(stored) : null]);
  await createRun({
    id: rid, sessionId: sid, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `${rid}-a`,
    input: { message: `hi ${rid}`, userMessageId: `${rid}-u`, attachments: [], agentConfig: { execMode: 'sandbox', ...agentConfig } },
  });
  enqueueRun(sid, rid);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(rid);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > 8000) throw new Error('run 未结束');
    await new Promise((res) => setTimeout(res, 25));
  }
}

const mainPayloads = () => payloads.filter((p) => !isSub(p));
const firstSystem = () => String(mainPayloads()[0]?.messages?.[0]?.content || '');

describe('Ultra:提示段与思考档', () => {
  it('开 ultra:系统提示带 Ultra 段(在末尾)、请求档恒 max —— 存值 high 也不看', async () => {
    await setupLoop();
    const r = await runOnce({ ultra: true, thinkingLevel: 'high' });
    expect(r.status).toBe('done');
    const sys = firstSystem();
    expect(sys).toContain(ULTRA_HEAD);
    expect(sys.trimEnd().endsWith(ULTRA_SECTION.split('\n').slice(-1)[0])).toBe(true); // 追加在末尾,只在开关那一刻动前缀
    expect(mainPayloads()[0].thinkingLevel).toBe('max');
    expect((mainPayloads()[0].tools || []).map((t: any) => t.function?.name)).toContain('delegate');
  });

  it('负对照:不开 ultra → 没有 Ultra 段,档位照存值(缺省中)', async () => {
    await setupLoop();
    await runOnce({});
    expect(firstSystem()).not.toContain(ULTRA_HEAD);
    expect(mainPayloads()[0].thinkingLevel).toBe('medium');
    payloads = [];
    await runOnce({ thinkingLevel: 'high' });
    expect(mainPayloads()[0].thinkingLevel).toBe('high');
  });

  it('负对照:拿不到 delegate 的 run 不注入 —— chat 预设 / 被委派出来的会话(子代理深度 1)', async () => {
    await setupLoop();
    const toolNames = () => (mainPayloads()[0].tools || []).map((t: any) => t.function?.name);
    await runOnce({ ultra: true, preset: 'chat' });
    expect(toolNames()).not.toContain('delegate');
    expect(firstSystem()).not.toContain(ULTRA_HEAD);
    payloads = [];
    await runOnce({ ultra: true }, { delegatedFrom: 'S-parent', delegatedBy: 'xyra' });
    expect(toolNames()).not.toContain('delegate');
    expect(firstSystem()).not.toContain(ULTRA_HEAD);
  });

  it('负对照:Muse 这类无人值守 run 抄到了 ultra 也不扇出(deferBypass)', async () => {
    await setupLoop();
    await runOnce({ ultra: true, muse: true });
    expect(firstSystem()).not.toContain(ULTRA_HEAD);
  });

  it('云端形态没有 hostExec:registry 层就拿不到 delegate(Ultra 段的闸复用这一处判定)', () => {
    const cloud = createAiStudioProfile();
    const local = createTanguProfile({ sandboxMode: 'none' });
    const ctx = (profile: any): ToolContext => ({ userId: 'u1', sessionId: 's', appId: profile.appId, profile, execMode: 'sandbox', unlockTools: () => {} } as ToolContext);
    expect(resolveTools(cloud, ctx(cloud)).has('delegate')).toBe(false);
    expect(resolveTools(local, ctx(local)).has('delegate')).toBe(true);
    expect(resolveTools(local, { ...ctx(local), subAgentDepth: 1 }).has('delegate')).toBe(false); // 子代理看不见 → 也看不见 Ultra 段
  });
});

describe('Ultra:模型支持更高的上下文就拉满(09-27,不封顶 272k)', () => {
  const ctxInfo = async (runId: string) => {
    const rows = await query<any[]>(`SELECT payload FROM agent_run_events WHERE run_id = ? AND type = 'status' ORDER BY seq`, [runId]);
    return rows.map((x) => (typeof x.payload === 'string' ? JSON.parse(x.payload) : x.payload)).find((p) => p?.phase === 'context_info');
  };

  it('1M 模型:开 Ultra → 窗口与压缩线按 1M;不开 → 仍封顶(负对照)', async () => {
    await setupLoop();
    modelExtra = { context_window: 1_000_000 };
    const on = await ctxInfo((await runOnce({ ultra: true, thinkingLevel: 'max' })).id);
    expect(on).toMatchObject({ ctxWindow: 1_000_000, ctxWindowSource: 'model', ctxWindowMax: 1_000_000, ultra: true });
    const off = await ctxInfo((await runOnce({ thinkingLevel: 'max' })).id);
    expect(off).toMatchObject({ ctxWindow: CONTEXT_WINDOW_TOKENS, ctxWindowSource: 'model', ctxWindowMax: 1_000_000, ultra: false });
    expect(on.compactAt).toBeGreaterThan(off.compactAt);
  });

  it('人填的覆盖照旧:本机把这个模型设成 500k,开 Ultra 也是 500k(覆盖可能正是在纠正报大了的目录值)', async () => {
    await setupLoop();
    modelExtra = { context_window: 1_000_000 };
    resetModelOverridesForTest({ m1: { contextWindow: 500_000 } });
    expect(await ctxInfo((await runOnce({ ultra: true, thinkingLevel: 'max' })).id)).toMatchObject({ ctxWindow: 500_000, ctxWindowSource: 'override' });
  });
});

describe('子代理计入 run 成本闸(TANGU_MAX_RUN_COST)', () => {
  /** 主 loop 首轮并行派两个子代理,子代理各一轮收尾,主 loop 第二轮收尾。每次 LLM 调用计价 1 点。 */
  const fanOutScript = () => {
    let mainTurn = 0;
    respond = (p) => {
      if (isSub(p)) return done('sub report');
      mainTurn += 1;
      if (mainTurn > 1) return done('final');
      const two = call('d1', 'delegate', { task: 'look at A' });
      two.toolCalls.push(call('d2', 'delegate', { task: 'look at B' }).toolCalls[0]);
      return two;
    };
  };

  it('主 1 点 + 子代理 2 点 = 3 > 上限 2.5 → run_cost_exceeded,且父 run 不再多调一次模型(不记子代理时主 2 点,会是 done)', async () => {
    await setupLoop();
    costPerCall = 1;
    process.env.TANGU_MAX_RUN_COST = '2.5';
    fanOutScript();
    const r = await runOnce({});
    expect(payloads.filter(isSub)).toHaveLength(2); // 两个子代理确实各跑了一轮
    expect(mainPayloads()).toHaveLength(1); // 工具批回来即判越限,不先发第二次主请求(creview 09-27 P1)
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r)).toContain('run_cost_exceeded');
  });

  it('上限 0 = 关闭:同一脚本照旧 done', async () => {
    await setupLoop();
    costPerCall = 1;
    process.env.TANGU_MAX_RUN_COST = '0';
    fanOutScript();
    const r = await runOnce({});
    expect(r.status).toBe('done');
  });

  it('子代理在调模型之前查闸:越限就停,交回「别再派」的报告,不会烧满 24 轮', async () => {
    await setupLoop();
    costPerCall = 1;
    process.env.TANGU_MAX_RUN_COST = '3.5';
    let mainTurn = 0;
    respond = (p) => {
      if (isSub(p)) return call(`g${payloads.length}`, 'get_datetime', {}); // 子代理永远不收尾,只能靠闸停下
      mainTurn += 1;
      return mainTurn > 1 ? done('final') : call('d1', 'delegate', { task: 'loop forever' });
    };
    const r = await runOnce({});
    // 主首轮 1 点;子代理 1→2→3 点各调一次,第 4 次前 1+3=4 > 3.5 停下。
    expect(payloads.filter(isSub)).toHaveLength(3);
    const results = await query<any[]>(`SELECT payload FROM agent_run_events WHERE run_id = ? AND type = 'tool_result'`, [r.id]);
    const delegated = results.map((x) => (typeof x.payload === 'string' ? JSON.parse(x.payload) : x.payload)).find((p) => p?.name === 'delegate');
    expect(String(delegated?.result || '')).toContain('reached its cost ceiling');
    expect(mainPayloads()).toHaveLength(1); // 父 run 在下一次主请求前就收尾
    expect(r.status).toBe('failed');
  });

  it('exhaustedReport:越限停下的报告即使没有任何工具记录也说明原因', () => {
    expect(exhaustedReport(null, null, false, true)).toContain('cost ceiling');
    expect(exhaustedReport(null, null)).toBe('(the sub-agent produced no conclusion)');
  });
});
