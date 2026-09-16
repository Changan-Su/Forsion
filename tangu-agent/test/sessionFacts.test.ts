/**
 * 轨道身份类会话事实(新工作区 × 轨道体系 P0):
 * 路由级 —— LOCKED_SESSION_FACT_KEYS 逐键锁(空白会话 / 缺键老会话可改;有消息后存值不可被整对象 PUT 改掉)、三个身份键互斥与合法性校验;
 * loop 级 —— 存值为准的条件绑定:私聊会话的 agentSlug 被 soloAgentSlug 钉死、run 带 groupChat:true 也不进群聊分叉、
 *            run 带别的键绝不反向补锁(老会话缺键 = 不是私聊)。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { builtinAgentDef, saveAgent, libDirOf, getAgent } from '../src/agents/agentRegistry.js';
import { DEFAULT_AGENT_SLUG, agentsDir } from '../src/core/tanguHome.js';
import { LOCKED_SESSION_FACT_KEYS, applySessionFactLock, applyPresetLock, validSessionFacts } from '../src/routes/sessions.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun, pickSessionFacts, bindSessionFacts, storedSessionFacts } from '../src/services/agentLoop.js';

describe('路由级:会话事实锁与校验', () => {
  it('锁集只含轨道身份键;运行模式键(groupChat/groupAgents)恒不在锁集', () => {
    expect([...LOCKED_SESSION_FACT_KEYS]).toEqual(['preset', 'soloAgentSlug', 'soloEngineId', 'teamSlug']);
    for (const k of ['groupChat', 'groupAgents', 'groupTempAgents', 'agentSlug']) expect((LOCKED_SESSION_FACT_KEYS as readonly string[]).includes(k)).toBe(false);
  });

  it('applySessionFactLock:有消息 → 存值里已有的锁定键逐个压回 PUT;缺键的照 PUT;空白会话原样', () => {
    const stored = { preset: 'chat', soloAgentSlug: 'ario', groupChat: true };
    expect(applySessionFactLock(stored, { preset: null, soloAgentSlug: 'bo', groupChat: false, teamSlug: 'x' }, 2))
      .toEqual({ preset: 'chat', soloAgentSlug: 'ario', groupChat: false, teamSlug: 'x' }); // teamSlug 存值无键 → 不锁;groupChat 运行模式 → 可改
    expect(applySessionFactLock(stored, { thinkingLevel: 'high' }, 1)).toEqual({ thinkingLevel: 'high', preset: 'chat', soloAgentSlug: 'ario' }); // 漏传也补回
    expect(applySessionFactLock(stored, { soloAgentSlug: 'bo' }, 0)).toEqual({ soloAgentSlug: 'bo' }); // 空白会话可改
    expect(applySessionFactLock({ groupChat: true }, { soloAgentSlug: 'bo' }, 5)).toEqual({ soloAgentSlug: 'bo' }); // 老会话无任何锁定键 → 整体替换
    expect(applySessionFactLock(null, { preset: 'chat' }, 5)).toEqual({ preset: 'chat' });
  });

  it('applyPresetLock 旧名仍成立(preset 单键语义逐字不变)', () => {
    expect(applyPresetLock({ preset: 'chat', x: 1 }, { thinkingLevel: 'high' }, 3)).toEqual({ thinkingLevel: 'high', preset: 'chat' });
    expect(applyPresetLock({ preset: null }, { preset: 'chat' }, 1)).toEqual({ preset: null });
    expect(applyPresetLock({ x: 1 }, { preset: 'chat' }, 1)).toEqual({ preset: 'chat' });
  });

  it('validSessionFacts:合法 slug / engine id 通过;非法 400 口径;三个身份键互斥;preset 仍走 validPreset', () => {
    expect(validSessionFacts(null)).toBeNull();
    expect(validSessionFacts({ soloAgentSlug: 'ario', preset: 'coding' })).toBeNull();
    expect(validSessionFacts({ soloEngineId: 'claude-code' })).toBeNull();
    expect(validSessionFacts({ teamSlug: 'team-abc', groupAgents: ['a', 'b'], groupChat: true })).toBeNull();
    expect(validSessionFacts({ soloAgentSlug: '../etc' })).toBe('invalid soloAgentSlug');
    expect(validSessionFacts({ teamSlug: 'Has Space' })).toBe('invalid teamSlug');
    expect(validSessionFacts({ soloEngineId: 'a/b' })).toBe('invalid soloEngineId');
    expect(validSessionFacts({ soloAgentSlug: 'ario', teamSlug: 'abc' })).toMatch(/mutually exclusive/);
    expect(validSessionFacts({ preset: 'work' })).toBe('invalid preset');
    expect(validSessionFacts({ soloAgentSlug: null, soloEngineId: undefined })).toBeNull(); // null/undefined = 未设
  });
});

describe('loop 级:pickSessionFacts / bindSessionFacts(纯函数)', () => {
  it('只认非空串;绑定后私聊钉死 agentSlug 且抹掉 groupChat/engineId;独立团队恒 groupChat', () => {
    expect(pickSessionFacts({ soloAgentSlug: 'ario', soloEngineId: '', teamSlug: 3 })).toEqual({ soloAgentSlug: 'ario' });
    expect(pickSessionFacts('junk')).toEqual({});
    const a: any = { agentSlug: 'other', groupChat: true, groupAgents: ['a', 'b'], engineId: 'codex', soloAgentSlug: 'stale' };
    bindSessionFacts(a, {});
    expect(a).toEqual({ agentSlug: 'other', groupChat: true, groupAgents: ['a', 'b'], engineId: 'codex' }); // 缺键 = 不是私聊,run 带的 soloAgentSlug 被剥掉
    const b: any = { agentSlug: 'other', groupChat: true, engineId: 'codex' };
    bindSessionFacts(b, { soloAgentSlug: 'ario' });
    expect(b).toMatchObject({ agentSlug: 'ario', soloAgentSlug: 'ario' });
    expect(b.groupChat).toBeUndefined();
    expect(b.engineId).toBeUndefined();
    const c: any = { engineId: 'other', groupChat: true };
    bindSessionFacts(c, { soloEngineId: 'codex' });
    expect(c).toMatchObject({ engineId: 'codex', soloEngineId: 'codex' });
    expect(c.groupChat).toBeUndefined();
    const d: any = { groupChat: false, engineId: 'codex' };
    bindSessionFacts(d, { teamSlug: 'abc' });
    expect(d).toMatchObject({ groupChat: true, teamSlug: 'abc' });
    expect(d.engineId).toBeUndefined();
  });
});

// ── loop 级 harness(同 chatPreset.test.ts):真内存 SQLite + 真 loop,fake llm 每轮直接收尾 ──
let cleanupHome: string | null = null;
let llmPayloads: any[] = [];
afterEach(() => {
  delete process.env.TANGU_HOME;
  if (cleanupHome) { try { rmSync(cleanupHome, { recursive: true, force: true }); } catch { /* ignore */ } cleanupHome = null; }
});

async function setupLoop(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'tangu-sessionfacts-'));
  cleanupHome = home;
  process.env.TANGU_HOME = home;
  llmPayloads = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
    streamProviderCompletion: async (o: any) => {
      llmPayloads.push(o.payload);
      return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'stop' };
    },
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
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const builtin = builtinAgentDef(DEFAULT_AGENT_SLUG)!;
  await saveAgent({ slug: DEFAULT_AGENT_SLUG, name: builtin.name, description: builtin.description, systemPrompt: builtin.systemPrompt, soul: builtin.soul });
  await saveAgent({ slug: 'other', name: 'Other', description: 'x', systemPrompt: 'You are Other.' });
}

async function runToEnd(sessionId: string, runId: string, agentConfig: Record<string, unknown>): Promise<string> {
  await createRun({
    id: runId, sessionId, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: `hi ${runId}`, userMessageId: `${runId}-u`, attachments: [], agentConfig },
  });
  enqueueRun(sessionId, runId);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return String(r.status);
    if (Date.now() - t0 > 8000) throw new Error('run 未结束');
    await new Promise((res) => setTimeout(res, 25));
  }
}

const storedCfg = async (sessionId: string): Promise<any> => {
  const rows = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [sessionId]);
  const cfg = rows[0]?.agent_config;
  return typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
};
const lastSystem = (): string => String(llmPayloads[llmPayloads.length - 1]?.messages?.[0]?.content || '');

describe('loop 级:私聊会话的条件绑定(存值为准)', () => {
  it('存值 soloAgentSlug=xyra:run 带 agentSlug=other + groupChat:true → 仍按 xyra 单人跑,存值 agentSlug 被纠回 xyra', async () => {
    await setupLoop();
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user', 1, ?)`,
      [JSON.stringify({ soloAgentSlug: DEFAULT_AGENT_SLUG, agentSlug: 'other', execMode: 'sandbox' })]);
    expect(await storedSessionFacts('S')).toEqual({ soloAgentSlug: DEFAULT_AGENT_SLUG });
    const status = await runToEnd('S', 'R1', { agentSlug: 'other', groupChat: true, groupAgents: ['other', DEFAULT_AGENT_SLUG], execMode: 'sandbox' });
    expect(status).toBe('done'); // 没进群聊分叉(进了会因 fake llm 不吐投票/或 2 人正常跑;这里以系统提示证明是单人 loop)
    expect(lastSystem()).toContain('Tangu Arioso'); // 默认 agent 的人格,不是 Other
    expect(lastSystem()).not.toContain('You are Other.');
    expect((await storedCfg('S')).agentSlug).toBe(DEFAULT_AGENT_SLUG);
    expect((await storedCfg('S')).soloAgentSlug).toBe(DEFAULT_AGENT_SLUG);
  });

  it('负对照:普通会话(存值缺键)run 带 soloAgentSlug 绝不反向补锁,仍按 run 的 agentSlug 跑', async () => {
    await setupLoop();
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('N', 'u1', 'tangu', 't', 'm1', 'user')`);
    const status = await runToEnd('N', 'R1', { agentSlug: 'other', soloAgentSlug: DEFAULT_AGENT_SLUG, execMode: 'sandbox' });
    expect(status).toBe('done');
    expect(lastSystem()).toContain('You are Other.');
    const cfg = await storedCfg('N');
    expect(cfg.agentSlug).toBe('other');
    expect(Object.prototype.hasOwnProperty.call(cfg, 'soloAgentSlug')).toBe(false);
  });
});

describe('agentRegistry:libDirOf 导出 + libraryDir 随本地 agent 定义返回', () => {
  it('getAgent 的定义带 libraryDir = agentsDir()/<slug>/Library', async () => {
    await setupLoop();
    const def = await getAgent('other');
    expect(def?.libraryDir).toBe(join(agentsDir(), 'other', 'Library'));
    expect(libDirOf('other')).toBe(def?.libraryDir);
  });
});
