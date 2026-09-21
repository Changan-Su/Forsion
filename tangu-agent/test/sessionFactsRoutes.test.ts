/**
 * 会话事实锁的 HTTP 层(creview 09-16 P0/P1):PUT 合并锁之后仍要过互斥校验(只带 soloEngineId 合并回存值 soloAgentSlug = 双身份 → 400);
 * 活动 run 期间改轨道身份键 → 409;空白会话(无消息、无活动 run)可改。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import sessionsRouter from '../src/routes/sessions.js';

let srv: Server;
let base: string;
const put = async (id: string, body: any): Promise<any> => {
  const r = await fetch(`${base}/agent/sessions/${id}/config`, { method: 'PUT', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const cfgOf = async (id: string): Promise<any> => { const r = (await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [id]))[0]; return typeof r.agent_config === 'string' ? JSON.parse(r.agent_config) : r.agent_config; };

beforeAll(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json()); app.use(sessionsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user', 1, ?)`, [JSON.stringify({ soloAgentSlug: 'ario', agentSlug: 'ario', execMode: 'host', preset: null })]);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m1', 'S', 'user', 'hi', 1)`);
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES ('B', 'u1', 'tangu', 't', 'm1', 'user', 1, ?)`, [JSON.stringify({ soloAgentSlug: 'ario', preset: null })]);
});
afterAll(async () => { await new Promise((r) => srv.close(r)); });

describe('PUT /agent/sessions/:id/config 与轨道身份锁', () => {
  it('有消息的私聊会话:只带 soloEngineId 的 PUT 合并回 soloAgentSlug 会成双身份 → 400,存值不动', async () => {
    const r = await put('S', { soloEngineId: 'codex', thinkingLevel: 'high' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toMatch(/mutually exclusive/);
    expect(await cfgOf('S')).toMatchObject({ soloAgentSlug: 'ario' });
    expect((await cfgOf('S')).soloEngineId).toBeUndefined();
  });
  it('有消息的私聊会话:PUT teamSlug 同样 400;不带身份键的 PUT 正常合并(锁补回身份)', async () => {
    expect((await put('S', { teamSlug: 'abc' })).status).toBe(400);
    const ok = await put('S', { thinkingLevel: 'high' });
    expect(ok.status).toBe(200);
    expect(ok.body.agent_config).toMatchObject({ soloAgentSlug: 'ario', thinkingLevel: 'high' });
  });
  it('空白会话可改身份;但有排队/运行中的 run 时改身份 → 409', async () => {
    expect((await put('B', { soloAgentSlug: 'bo' })).status).toBe(200);
    expect((await cfgOf('B')).soloAgentSlug).toBe('bo');
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('r1', 'B', 'u1', 'queued', '{}')`);
    const r = await put('B', { soloAgentSlug: 'cy' });
    expect(r.status).toBe(409);
    expect((await cfgOf('B')).soloAgentSlug).toBe('bo');
    expect((await put('B', { thinkingLevel: 'low' })).status).toBe(200); // 非身份键照改
  });
});

describe('PUT /agent/sessions/:id/config 审批档级联进团队成员会话', () => {
  it('团队会话改档 → 成员工作会话同步(子聊天直接追问按成员会话的档);档位没变的 PUT 不碰成员会话里单独调的档', async () => {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES ('T', 'u1', 'tangu', 't', 'm1', 'user', ?)`, [JSON.stringify({ groupChat: true, approvalMode: 'full-auto' })]);
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, agent_config) VALUES ('W', 'u1', 'tangu', 'w', 'm1', 'teamwork', 'T', ?)`, [JSON.stringify({ agentSlug: 'bo', approvalMode: 'full-auto', teamMember: { teamSessionId: 'T' } })]);
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, agent_config) VALUES ('D', 'u1', 'tangu', 'd', 'm1', 'discussion', 'T', ?)`, [JSON.stringify({ approvalMode: 'full-auto' })]);
    expect((await put('T', { groupChat: true, approvalMode: 'auto-edit' })).status).toBe(200);
    expect(await cfgOf('W')).toMatchObject({ agentSlug: 'bo', approvalMode: 'auto-edit', teamMember: { teamSessionId: 'T' } });
    expect((await cfgOf('D')).approvalMode).toBe('full-auto'); // 只动 teamwork,不碰讨论等别的子会话
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'W'`, [JSON.stringify({ agentSlug: 'bo', approvalMode: 'readonly' })]);
    expect((await put('T', { groupChat: true, approvalMode: 'auto-edit', thinkingLevel: 'high' })).status).toBe(200);
    expect((await cfgOf('W')).approvalMode).toBe('readonly');
  });
});
