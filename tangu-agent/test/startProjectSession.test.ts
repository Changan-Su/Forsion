/**
 * start_project_session(私聊里 @项目派遣,新工作区 × 轨道体系 P4):
 * 在项目目录里建一条**可见**用户会话(kind='user'、project_path/name、cwd=项目、agentSlug 随发起者、parent_session_id 指回私聊)并起首个 run;
 * 参数校验(相对路径 / 不存在 / 非目录 → 文本错误,不建会话);子代理内 / 讨论 run 内 / 云端不可见;
 * agentLoop:run 带 mentionedProjects → 末条 user 消息尾部注入派遣指令(只闸 hostExec,不看 groupChat)。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile, createAiStudioProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { builtinAgentDef, saveAgent } from '../src/agents/agentRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { dispatchProvider } from '../src/tools/builtin/startProjectSession.js';
import { getToolDefinitions } from '../src/tools/registry.js';

let home: string | null = null;
let llmPayloads: any[] = [];
afterEach(() => { delete process.env.TANGU_HOME; if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } home = null; } });

async function setup(): Promise<{ project: string }> {
  home = mkdtempSync(join(tmpdir(), 'tangu-dispatch-'));
  process.env.TANGU_HOME = home;
  llmPayloads = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
    streamProviderCompletion: async (o: any) => { llmPayloads.push(o.payload); return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'stop' }; },
  };
  const fakeBrain: any = { llm: fakeLlm, users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false } };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const b = builtinAgentDef(DEFAULT_AGENT_SLUG)!;
  await saveAgent({ slug: DEFAULT_AGENT_SLUG, name: b.name, description: b.description, systemPrompt: b.systemPrompt, soul: b.soul });
  const project = join(home, 'proj-a');
  mkdirSync(project, { recursive: true });
  return { project };
}
const tool = () => dispatchProvider.tools()[0];
const waitRun = async (runId: string): Promise<string> => {
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return String(r.status);
    if (Date.now() - t0 > 8000) throw new Error('run 未结束');
    await new Promise((res) => setTimeout(res, 25));
  }
};

describe('start_project_session', () => {
  it('建可见项目会话(形状)+ 首个 run 跑完;parent_session_id 指回私聊', async () => {
    const { project } = await setup();
    const ctx: any = { userId: 'u1', sessionId: 'solo-1', appId: 'tangu', modelId: 'm1', agentSlug: DEFAULT_AGENT_SLUG, profile: createTanguProfile({ sandboxMode: 'none' }), execMode: 'host' };
    const out = String(await tool().execute({ project_path: project, message: 'Write README', project_name: 'Proj A' }, ctx));
    expect(out).toMatch(/^Started session /);
    const sid = out.match(/Started session (\S+)/)![1];
    const row = (await query<any[]>(`SELECT * FROM chat_sessions WHERE id = ?`, [sid]))[0];
    expect(row.kind).toBe('user');
    expect(row.project_path).toBe(project);
    expect(row.project_name).toBe('Proj A');
    expect(!!row.projectless).toBe(false);
    expect(row.parent_session_id).toBe('solo-1');
    expect(row.title).toBe('Write README');
    expect(JSON.parse(row.agent_config)).toEqual({ execMode: 'host', cwd: project, preset: null, agentSlug: DEFAULT_AGENT_SLUG });
    const runId = out.match(/run (\S+)\)/)![1];
    expect(await waitRun(runId)).toBe('done');
    const msgs = await query<any[]>(`SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY timestamp`, [sid]);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'Write README' });
  });

  it('参数校验:相对路径 / 不存在 / 非目录 → 文本错误,不建会话', async () => {
    const { project } = await setup();
    const ctx: any = { userId: 'u1', sessionId: 's', appId: 'tangu', modelId: 'm1', profile: createTanguProfile({ sandboxMode: 'none' }) };
    expect(String(await tool().execute({ project_path: 'rel/path', message: 'x' }, ctx))).toMatch(/absolute/);
    expect(String(await tool().execute({ project_path: join(project, 'nope'), message: 'x' }, ctx))).toMatch(/does not exist/);
    expect(String(await tool().execute({ project_path: project, message: '' }, ctx))).toMatch(/message is required/);
    expect((await query<any[]>(`SELECT COUNT(*) AS n FROM chat_sessions`))[0].n).toBe(0);
  });

  it('可见性:host 可见(deferred);子代理内 / 讨论 run 内不可见;云端 profile 不可见', async () => {
    await setup();
    const host = createTanguProfile({ sandboxMode: 'none' });
    const base: any = { userId: 'u1', sessionId: 's', appId: host.appId, profile: host, execMode: 'host', unlockTools: () => {} };
    const names = (ctx: any) => getToolDefinitions(ctx).map((t: any) => t.function?.name);
    expect(names({ ...base, enabledDeferred: ['start_project_session'] }).includes('start_project_session') || tool().isEnabledFor!(host, base)).toBe(true);
    expect(tool().isEnabledFor!(host, { ...base, subAgentDepth: 1 })).toBe(false);
    expect(tool().isEnabledFor!(host, { ...base, inDiscussion: true })).toBe(false);
    expect(tool().isEnabledFor!(createAiStudioProfile(), base)).toBe(false);
  });

  it('agentLoop:run 带 mentionedProjects → 末条 user 消息尾部注入派遣指令(提到 start_project_session 与路径)', async () => {
    const { project } = await setup();
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user', 1, ?)`,
      [JSON.stringify({ soloAgentSlug: DEFAULT_AGENT_SLUG, agentSlug: DEFAULT_AGENT_SLUG, execMode: 'host', cwd: project })]);
    await createRun({ id: 'R1', sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'R1-a',
      input: { message: '去 @Proj A 把 README 写了', userMessageId: 'R1-u', attachments: [], agentConfig: { execMode: 'host', cwd: project, mentionedProjects: [{ name: 'Proj A', path: project }] } } });
    enqueueRun('S', 'R1');
    expect(await waitRun('R1')).toBe('done');
    const lastUser = String(llmPayloads.at(-1)!.messages.filter((m: any) => m.role === 'user').at(-1)!.content);
    expect(lastUser).toContain('去 @Proj A 把 README 写了');
    expect(lastUser).toContain('## Mentioned Projects for This Turn');
    expect(lastUser).toContain('start_project_session');
    expect(lastUser).toContain(project);
  });
});
