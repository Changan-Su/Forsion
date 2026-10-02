/**
 * 手动 /compact 的互斥要看库里的 run 行(PI-DSH 评审 R6):别的进程(TUI / 网关)正在跑的 run
 * 不在本进程的 runSession Map 里,原先只查 Map 会放行并与在途落库并发。
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
const compact = async (id: string): Promise<number> =>
  (await fetch(`${base}/agent/sessions/${id}/compact`, { method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: '{}' })).status;

beforeAll(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express(); app.use(express.json()); app.use(sessionsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user', 1)`);
});
afterAll(async () => { await new Promise((r) => srv.close(r)); });

describe('POST /agent/sessions/:id/compact 跨进程互斥', () => {
  it('库里有别的进程的 running / queued run 行 → 409', async () => {
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('other-proc', 'S', 'u1', 'running', '{}')`);
    expect(await compact('S')).toBe(409);
    await query(`UPDATE agent_runs SET status = 'queued' WHERE id = 'other-proc'`);
    expect(await compact('S')).toBe(409);
    await query(`UPDATE agent_runs SET status = 'done' WHERE id = 'other-proc'`);
    expect(await compact('S')).not.toBe(409);
  });
});
