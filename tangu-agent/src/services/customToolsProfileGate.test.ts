/**
 * profile.features.customTools 的运行期闸(09-22 修):此前这个开关只活在类型 / mergeProfile / admin 面板 /
 * Connect manifest(customTools:false)里,运行期**没有任何代码读它** —— 主 loop 与具名子代理照样
 * loadCustomTools,关了等于没关。本块钉两处装载点,每处一对正 / 负对照:
 *   ① 主 loop(agentLoop.runLoop):flag=false → loadCustomTools 不被调用、工具面没有自定义工具、
 *      模型凭名字直调也执行不到;flag=true → 照旧装载、进工具面、能执行(正对照:证明 mock 真接上了,
 *      负例的「没有」不是因为探针压根到不了)。
 *   ② 具名子代理(subAgent.runSubAgent 里 def.tools 非空的重载分支):同上一对。
 * flag 一律经**真实覆盖链路**注入(createProfileStore 的 fileOverrides → mergeProfile),不手改 baseline:
 * checked-in 的 APP_PROFILE_OVERRIDES 给 'tangu' 写死了 customTools:true,只改 baseline 会被它压回 true、负例空转。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { PROBE, loadSpy, execSpy } = vi.hoisted(() => {
  const PROBE = 'zz_custom_probe';
  const tool = {
    name: PROBE, executor: 'http' as const, source: 'custom_tools',
    http: { url: 'https://example.invalid/probe', method: 'GET', headers: {} },
    definition: { type: 'function', function: { name: PROBE, description: 'custom tool probe', parameters: { type: 'object', properties: {} } } },
  };
  return {
    PROBE,
    loadSpy: vi.fn(async (_appId: string, _agentConfig: any) => [tool]),
    execSpy: vi.fn(async () => 'PROBE-EXECUTED'),
  };
});
// 保留原模块其余导出;只换装载与执行两个入口(registry 的 executeTool 也经这里调 executeCustomTool)。
vi.mock('../tools/customTools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/customTools.js')>()),
  loadCustomTools: loadSpy,
  executeCustomTool: execSpy,
}));

import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createProfileStore } from '../profiles/profileStore.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { saveAgent } from '../agents/agentRegistry.js';
import { createRun, getRun } from './runStore.js';
import { enqueueRun } from './agentLoop.js';
import { runSubAgent } from './subAgent.js';
import type { AppProfile } from '../seams/appProfile.js';
import type { ToolContext } from '../tools/registry.js';

const USER = 'u1';
let home: string | null = null;
/** 带工具面的 LLM 调用(主 loop / 子代理的推理轮);无工具面的旁路调用不记。 */
let payloads: any[] = [];
let probed = false;

afterEach(() => {
  delete process.env.TANGU_HOME;
  if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } home = null; }
});

/** 真内存 SQLite + 真 loop;经 profileStore 文件覆盖层给 'tangu' 设 customTools=flag。返回 run 实际会解析到的 profile。 */
async function setup(flag: boolean): Promise<AppProfile> {
  home = mkdtempSync(join(tmpdir(), 'tangu-ctgate-'));
  process.env.TANGU_HOME = home;
  payloads = [];
  probed = false;
  loadSpy.mockClear();
  execSpy.mockClear();
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
    streamProviderCompletion: async (o: any) => {
      const withTools = Array.isArray(o.payload?.tools) && o.payload.tools.length > 0;
      if (withTools) payloads.push(o.payload);
      // 首个推理轮:不管工具面里有没有,都凭名字直调探针(模型绕过工具面的那条路);之后收尾。
      if (withTools && !probed) {
        probed = true;
        return {
          content: '', reasoning: '', finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 5 },
          toolCalls: [{ id: 'tc1', type: 'function', function: { name: PROBE, arguments: '{}' } }],
        };
      }
      return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'stop' };
    },
  };
  const fakeBrain: any = {
    llm: fakeLlm,
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  const baseline = createTanguProfile({ sandboxMode: 'none' });
  const profileStore = createProfileStore({ baseline, fileOverrides: { tangu: { features: { customTools: flag } } } });
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: baseline, profileStore });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
  const resolved = profileStore.resolve('tangu')!;
  expect(resolved.features.customTools, '覆盖链路没把 flag 送到位 → 本块前提不成立').toBe(flag);
  return resolved;
}

const toolNames = (p: any): string[] => ((p?.tools ?? []) as any[]).map((t) => t?.function?.name);
const lastToolMsg = (p: any): string => String(((p?.messages ?? []) as any[]).filter((m) => m.role === 'tool').pop()?.content ?? '');

async function runToDone(runId: string, agentConfig: Record<string, unknown>): Promise<void> {
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'hi', userMessageId: `${runId}-u`, attachments: [], agentConfig },
  });
  enqueueRun('S', runId);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); return; }
    if (Date.now() - t0 > 8000) throw new Error('run 未结束');
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe('主 loop:profile.features.customTools 闸', () => {
  it('flag=false → 不装载;工具面没有探针;凭名字直调也执行不到', async () => {
    await setup(false);
    await runToDone('RL-off', { execMode: 'sandbox', enabledToolIds: ['ct1'] });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(toolNames(payloads[0]).length, '工具面整个空了 → 「不含探针」是空转').toBeGreaterThan(0);
    expect(toolNames(payloads[0])).not.toContain(PROBE);
    expect(execSpy).not.toHaveBeenCalled();
    expect(lastToolMsg(payloads[1])).toContain('is not available in this session');
  }, 20_000);

  it('flag=true(正对照)→ 照旧装载、进工具面、可执行', async () => {
    await setup(true);
    await runToDone('RL-on', { execMode: 'sandbox', enabledToolIds: ['ct1'] });
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy.mock.calls[0][0]).toBe('tangu');
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(toolNames(payloads[0])).toContain(PROBE);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(lastToolMsg(payloads[1])).toContain('PROBE-EXECUTED');
  }, 20_000);
});

describe('具名子代理:def.tools 重载分支同闸', () => {
  /** 具名 agent 带 tools 白名单 → 走 runSubAgent 的重载分支;父 ctx 不带 customTools(与 flag 关时的主 loop 一致)。 */
  async function runNamedSub(parentRunId: string, profile: AppProfile): Promise<void> {
    await createRun({
      id: parentRunId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${parentRunId}-a`,
      input: { message: '干活', userMessageId: `${parentRunId}-u`, attachments: [], agentConfig: {} },
    });
    await saveAgent({ slug: 'probe-agent', name: 'Probe', systemPrompt: 'You are a probe agent.', tools: ['ct1'] });
    // execMode='sandbox':gateToolCall 对非 mcp 工具直接放行,测试不依赖审批订阅者。
    const parentCtx = {
      userId: USER, sessionId: 'S', appId: 'tangu', runId: parentRunId, profile, execMode: 'sandbox', thinkingLevel: 'medium',
    } as unknown as ToolContext;
    await runSubAgent({ task: '调一下探针', parentCtx, modelId: 'm1', agentSlug: 'probe-agent' });
  }

  it('flag=false → 不按 def.tools 重载;工具面没有探针;凭名字直调也执行不到', async () => {
    const profile = await setup(false);
    await runNamedSub('RS-off', profile);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(toolNames(payloads[0]).length, '工具面整个空了 → 「不含探针」是空转').toBeGreaterThan(0);
    expect(toolNames(payloads[0])).not.toContain(PROBE);
    expect(execSpy).not.toHaveBeenCalled();
    expect(lastToolMsg(payloads[1])).toContain('is not available in this session');
  }, 20_000);

  it('flag=true(正对照)→ 按 def.tools 重载、进工具面、可执行', async () => {
    const profile = await setup(true);
    await runNamedSub('RS-on', profile);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith('tangu', { enabledToolIds: ['ct1'] });
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(toolNames(payloads[0])).toContain(PROBE);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(lastToolMsg(payloads[1])).toContain('PROBE-EXECUTED');
  }, 20_000);
});
