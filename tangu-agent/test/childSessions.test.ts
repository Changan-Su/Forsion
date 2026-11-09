/**
 * 父子会话(services/childSessions.ts + tools/builtin/childSessions.ts):
 * start_session 开可见子会话(kind=user、parent_session_id、同项目、继承配置)→ 子会话那一轮收尾 → 主会话收到一条
 * <child_sessions_update> 并自己接着做一轮;两个子会话时等最后一个;连续自动接着做 3 次后只写行不起轮;
 * 用户自己在子会话里聊的轮次不回报;收尾问句置「等你」、下一轮清;子会话不能再开子会话。
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
import { LlmError } from '../src/core/types.js';
import { createRun } from '../src/services/runStore.js';
import { enqueueRun, activeSessionIds } from '../src/services/agentLoop.js';
import { childSessionsProvider } from '../src/tools/builtin/childSessions.js';
import { branchSession } from '../src/services/sessionBranch.js';
import { CHILD_UPDATE_OPEN, deliverPendingChildReports, endsWithQuestion, markAwaitingUser } from '../src/services/childSessions.js';
import { clearRunApprovalCap, setRunApprovalCap } from '../src/services/approvals.js';
import { NEW_TOPIC_NOTE } from '../src/services/agentLoop.js';

let home: string | null = null;
// 主会话 id 每个用例不同:自动接着做的计数在模块内存里,同名会串到下一个用例
let P = 'P';
let seq = 0;
let reply = 'child result';
// 按会话改写模型回答(返回 undefined = 照常回 reply);payloads 记每次发给模型的消息(按会话)
let hook: ((sid: string, n: number) => any) | null = null;
const payloads: Array<{ sid: string; messages: any[] }> = [];
afterEach(() => { hook = null; payloads.length = 0; });
afterEach(() => { delete process.env.TANGU_HOME; if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } home = null; } });

async function setup(): Promise<void> {
  home = mkdtempSync(join(tmpdir(), 'tangu-children-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
    streamProviderCompletion: async (o: any) => {
      const sid = String(o.payload?.messages?.find((m: any) => typeof m.content === 'string' && m.content.includes('SID:'))?.content.match(/SID:(\S+)/)?.[1] || '');
      payloads.push({ sid, messages: o.payload?.messages || [] });
      const n = payloads.filter((x) => x.sid === sid).length;
      const r = hook?.(sid, n);
      if (r instanceof Error) throw r;
      return r ?? { content: reply, reasoning: '', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'stop' };
    },
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
    // 不存在的会话 → 拒(11-08 起树外的会话也发得到,见「跨树互发」)
    expect(String(await tool('send_to_session').execute({ session_id: 'nope', message: 'x' }, ctx(cid)))).toMatch(/^Error: No such session/);
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

  it('置「等你」后下一轮开始清掉;子会话结果没送回时不置', async () => {
    await setup();
    expect(await markAwaitingUser(P, 'u1')).toBe(true);
    expect(!!(await query<any[]>(`SELECT awaiting_user FROM chat_sessions WHERE id = ?`, [P]))[0].awaiting_user).toBe(true);
    await createRun({ id: 'C1', sessionId: P, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: 'C1-a', input: { origin: 'client', message: 'yes', userMessageId: 'C1-u', attachments: [], agentConfig: {} } });
    enqueueRun(P, 'C1');
    await idle();
    expect(!!(await query<any[]>(`SELECT awaiting_user FROM chat_sessions WHERE id = ?`, [P]))[0].awaiting_user).toBe(false);
    // 子会话结果还没送回:等子会话 ≠ 等你,不置
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, report_run_id) VALUES (?, 'u1', 'tangu', 'k', 'm1', 'user', ?, 'R0')`, [`${P}-k`, P]);
    expect(await markAwaitingUser(P, 'u1')).toBe(false);
    expect(!!(await query<any[]>(`SELECT awaiting_user FROM chat_sessions WHERE id = ?`, [P]))[0].awaiting_user).toBe(false);
  });

  it('用户在场的一轮以问句收尾 → 引擎置等你;子会话结果没送回时不置', async () => {
    expect([endsWithQuestion('这周的重点是什么？'), endsWithQuestion('要我修吗? **'), endsWithQuestion('做完了。'), endsWithQuestion('「对吗？」')]).toEqual([true, true, false, true]);
    await setup();
    const aw = async () => !!(await query<any[]>(`SELECT awaiting_user FROM chat_sessions WHERE id = ?`, [P]))[0].awaiting_user;
    reply = '这周的重点是什么？';
    try {
      await createRun({ id: `${P}-Q1`, sessionId: P, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `${P}-Q1-a`, input: { origin: 'client', message: 'title?', userMessageId: `${P}-Q1-u`, attachments: [], agentConfig: {} } });
      enqueueRun(P, `${P}-Q1`); await idle();
      expect(await aw()).toBe(true);
      await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, report_run_id) VALUES (?, 'u1', 'tangu', 'k', 'm1', 'user', ?, ?)`, [`${P}-k`, P, `${P}-R0`]);
      await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES (?, ?, 'u1', 'running', '{}')`, [`${P}-R0`, `${P}-k`]); // 别的引擎持有、没到终态
      await createRun({ id: `${P}-Q2`, sessionId: P, userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `${P}-Q2-a`, input: { origin: 'client', message: 'again', userMessageId: `${P}-Q2-u`, attachments: [], agentConfig: {} } });
      enqueueRun(P, `${P}-Q2`); await idle();
      expect(await aw()).toBe(false);
    } finally { reply = 'child result'; }
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

  it('分支(fork_message_id 有值)不是子会话:分支里能开子会话,send_to_session 按树外发到分支,回报不把分支算进去', async () => {
    await setup();
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('fm', ?, 'model', 'x', 100)`, [P]);
    const B = `${P}-branch`;
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, fork_message_id, agent_config) VALUES (?, 'u1', 'tangu', 'branch', 'm1', 'user', ?, 'fm', ?)`,
      [B, P, JSON.stringify({ execMode: 'host', cwd: home, approvalMode: 'auto-edit' })]);
    // 11-08 跨树互发:分支不是子会话,但同一个用户的会话 → 按树外(peer)发得到
    expect(String(await tool('send_to_session').execute({ session_id: B, message: 'hi' }, ctx()))).toMatch(/^Sent to "branch"/);
    await idle();
    const cid = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx(B))));
    await idle();
    expect((await updatesIn(B))[0]).toContain(`id="${cid}"`);
    expect(await updatesIn(P)).toEqual([]); // 分支收尾不往主线送任何东西
  });

  it('context fork:子会话带上主会话此刻的对话(开头摘要),不拷行;fresh 不带', async () => {
    await setup();
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('pm1', ?, 'user', 'We picked Postgres 17 for the ledger', 100)`, [P]);
    const out = String(await tool('start_session').execute({ title: 'F', message: 'SID:fork Write the migration', context: 'fork' }, ctx()));
    expect(out).toContain('with this conversation as background');
    const f = idOf(out);
    const fresh = idOf(String(await tool('start_session').execute({ title: 'N', message: 'SID:fresh Write the migration' }, ctx())));
    await idle();
    const [cp] = await query<any[]>(`SELECT summary, through_timestamp FROM session_summaries WHERE session_id = ?`, [f]);
    expect(Number(cp.through_timestamp)).toBe(1);
    expect(cp.summary).toContain('Postgres 17');
    const seen = (sid: string) => JSON.stringify(payloads.find((x) => x.sid === sid)!.messages);
    expect(seen('fork')).toContain('Postgres 17');
    expect(seen('fork')).toContain('NOT work done in this session');
    expect(seen('fresh')).not.toContain('Postgres 17');
    expect(await query<any[]>(`SELECT id FROM session_summaries WHERE session_id = ?`, [fresh])).toEqual([]);
    // 子会话自己的行里没有主会话那句
    expect(JSON.stringify(await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = ?`, [f]))).not.toContain('Postgres 17');
  });

  it('子会话 ask_user 之后模型失败:问题照样送回主会话(Codex P2)', async () => {
    await setup();
    hook = (sid, n) => {
      if (sid !== 'ask') return undefined;
      if (n === 1) return { content: '', reasoning: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which region should it deploy to?' }) } }], usage: { prompt_tokens: 5, completion_tokens: 5 }, finishReason: 'tool_calls' };
      return new LlmError(400, 'bad request');
    };
    const cid = idOf(String(await tool('start_session').execute({ title: 'Q', message: 'SID:ask Deploy it' }, ctx())));
    await idle();
    const [u] = await updatesIn(P);
    expect(u).toContain(`<child id="${cid}" title="Q" status="failed">`);
    expect(u).toContain('Which region should it deploy to?');
  });

  it('会话互发:子会话 → 主会话、兄弟之间落成 <session_message> 并起一轮;兄弟那一轮不回报主会话', async () => {
    await setup();
    const a = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    const b = idOf(String(await tool('start_session').execute({ title: 'B', message: 'b' }, ctx())));
    await idle();
    const before = (await runsOf(P)).length;
    // 列表:A 看得到主会话和 B
    const list = String(await tool('list_linked_sessions').execute({}, ctx(a)));
    expect(list).toContain(`parent: "main" (id ${P})`);
    expect(list).toContain(`sibling: "B" (id ${b})`);
    expect(list).not.toContain(`id ${a})`);
    // 兄弟
    expect(String(await tool('send_to_session').execute({ session_id: b, message: 'schema is in db/ledger.sql' }, ctx(a)))).toMatch(/^Sent to "B"/);
    await idle();
    const bRuns = await runsOf(b);
    expect(bRuns.at(-1)!.input.fromSession).toEqual({ id: a, relation: 'sibling' });
    expect(bRuns.at(-1)!.input.message).toContain(`<session_message from="${a}" title="A" relation="sibling">`);
    expect((await runsOf(P)).length).toBe(before); // 兄弟那一轮不叫醒主会话
    // 子会话 → 主会话("parent" 别名)
    expect(String(await tool('send_to_session').execute({ session_id: 'parent', message: 'found a blocker' }, ctx(a)))).toMatch(/^Sent to "main"/);
    await idle();
    const pr = (await runsOf(P)).at(-1)!;
    expect(pr.input.fromSession).toEqual({ id: a, relation: 'child' });
    expect(pr.input.message).toContain('found a blocker');
  });

  it('防回环:同一会话连续被消息叫醒 3 次后只写行;主会话派一轮归零', async () => {
    await setup();
    const a = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    const b = idOf(String(await tool('start_session').execute({ title: 'B', message: 'b' }, ctx())));
    await idle();
    for (let i = 0; i < 3; i++) {
      expect(String(await tool('send_to_session').execute({ session_id: b, message: `m${i}` }, ctx(a)))).toMatch(/^Sent to "B"/);
      await idle();
    }
    const n = (await runsOf(b)).length;
    expect(String(await tool('send_to_session').execute({ session_id: b, message: 'm3' }, ctx(a)))).toMatch(/will not start a turn/);
    await idle();
    expect((await runsOf(b)).length).toBe(n);
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user'`, [b]);
    expect(rows.some((r) => String(r.content).includes('m3'))).toBe(true);
    // 主会话给 B 派一轮 → 计数归零,兄弟又能叫醒它
    await tool('send_to_session').execute({ session_id: b, message: 'carry on' }, ctx());
    await idle();
    expect(String(await tool('send_to_session').execute({ session_id: b, message: 'm4' }, ctx(a)))).toMatch(/^Sent to "B"/);
    await idle();
  });

  it('fork 用主会话这一轮在飞的消息(还没落库的工具结果也带上);从 fork 子会话分支,背景跟着走', async () => {
    await setup();
    const inflight = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'Implement the ledger schema' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"db/ledger.sql"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'CREATE TABLE ledger_entries (amount_cents BIGINT)' },
    ];
    const f = idOf(String(await tool('start_session').execute({ title: 'F', message: 'SID:inflight Write it', context: 'fork' }, { ...ctx(), getWorkingMessages: () => inflight })));
    await idle();
    const [cp] = await query<any[]>(`SELECT summary FROM session_summaries WHERE session_id = ?`, [f]);
    expect(cp.summary).toContain('ledger_entries');
    expect(cp.summary).not.toContain('SYSTEM PROMPT');
    const [m] = await query<any[]>(`SELECT id FROM chat_messages WHERE session_id = ? AND role = 'model' LIMIT 1`, [f]);
    const br = await branchSession({ sourceSessionId: f, userId: 'u1', appId: 'tangu', messageId: m.id });
    const [bcp] = await query<any[]>(`SELECT summary, through_timestamp FROM session_summaries WHERE session_id = ?`, [br!.id]);
    expect(Number(bcp.through_timestamp)).toBe(1);
    expect(bcp.summary).toContain('ledger_entries');
  });

  it('防回环:并发发来的几条不会一起越过上限', async () => {
    await setup();
    const a = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    const b = idOf(String(await tool('start_session').execute({ title: 'B', message: 'b' }, ctx())));
    const c = idOf(String(await tool('start_session').execute({ title: 'C', message: 'c' }, ctx())));
    await idle();
    for (let i = 0; i < 2; i++) { await tool('send_to_session').execute({ session_id: c, message: `m${i}` }, ctx(a)); await idle(); }
    const before = (await runsOf(c)).length;
    const outs = await Promise.all([a, b, a].map((from, i) => tool('send_to_session').execute({ session_id: c, message: `x${i}` }, ctx(from))));
    expect(outs.filter((o) => /^Sent to/.test(String(o)))).toHaveLength(1);
    await idle();
    expect((await runsOf(c)).length).toBe(before + 1);
  });

  it('hand_off_task:主会话挪出 → 挂它下面、带交接背景、那一轮是 handoff;做完只在原会话留一行,不起轮', async () => {
    await setup();
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('hm1', ?, 'user', 'Draft the release notes for 2.14.1', 100)`, [P]);
    const out = String(await tool('hand_off_task').execute({ title: 'Notes', brief: 'SID:handoff Finish the notes: groups 3-5 left' }, ctx()));
    expect(out).toMatch(/^Moved the unfinished task to a new session "Notes"/);
    const h = idOf(out);
    const row = (await query<any[]>(`SELECT * FROM chat_sessions WHERE id = ?`, [h]))[0];
    expect(row.parent_session_id).toBe(P);
    expect(JSON.parse(row.agent_config).handoffFrom).toBe(P);
    await idle();
    const hr = (await runsOf(h))[0];
    expect(hr.input.handoff).toBe(true);
    expect(hr.input.fromParent).toBeUndefined(); // ask_user 照常挂起等用户,不短路给原会话
    const seen = JSON.stringify(payloads.find((x) => x.sid === 'handoff')!.messages);
    expect(seen).toContain('Handed-off context');
    expect(seen).toContain('Draft the release notes');
    const ups = await updatesIn(P);
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain('A task you handed off earlier');
    expect(ups[0]).toContain(`<child id="${h}" title="Notes" status="finished">`);
    expect(await runsOf(P)).toEqual([]); // 原会话不起轮
    expect((await query<any[]>(`SELECT report_run_id FROM chat_sessions WHERE id = ?`, [h]))[0].report_run_id).toBeNull();
  });

  it('hand_off_task:子会话挪出 → 挂同一个主会话下面(兄弟,守一层);结果回原子会话一行,主会话不收不等', async () => {
    await setup();
    const a = idOf(String(await tool('start_session').execute({ title: 'A', message: 'a' }, ctx())));
    await idle();
    const pRuns = (await runsOf(P)).length;
    const pUps = (await updatesIn(P)).length;
    const h = idOf(String(await tool('hand_off_task').execute({ title: 'H', brief: 'continue the rest' }, ctx(a))));
    const row = (await query<any[]>(`SELECT parent_session_id, agent_config FROM chat_sessions WHERE id = ?`, [h]))[0];
    expect(row.parent_session_id).toBe(P);
    expect(JSON.parse(row.agent_config).handoffFrom).toBe(a);
    await idle();
    expect((await updatesIn(a)).some((u) => u.includes(`<child id="${h}"`))).toBe(true);
    expect((await updatesIn(P)).length).toBe(pUps);
    expect((await runsOf(P)).length).toBe(pRuns);
    // 挪出去的那条挂着回报也不挡主会话置「等你」
    await query(`UPDATE chat_sessions SET report_run_id = 'pending-x' WHERE id = ?`, [h]);
    expect(await markAwaitingUser(P, 'u1')).toBe(true);
  });

  it('跨树互发:发给树外的会话 → relation="peer" + 起一轮,审批档上限 = 发方的档;收不到的给出原因', async () => {
    await setup();
    const cfg = (o: object = {}) => JSON.stringify({ execMode: 'host', cwd: home, approvalMode: 'full-auto', ...o });
    const add = (id: string, more: { user?: string; archived?: boolean; cfg?: object } = {}) => query(
      `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, archived, agent_config) VALUES (?, ?, 'tangu', ?, 'm1', 'user', ?, ?)`,
      [id, more.user || 'u1', id, more.archived ? 1 : 0, cfg(more.cfg)]);
    const Q = `${P}-q`;
    await add(Q);
    const out = String(await tool('send_to_session').execute({ session_id: Q, message: 'is 300 MB fine?' }, { ...ctx(), approvalMode: 'auto-edit' }));
    expect(out).toMatch(new RegExp(`^Sent to "${Q}"`));
    await idle();
    const qr = (await runsOf(Q)).at(-1)!;
    expect(qr.input.fromSession).toEqual({ id: P, relation: 'peer' });
    expect(qr.input.approvalCap).toBe('auto-edit'); // 发方存档 auto-edit,收方 full-auto
    expect(qr.input.message).toContain(`<session_message from="${P}" title="main" relation="peer">`);
    expect(qr.input.message).toContain('outside your session tree');
    // 发方 custom → 上限按最严
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = ?`, [cfg({ approvalMode: 'custom' }), P]);
    await tool('send_to_session').execute({ session_id: Q, message: 'again' }, ctx());
    await idle();
    expect((await runsOf(Q)).at(-1)!.input.approvalCap).toBe('readonly');
    // 收不到的
    await add(`${P}-arch`, { archived: true });
    await add(`${P}-muse`, { cfg: { agentSlug: 'muse' } });
    await add(`${P}-codex`, { cfg: { soloEngineId: 'codex' } });
    await add(`${P}-wx`);
    await query(`INSERT INTO tangu_wechat_bindings (id, user_id, channel, account_id, session_id) VALUES ('b1', 'u1', 'wechat', 'acc', ?)`, [`${P}-wx`]);
    await add(`${P}-other`, { user: 'u2' });
    const send = async (id: string) => String(await tool('send_to_session').execute({ session_id: id, message: 'x' }, ctx()));
    expect(await send(`${P}-arch`)).toMatch(/archived/);
    expect(await send(`${P}-muse`)).toMatch(/Muse/);
    expect(await send(`${P}-codex`)).toMatch(/external engine/);
    expect(await send(`${P}-wx`)).toMatch(/messaging channel/);
    expect(await send(`${P}-other`)).toMatch(/No such session/);
    for (const id of ['arch', 'muse', 'codex', 'wx', 'other']) expect(await runsOf(`${P}-${id}`)).toEqual([]);
  });

  it('被钳过的一轮派生出去不放大:开子会话存档钳到上限、转发给树外按上限;挪出去不抄「另起话题」提示;回报补发不重复(Codex 11-08)', async () => {
    await setup();
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = ?`, [JSON.stringify({ execMode: 'host', cwd: home, approvalMode: 'full-auto' }), P]);
    setRunApprovalCap('R-capped', 'readonly');
    const capped = { ...ctx(), runId: 'R-capped', approvalMode: 'full-auto' };
    try {
      // 开子会话:存档钳到只读,第一轮也带上限
      const c = idOf(String(await tool('start_session').execute({ title: 'C', message: 'c' }, capped)));
      expect(JSON.parse((await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [c]))[0].agent_config).approvalMode).toBe('readonly');
      await idle();
      expect((await runsOf(c))[0].input.approvalCap).toBe('readonly');
      // 转发给树外:发方存档 full-auto,但这一轮被钳成只读 → 收方上限只读
      const Q = `${P}-q2`;
      await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES (?, 'u1', 'tangu', 'q', 'm1', 'user', ?)`,
        [Q, JSON.stringify({ execMode: 'host', cwd: home, approvalMode: 'full-auto' })]);
      await tool('send_to_session').execute({ session_id: Q, message: 'go' }, capped);
      await idle();
      expect((await runsOf(Q)).at(-1)!.input.approvalCap).toBe('readonly');
      // 挪出去:在飞消息里的 <new_topic> 不进种子
      const working = [
        { role: 'user', content: 'SID:x Write the notes' },
        { role: 'user', content: `What port does SSH use?\n\n${NEW_TOPIC_NOTE}` },
        { role: 'user', content: [{ type: 'text', text: 'see image' }, { type: 'text', text: NEW_TOPIC_NOTE }] },
      ];
      const h = idOf(String(await tool('hand_off_task').execute({ title: 'H', brief: 'SID:h2 continue' }, { ...capped, getWorkingMessages: () => working })));
      const seed = String((await query<any[]>(`SELECT summary FROM session_summaries WHERE session_id = ?`, [h]))[0]?.summary || '');
      expect(seed).toContain('What port does SSH use?');
      expect(seed).not.toContain('<new_topic>');
      expect(JSON.parse((await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [h]))[0].agent_config).approvalMode).toBe('readonly');
      await idle();
      // 回报行写过、report_run_id 没清就崩了 → 重启补发认出已写过
      const hRun = (await runsOf(h))[0].id;
      const before = (await updatesIn(P)).filter((u) => u.includes(`<child id="${h}"`)).length;
      expect(before).toBe(1);
      await query(`UPDATE chat_sessions SET report_run_id = ? WHERE id = ?`, [hRun, h]);
      await deliverPendingChildReports();
      expect((await updatesIn(P)).filter((u) => u.includes(`<child id="${h}"`)).length).toBe(1);
      expect((await query<any[]>(`SELECT report_run_id FROM chat_sessions WHERE id = ?`, [h]))[0].report_run_id).toBeNull();
    } finally {
      clearRunApprovalCap('R-capped');
    }
  });

  it('start_session 的 model / thinking_level:认得的才用,认不得跟主会话并说明', async () => {
    await setup();
    const out = String(await tool('start_session').execute({ title: 'M', message: 'm', model: 'no-such-model-xyz', thinking_level: 'bogus' }, ctx()));
    expect(out).toContain('No model matches "no-such-model-xyz"');
    const m = idOf(out);
    const row = (await query<any[]>(`SELECT model_id, agent_config FROM chat_sessions WHERE id = ?`, [m]))[0];
    expect(row.model_id).toBe('m1');
    expect(JSON.parse(row.agent_config).thinkingLevel).toBe('low'); // 跟主会话
    const l = idOf(String(await tool('start_session').execute({ title: 'L', message: 'l', thinking_level: 'high' }, ctx())));
    expect(JSON.parse((await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [l]))[0].agent_config).thinkingLevel).toBe('high');
    await idle();
  });
});
