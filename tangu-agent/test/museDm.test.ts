/**
 * Muse 主动发私聊(2026-10-18,方案 B「按性质分」):真 SQLite + 真路由。
 * message_user 只在 Muse 周期可见 → 消息落进那条长期的 Muse 私聊(origin=proactive)→ attention 端点报未读 / 问句报等你
 * → 读过只清未读、下一轮开始才清等你;每小时 3 条只算 message_user;add_muse_todo 进私聊不发信(日报档也一样);
 * Muse 后台有待批时 attention 把「等你」算在 Muse 私聊上。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import sessionsRouter from '../src/routes/sessions.js';
import { museMessageProvider } from '../src/tools/builtin/museMessage.js';
import { museTodoProvider } from '../src/tools/builtin/museTodo.js';
import { onRunStart } from '../src/services/childSessions.js';

let home = '';
let srv: Server;
let base = '';
const profile = createTanguProfile({ sandboxMode: 'none' });
const api = async (path: string, init?: RequestInit): Promise<any> =>
  (await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' } })).json();
const send = museMessageProvider.tools()[0];
const todo = museTodoProvider.tools()[0];
const cycle: any = { userId: 'u1', sessionId: 'cycle', appId: 'tangu', profile, muse: true, agentSlug: 'muse' };
const dmId = async (): Promise<string> => (await query<any[]>(`SELECT id FROM chat_sessions WHERE kind = 'user' AND agent_config LIKE '%"soloAgentSlug":"muse"%'`))[0]?.id;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-musedm-'));
  process.env.TANGU_HOME = home;
  mkdirSync(join(home, 'agents', 'muse'), { recursive: true });
  writeFileSync(join(home, 'agents', 'muse', 'config.toml'), 'name = "Muse"\n');
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile });
  await runMigration();
  const app = express();
  app.use(express.json());
  app.use(sessionsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => { srv?.close(); delete process.env.TANGU_HOME; try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('Muse 主动发私聊', () => {
  it('message_user 只在 Muse 周期可见(普通 run、Muse 派出去的子代理都看不到)', () => {
    expect(send.isEnabledFor!(profile, cycle)).toBe(true);
    expect(send.isEnabledFor!(profile, { ...cycle, muse: false })).toBe(false);
    expect(send.isEnabledFor!(profile, { ...cycle, subAgentDepth: 1 })).toBe(false);
  });

  it('发一句问句 → 落进那条 Muse 私聊(建出来的就是用户点 Muse 行进的那条),未读 + 等你;读过只清未读,下一轮开始清等你', async () => {
    expect(await send.execute({ text: 'CI 红了一次,重跑绿了。要记成抖动吗?' }, cycle)).toMatch(/Sent/);
    const sid = await dmId();
    expect(sid).toBeTruthy();
    const [m] = await query<any[]>(`SELECT role, origin, agent_slug FROM chat_messages WHERE session_id = ?`, [sid]);
    expect(m).toMatchObject({ role: 'model', origin: 'proactive', agent_slug: 'muse' });
    expect((await api('/agent/sessions')).sessions.some((s: any) => s.id === sid)).toBe(true);
    const msgs = (await api(`/agent/sessions/${sid}/messages`)).messages;
    expect(msgs[0].origin).toBe('proactive');

    expect((await api('/agent/sessions/attention')).sessions).toEqual([{ id: sid, unread: true, awaiting: true }]);
    await api(`/agent/sessions/${sid}/read`, { method: 'POST' });
    expect((await api('/agent/sessions/attention')).sessions).toEqual([{ id: sid, unread: false, awaiting: true }]);
    await onRunStart(sid, { origin: 'client' }, 'r1');
    expect((await api('/agent/sessions/attention')).sessions).toEqual([]);
  });

  it('陈述句只算未读,不算等你', async () => {
    await send.execute({ text: '今天的待办整理好了,放在 Library 里。' }, cycle);
    const sid = await dmId();
    expect((await api('/agent/sessions/attention')).sessions).toEqual([{ id: sid, unread: true, awaiting: false }]);
  });

  it('每小时 3 条只算 message_user;add_muse_todo 进私聊、不发信(日报档也一样),不占这 3 条', async () => {
    await send.execute({ text: '第三条。' }, cycle);
    expect(await send.execute({ text: '第四条。' }, cycle)).toMatch(/already sent the user 3 messages/);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ specialAgents: { muse: { notify: 'digest' } } }));
    expect(await todo.execute({ title: '补 README 的 Windows 安装步骤', detail: '写完先给用户看。' }, cycle)).toMatch(/TODO/);
    const sid = await dmId();
    const rows = await query<any[]>(`SELECT origin, content FROM chat_messages WHERE session_id = ? AND origin = 'proactive:todo'`, [sid]);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toMatch(/```forsion-task\ntitle: 补 README 的 Windows 安装步骤\ntodo: /);
    expect((await query<any[]>(`SELECT COUNT(*) AS n FROM inbox_messages`))[0].n).toBe(0);
  });

  it('Muse 后台有待批 → attention 把「等你」算在 Muse 私聊上;批完(不起轮)就熄', async () => {
    const sid = await dmId();
    await api(`/agent/sessions/${sid}/read`, { method: 'POST' });
    await query(`INSERT INTO pending_approvals (id, user_id, session_id, run_id, agent_slug, tool, args, preview, status) VALUES ('a1', 'u1', 'cycle', 'r', 'muse', 'write_file', '{}', 'write x', 'pending')`);
    expect((await api('/agent/sessions/attention')).sessions).toEqual([{ id: sid, unread: false, awaiting: true }]);
    await query(`UPDATE pending_approvals SET status = 'approved' WHERE id = 'a1'`);
    expect((await api('/agent/sessions/attention')).sessions).toEqual([]);
  });
});
