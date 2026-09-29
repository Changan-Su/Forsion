/**
 * agent 自调会话设置(session_settings / update_session_settings)+ 模型目录解析:
 *   - resolveModelQuery:精确 / 名称 / vendor:model / ollama tag / 唯一子串 / 歧义 / 无;effectiveThinkingOn 与能力表同一 clamp
 *   - 可见性:只给前台 host run(子代理 / 讨论 / Muse / 自动化 / 沙箱一律不可见),且 deferred
 *   - 审批:写工具 command 档(询问我批准 / 替我批准 要批,完全放行自动过),读工具不过闸
 *   - 执行:模型写 chat_sessions.model_id、思考档按键合并写 agent_config、发 session_config_changed;歧义 / 未知 / 坏档位零改动
 *   - 真 loop:本 run 内改思考档,下一次请求就换档(模型仍按 run 定格)
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
import { effectiveThinkingOn, resolveModelQuery, type CatalogModel } from '../src/services/modelCatalog.js';
import { takeRunThinking } from '../src/services/sessionSettings.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const M = (id: string, name = id, thinkingLevels?: any[]): CatalogModel =>
  ({ id, name, provider: 'p', source: 'forsion', modelType: 'llm', contextWindow: 1, contextWindowSource: 'default', supportsVision: true, thinkingLevels });

const CLOUD = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', provider: 'openai' },
  { id: 'img-1', name: 'Image One', provider: 'x', modelType: 'image_gen' },
];

describe('resolveModelQuery / effectiveThinkingOn', () => {
  const models = [M('claude-opus-5-5', 'Claude Opus 5.5'), M('claude-sonnet-5', 'Claude Sonnet 5'), M('codex/gpt-5.6-luna', 'gpt-5.6-luna'), M('qwen3.5:4b')];
  it('精确 id / 名称 / 大小写与空格折叠', () => {
    expect(resolveModelQuery('claude-sonnet-5', models)).toMatchObject({ kind: 'hit', model: { id: 'claude-sonnet-5' } });
    expect(resolveModelQuery('claude opus 5.5', models)).toMatchObject({ kind: 'hit', model: { id: 'claude-opus-5-5' } });
  });
  it('vendor:model 当 vendor/model;ollama tag 原样优先', () => {
    expect(resolveModelQuery('codex:gpt-5.6-luna', models)).toMatchObject({ kind: 'hit', model: { id: 'codex/gpt-5.6-luna' } });
    expect(resolveModelQuery('qwen3.5:4b', models)).toMatchObject({ kind: 'hit', model: { id: 'qwen3.5:4b' } });
  });
  it('唯一子串命中;多个 → ambiguous(绝不猜);零 → none', () => {
    expect(resolveModelQuery('opus', models)).toMatchObject({ kind: 'hit', model: { id: 'claude-opus-5-5' } });
    const amb = resolveModelQuery('claude', models);
    expect(amb.kind).toBe('ambiguous');
    expect(amb.kind === 'ambiguous' && amb.candidates.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5']);
    expect(resolveModelQuery('llama', models).kind).toBe('none');
    expect(resolveModelQuery('  ', models).kind).toBe('none');
  });
  it('effectiveThinkingOn:可用就用、先往下、再往上、没档位表原样', () => {
    expect(effectiveThinkingOn('high', ['low', 'medium', 'high'])).toBe('high');
    expect(effectiveThinkingOn('max', ['low', 'medium', 'high'])).toBe('high');
    expect(effectiveThinkingOn('minimal', ['medium', 'high'])).toBe('medium');
    expect(effectiveThinkingOn('xhigh', undefined)).toBe('xhigh');
  });
});

describe('可见性与审批档', () => {
  const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
  const base: ToolContext = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp', unlockTools: () => {} };
  const catalog = (ctx: ToolContext) => listDeferredTools(ctx).map((d) => d.name);

  it('前台 host run:进 deferred 目录、不进常驻 defs;解锁后两件都在', () => {
    configureTangu({ host: stub, brain: stub, billing: stub, profile });
    expect(catalog(base)).toEqual(expect.arrayContaining(['session_settings', 'update_session_settings']));
    const defs = getToolDefinitions(base).map((t: any) => t.function?.name);
    expect(defs).not.toContain('update_session_settings');
    const unlocked = getToolDefinitions({ ...base, unlockedTools: new Set(['session_settings', 'update_session_settings']) }).map((t: any) => t.function?.name);
    expect(unlocked).toEqual(expect.arrayContaining(['session_settings', 'update_session_settings']));
  });

  it('子代理 / 讨论(团队成员)/ Muse / 自动化 / 沙箱:一律不可见', () => {
    for (const ctx of [
      { ...base, subAgentDepth: 1 }, { ...base, inDiscussion: true }, { ...base, muse: true },
      { ...base, automationOrigin: 'rule-1' }, { ...base, execMode: 'sandbox' as const },
    ]) {
      const all = [...catalog(ctx), ...getToolDefinitions(ctx).map((t: any) => t.function?.name)];
      expect(all).not.toContain('update_session_settings');
      expect(all).not.toContain('session_settings');
    }
  });

  it('写工具:询问我批准 / 替我批准 要批,完全放行自动过;读工具不过闸', () => {
    expect(toolNeedsApproval('update_session_settings', 'readonly')).toBe(true);
    expect(toolNeedsApproval('update_session_settings', 'auto-edit')).toBe(true);
    expect(toolNeedsApproval('update_session_settings', 'full-auto')).toBe(false);
    expect(toolNeedsApproval('session_settings', 'readonly')).toBe(false);
  });
});

// ── 真 SQLite + 真 loop(fake llm 按调用序号出剧本) ──
type Script = (call: number) => { content: string; toolCalls: any[]; finishReason: string };
let home: string | null = null;
const llmOpts: any[] = [];
let script: Script = () => ({ content: 'ok', toolCalls: [], finishReason: 'stop' });

async function setupReal(): Promise<void> {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const brain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => { llmOpts.push(o); return { messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }; },
      streamProviderCompletion: async () => {
        const s = script(llmOpts.length);
        return { content: s.content, reasoning: '', toolCalls: s.toolCalls, usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: s.finishReason };
      },
    },
    users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false, listModelsForProject: async () => ({ models: CLOUD, defaultModelId: 'claude-sonnet-5' }) },
  };
  const billing: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain, billing, profile });
  await runMigration();
}
afterEach(() => {
  delete process.env.TANGU_HOME;
  if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } home = null; }
});

const addSession = (id: string, cfg: unknown = {}) =>
  query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES (?, 'u1', 'tangu', 't', 'claude-sonnet-5', 'user', ?)`, [id, JSON.stringify(cfg)]);
const rowOf = async (id: string) => {
  const r = (await query<any[]>(`SELECT model_id, agent_config FROM chat_sessions WHERE id = ?`, [id]))[0];
  return { model: r.model_id, cfg: typeof r.agent_config === 'string' ? JSON.parse(r.agent_config) : r.agent_config };
};
const call = (name: string, args: unknown, ctx: ToolContext) =>
  executeTool({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } } as any, ctx);

describe('执行', () => {
  beforeAll(setupReal); // 上面的可见性用例把 deps 配成了桩
  const ctxFor = (sessionId: string, runId: string): ToolContext => ({
    userId: 'u1', sessionId, runId, appId: 'tangu', profile, execMode: 'host', cwd: '/tmp', modelId: 'claude-sonnet-5', thinkingLevel: 'medium',
    approvalMode: 'auto-edit', unlockTools: () => {}, unlockedTools: new Set(['session_settings', 'update_session_settings']),
  });

  it('改模型 + 思考档:落库(按键合并)、run 内覆盖、发事件;生图模型不在可选列表', async () => {
    await addSession('A', { approvalMode: 'readonly', maxIterations: 7 });
    const events: any[] = [];
    const off = subscribe('RA', (ev) => events.push(ev));
    const r = await call('update_session_settings', { model: 'opus', thinking_level: 'ultra', reason: 'hard proof' }, ctxFor('A', 'RA'));
    off();
    expect(String(r.result)).toContain('claude-opus-5-5');
    expect(String(r.result)).toContain('after this reply finishes');
    const row = await rowOf('A');
    expect(row.model).toBe('claude-opus-5-5');
    expect(row.cfg).toEqual({ approvalMode: 'readonly', maxIterations: 7, thinkingLevel: 'max' }); // 审批档原样
    expect(takeRunThinking('RA')).toBe('max');
    expect(events.find((e) => e.type === 'session_config_changed')?.payload).toMatchObject({ sessionId: 'A', modelId: 'claude-opus-5-5', thinkingLevel: 'max', source: 'agent' });
    const read = await call('session_settings', {}, ctxFor('A', 'RA2'));
    expect(String(read.result)).toContain('gpt-6-sol');
    expect(String(read.result)).not.toContain('img-1');
  });

  it('歧义 / 未知模型 / 坏档位:零改动', async () => {
    await addSession('B');
    expect(String((await call('update_session_settings', { model: 'claude', reason: 'x' }, ctxFor('B', 'RB'))).result)).toContain('Nothing changed');
    expect(String((await call('update_session_settings', { model: 'llama', reason: 'x' }, ctxFor('B', 'RB'))).result)).toContain('Nothing changed');
    expect(String((await call('update_session_settings', { thinking_level: 'bogus', reason: 'x' }, ctxFor('B', 'RB'))).result)).toMatch(/unknown thinking level/i);
    expect((await rowOf('B')).model).toBe('claude-sonnet-5');
    expect(takeRunThinking('RB')).toBeUndefined();
  });

  it('真 loop:本 run 内改思考档,下一次请求就换档', async () => {
    home = mkdtempSync(join(tmpdir(), 'tangu-sset-'));
    process.env.TANGU_HOME = home;
    await addSession('L');
    llmOpts.length = 0;
    const tc = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    script = (n) => n === 1
      ? { content: '', toolCalls: [tc('t1', 'load_tools', { names: ['update_session_settings'] })], finishReason: 'tool_calls' }
      : n === 2
        ? { content: '', toolCalls: [tc('t2', 'update_session_settings', { thinking_level: 'high', reason: 'harder' })], finishReason: 'tool_calls' }
        : { content: 'done', toolCalls: [], finishReason: 'stop' };
    await createRun({
      id: 'RL', sessionId: 'L', userId: 'u1', appId: 'tangu', modelId: 'claude-sonnet-5', assistantMessageId: 'RL-a',
      input: { message: 'think harder', userMessageId: 'RL-u', attachments: [], agentConfig: { execMode: 'host', cwd: home, approvalMode: 'full-auto' } },
    });
    enqueueRun('L', 'RL');
    const t0 = Date.now();
    for (;;) {
      const r = await getRun('RL');
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); break; }
      if (Date.now() - t0 > 8000) throw new Error('run 未结束');
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(llmOpts.map((o) => o.thinkingLevel)).toEqual(['medium', 'medium', 'high']);
    expect((await rowOf('L')).cfg.thinkingLevel).toBe('high');
  });
});
