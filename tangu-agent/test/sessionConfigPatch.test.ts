/**
 * PATCH /agent/sessions/:id/config(按键合并写):客户端只带要改的键,没提到的键原样留在存值里 ——
 * 整对象 PUT 会把本地缓存里的旧值(另一个窗口的陈旧缓存、同窗口先发后到的请求)一起写回去,审批档被盖回去 = 悄悄放宽。
 * null = 删键;身份锁 / 活动 run 期间改身份 409 与 PUT 同一条路径;同会话的配置写按会话串行。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

// 内存 better-sqlite3 是同步的:两个并发写在「读存值 → 落库」之间根本插不进去,不加串行也恒绿(假绿)。
// 每次 query 前让出一拍,制造真实的异步间隙 —— 只在测试里,生产代码不留钩子。
vi.mock('../src/core/db.js', async (orig) => {
  const m = await orig<typeof import('../src/core/db.js')>();
  return { ...m, query: async (sql: string, params?: unknown[]) => { await new Promise((r) => setImmediate(r)); return m.query(sql, params as any); } };
});

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
const send = async (method: 'PUT' | 'PATCH', id: string, body: unknown): Promise<any> => {
  const r = await fetch(`${base}/agent/sessions/${id}/config`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const cfgOf = async (id: string): Promise<any> => { const r = (await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [id]))[0]; return typeof r.agent_config === 'string' ? JSON.parse(r.agent_config) : r.agent_config; };
const addSession = (id: string, cfg: unknown) => query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES (?, 'u1', 'tangu', 't', 'm1', 'user', 1, ?)`, [id, JSON.stringify(cfg)]);

beforeAll(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json()); app.use(sessionsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => { await new Promise((r) => srv.close(r)); });

describe('PATCH /agent/sessions/:id/config', () => {
  it('只改带来的键:别的键(含审批档)原样留在存值里', async () => {
    await addSession('P1', { execMode: 'host', approvalMode: 'readonly', groupChat: true, groupAgents: ['a', 'b'], thinkingLevel: 'low' });
    const r = await send('PATCH', 'P1', { thinkingLevel: 'high' });
    expect(r.status).toBe(200);
    expect(await cfgOf('P1')).toEqual({ execMode: 'host', approvalMode: 'readonly', groupChat: true, groupAgents: ['a', 'b'], thinkingLevel: 'high' });
    expect(r.body.agent_config).toEqual(await cfgOf('P1'));
  });

  it('null = 删这个键', async () => {
    await addSession('P2', { execMode: 'host', engineId: 'codex', engineModelId: 'x', verifyCommand: 'npm test' });
    expect((await send('PATCH', 'P2', { engineId: null, engineModelId: null })).status).toBe(200);
    expect(await cfgOf('P2')).toEqual({ execMode: 'host', verifyCommand: 'npm test' });
  });

  it('PUT 仍是整对象替换(老客户端 / 新会话初始配置)', async () => {
    await addSession('P3', { execMode: 'host', approvalMode: 'readonly', thinkingLevel: 'low' });
    expect((await send('PUT', 'P3', { execMode: 'host' })).status).toBe(200);
    expect(await cfgOf('P3')).toEqual({ execMode: 'host' });
  });

  it('请求体不是对象 → 400,存值不动', async () => {
    await addSession('P4', { approvalMode: 'readonly' });
    expect((await send('PATCH', 'P4', [1, 2])).status).toBe(400);
    expect(await cfgOf('P4')).toEqual({ approvalMode: 'readonly' });
  });

  it('身份锁与 PUT 同一条路径:合并后双身份 → 400;活动 run 期间改 / 删身份 → 409;非身份键照改', async () => {
    await addSession('P5', { soloAgentSlug: 'ario', execMode: 'host' });
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('p5m', 'P5', 'user', 'hi', 1)`);
    expect((await send('PATCH', 'P5', { soloEngineId: 'codex' })).status).toBe(400);
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('p5r', 'P5', 'u1', 'running', '{}')`);
    expect((await send('PATCH', 'P5', { soloAgentSlug: 'bo' })).status).toBe(409);
    expect((await send('PATCH', 'P5', { soloAgentSlug: null })).status).toBe(409);
    expect((await send('PATCH', 'P5', { approvalMode: 'full-auto' })).status).toBe(200);
    expect(await cfgOf('P5')).toEqual({ soloAgentSlug: 'ario', execMode: 'host', approvalMode: 'full-auto' });
  });

  it('同会话并发两个 PATCH(不同键)→ 两个都留下(按会话串行,不会拿旧存值互相盖掉)', async () => {
    await addSession('P6', { execMode: 'host', approvalMode: 'readonly' });
    const [a, b] = await Promise.all([send('PATCH', 'P6', { thinkingLevel: 'high' }), send('PATCH', 'P6', { planMode: true })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await cfgOf('P6')).toEqual({ execMode: 'host', approvalMode: 'readonly', thinkingLevel: 'high', planMode: true });
  });
});
