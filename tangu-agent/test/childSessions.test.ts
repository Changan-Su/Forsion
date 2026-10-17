/**
 * 父子会话(services/childSessions.ts + tools/builtin/childSessions.ts):
 * start_session 开可见子会话(kind=user、parent_session_id、同项目、继承配置)→ 子会话那一轮收尾 → 主会话收到一条
 * <child_sessions_update> 并自己接着做一轮;两个子会话时等最后一个;连续自动接着做 3 次后只写行不起轮;
 * 用户自己在子会话里聊的轮次不回报;wait_for_user 置「等你」、下一轮清;子会话不能再开子会话。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun } from '../src/services/runStore.js';
import { enqueueRun, activeSessionIds } from '../src/services/agentLoop.js';
import { childSessionsProvider } from '../src/tools/builtin/childSessions.js';
import { CHILD_UPDATE_OPEN, deliverPendingChildReports } from '../src/services/childSessions.js';

let home: string | null = null;
// 主会话 id 每个用例不同:自动接着做的计数在模块内存里,同名会串到下一个用例
let P = 'P';
let seq = 0;
afterEach(() => { delete process.env.TANGU_HOME; if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } home = null; } });

async function setup(): Promise<void> {
  home = mkdtempSync(join(tmpdir(), 'tangu-children-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
    streamProviderCompletion: async () => ({ content: 'child result', reasoning: '', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'stop' }),
  };
  const fakeBrain: any = { llm: fakeLlm, users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false } };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  P = `P${++seq}`;
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, project_path, project_name, projectless, agent_config) VALUES (?, 'u1', 'tangu', 'main', 'm1', 'user', ?, 'Proj', 0, ?)`,
    [P, home, JSON.stringify({ execMode: 'host', cwd: home, approvalMode: 'auto-edit', thinkingLevel: 'low', groupChat: false })]);
}
const tool = (name: string) => childSessionsProvider.tools().find((t) => t.name === name)!;
const ctx = (sessionId = P): any => ({ userId: 'u1', sessionId, appId: 'tangu', modelId: 'm1', profile: createTanguProfile({ sandboxMode: 'none' }), execMode: 'host' });
const idOf = (out: string): string => out.match(/\(id (\S+)\)/)![1];
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const idle = () => until(async () => activeSessionIds().size === 0 && (await new Promise((r) => setTimeout(r, 60)), activeSessionIds().size === 0));
const runsOf = async (sid: string) => (await query<any[]>(`SELECT id, status, input FROM agent_runs WHERE session_id = ? ORDER BY created_at`, [sid]))
  .map((r) => ({ ...r, input: typeof r.input === 'string' ? JSON.parse(r.input) : r.input }));
const updatesIn = async (sid: string) => (await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY timestamp`, [sid]))
  .map((r) => String(r.content)).filter((c) => c.startsWith(CHILD_UPDATE_OPEN));

describe('child sessions', () => {
  it('start_session:可见子会话继承项目与配置;子会话收尾 → 主会话收到回报并自己接着做一轮', async () => {
    await setup();
    const out = String(await tool('start_session').execute({ title: '查 Notion', message: 'Look up Notion offline mode' }, ctx()));
    const cid = idOf(out);
    const row = (await query<any[]>(`SELECT * FROM chat_sessions WHERE id = ?`, [cid]))[0];
    expect(row).toMatchObject({ kind: 'user', parent_session_id: P, project_path: home, project_name: 'Proj', title: '查 Notion' });
    expect(JSON.parse(row.agent_config)).toEqual({ execMode: 'host', cwd: home, approvalMode: 'auto-edit', thinkingLevel: 'low' }); // groupChat 这类会话事实不抄
    await idle();
    const parentRuns = await runsOf(P);
    expect(parentRuns).toHaveLength(1);
    expect(parentRuns[0]).toMatchObject({ status: 'done' });
    expect(parentRuns[0].input.childReport).toBe(true);
    const [u] = await updatesIn(P);
    expect(u).toContain(`<child id="${cid}" title="查 Notion" status="finished">`);
    expect(u).toContain('child result');
    expect((await query<any[]>(`SELECT report_run_id FROM chat_sessions WHERE id = ?`, [cid]))[0].report_run_id).toBeNull();
  });

  it('两个子会话:等最后一个收尾再送,一条回报带两个', async () => {
    await setup();
    const a = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    const b = idOf(String(await tool('start_session').execute({ title: 'B', message: 'b' }, ctx())));
    await idle();
    expect(await runsOf(P)).toHaveLength(1);
    const ups = await updatesIn(P);
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain(`id="${a}"`);
    expect(ups[0]).toContain(`id="${b}"`);
  });

  it('用户自己在子会话里聊的轮次不回报;send_to_session 的那一轮回报', async () => {
    await setup();
    const cid = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    await idle();
    await createRun({ id: 'U1', sessionId: cid, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'U1-a', input: { origin: 'client', message: 'hi', userMessageId: 'U1-u', attachments: [], agentConfig: {} } });
    enqueueRun(cid, 'U1');
    await idle();
    expect(await updatesIn(P)).toHaveLength(1);
    expect(String(await tool('send_to_session').execute({ session_id: cid, message: 'use the enterprise docs' }, ctx()))).toMatch(/^Sent to "A"/);
    await idle();
    expect(await updatesIn(P)).toHaveLength(2);
    // 不是自己的子会话 → 拒
    expect(String(await tool('send_to_session').execute({ session_id: P, message: 'x' }, ctx(cid)))).toMatch(/^Error: No such child session/);
  });

  it('连续自动接着做 3 次后只写行不起轮;用户发一句归零', async () => {
    await setup();
    const cid = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    await idle();
    for (let i = 0; i < 3; i++) { await tool('send_to_session').execute({ session_id: cid, message: `more ${i}` }, ctx()); await idle(); }
    expect(await updatesIn(P)).toHaveLength(4);
    expect((await runsOf(P)).filter((r) => r.input.childReport)).toHaveLength(3); // 第 4 条只写行
    await createRun({ id: 'C1', sessionId: P, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'C1-a', input: { origin: 'client', message: 'ok', userMessageId: 'C1-u', attachments: [], agentConfig: {} } });
    enqueueRun(P, 'C1');
    await idle();
    await tool('send_to_session').execute({ session_id: cid, message: 'again' }, ctx()); await idle();
    expect((await runsOf(P)).filter((r) => r.input.childReport)).toHaveLength(4);
  });

  it('wait_for_user 置「等你」,回报里写 waiting_for_user;下一轮开始清掉', async () => {
    await setup();
    await tool('wait_for_user').execute({}, ctx());
    expect(!!(await query<any[]>(`SELECT awaiting_user FROM chat_sessions WHERE id = ?`, [P]))[0].awaiting_user).toBe(true);
    await createRun({ id: 'C1', sessionId: P, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'C1-a', input: { origin: 'client', message: 'yes', userMessageId: 'C1-u', attachments: [], agentConfig: {} } });
    enqueueRun(P, 'C1');
    await idle();
    expect(!!(await query<any[]>(`SELECT awaiting_user FROM chat_sessions WHERE id = ?`, [P]))[0].awaiting_user).toBe(false);
    // 子会话结果还没送回:等子会话 ≠ 等你,不置
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, report_run_id) VALUES (?, 'u1', 'tangu', 'k', 'm1', 'user', ?, 'R0')`, [`${P}-k`, P]);
    expect(String(await tool('wait_for_user').execute({}, ctx()))).toMatch(/^Not marked/);
    expect(!!(await query<any[]>(`SELECT awaiting_user FROM chat_sessions WHERE id = ?`, [P]))[0].awaiting_user).toBe(false);
  });

  it('子会话有远程污点 → 只写行不起轮;重启补送只写行、摘要取挂起那一轮的回答', async () => {
    await setup();
    const cid = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    await idle();
    expect((await runsOf(P)).filter((r) => r.input.childReport)).toHaveLength(1);
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('RT', ?, 'u1', 'done', ?)`, [cid, JSON.stringify({ remoteTainted: { at: 'x' } })]);
    await tool('send_to_session').execute({ session_id: cid, message: 'more' }, ctx()); await idle();
    expect(await updatesIn(P)).toHaveLength(2);
    expect((await runsOf(P)).filter((r) => r.input.childReport)).toHaveLength(1);
    // 上次退出时挂着没送的回报(那一轮之后用户又接着聊了一句)
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, report_run_id) VALUES (?, 'u1', 'tangu', 'K', 'm1', 'user', ?, 'RK')`, [`${P}-k`, P]);
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input, assistant_message_id) VALUES ('RK', ?, 'u1', 'aborted', '{}', 'RK-a')`, [`${P}-k`]);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('RK-a', ?, 'model', 'bound reply', 1), ('RK-b', ?, 'model', 'later chat', 2)`, [`${P}-k`, `${P}-k`]);
    await deliverPendingChildReports(); await idle();
    const ups = await updatesIn(P);
    expect(ups).toHaveLength(3);
    expect(ups[2]).toContain('status="stopped">\nbound reply');
    expect((await runsOf(P)).filter((r) => r.input.childReport)).toHaveLength(1);
    expect((await query<any[]>(`SELECT report_run_id FROM chat_sessions WHERE id = ?`, [`${P}-k`]))[0].report_run_id).toBeNull();
  });

  it('子会话不能再开子会话;子代理 / Muse / 团队成员 / 通道 run 不可见', async () => {
    await setup();
    const cid = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    expect(String(await tool('start_session').execute({ title: 'B', message: 'b' }, ctx(cid)))).toMatch(/already a child session/);
    const p = createTanguProfile({ sandboxMode: 'none' });
    const base = ctx();
    expect(tool('start_session').isEnabledFor!(p, base)).toBe(true);
    for (const extra of [{ subAgentDepth: 1 }, { muse: true }, { teamSessionId: 'T' }, { runOrigin: 'channel' }, { inDiscussion: true }]) {
      expect(tool('start_session').isEnabledFor!(p, { ...base, ...extra })).toBe(false);
    }
    await idle();
  });
});
