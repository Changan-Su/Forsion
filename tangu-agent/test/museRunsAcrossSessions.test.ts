/**
 * Muse 每个周期一个新会话(2026-09-27)之后,两处不能再只看「最新那一个会话」:
 *  ① 自动化 Space 的「历次运行」(GET /agent/special/automation/runs?sessionId=<muse 会话>)要跨该用户全部 muse 会话列,
 *     不串别的用户、自动化会话仍只列自己;
 *  ② 起周期前的「在跑吗」(anyMuseRunActive)要跨全部 muse 会话查 —— 同一秒建的两个会话谁算最新不确定。
 * 真 SQLite(内存)× 真路由,口径与 historianStatus.test 同形。
 */
import { beforeAll, afterAll, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import specialRouter from '../src/routes/special.js';
import { anyMuseRunActive } from '../src/services/muse.js';

let server: Server;
let base: string;
let db: ReturnType<typeof createSqliteHost>['db'];
const runsOf = async (sessionId: string): Promise<string[]> => {
  const r = await fetch(`${base}/agent/special/automation/runs?sessionId=${sessionId}`, { headers: { Authorization: 'Bearer x' } });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).runs.map((x: any) => x.id);
};

beforeAll(async () => {
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host: local.host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: {} as any, brain: {} as any });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, kind, created_at) VALUES
    ('m1', 'u1', 'tangu', 'Muse', 'muse', '2026-09-27 10:00:00'),
    ('m2', 'u1', 'tangu', 'Muse', 'muse', '2026-09-27 10:00:00'),
    ('mx', 'u2', 'tangu', 'Muse', 'muse', '2026-09-27 10:00:00'),
    ('a1', 'u1', 'tangu', 'Auto', 'automation', '2026-09-27 10:00:00')`);
  await query(`INSERT INTO agent_runs (id, session_id, user_id, status, created_at) VALUES
    ('r1', 'm1', 'u1', 'running', '2026-09-27 10:00:01'),
    ('r2', 'm2', 'u1', 'done', '2026-09-27 12:00:00'),
    ('r3', 'mx', 'u2', 'done', '2026-09-27 12:00:00'),
    ('r4', 'a1', 'u1', 'done', '2026-09-27 12:00:00')`);
  const app = express(); app.use(specialRouter);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });

it('Muse 的历次运行跨全部 muse 会话列(新→旧),不串别的用户;自动化会话仍只列自己', async () => {
  expect(await runsOf('m2')).toEqual(['r2', 'r1']);
  expect(await runsOf('a1')).toEqual(['r4']);
  // 反方向:拿别人的 muse 会话 id 读 → 404(从前不校验归属,展开成跨会话后就能读到别人全部 Muse 历史)
  const foreign = await fetch(`${base}/agent/special/automation/runs?sessionId=mx`, { headers: { Authorization: 'Bearer x' } });
  expect(foreign.status).toBe(404);
});

it('在跑吗:同一秒建的两个会话,在跑的那个不在「最新」里也看得见;跑完即放行;别的用户的不算', async () => {
  expect(await anyMuseRunActive('u1')).toBe(true); // r1 在 m1,m1/m2 created_at 相同
  await query(`UPDATE agent_runs SET status = 'done' WHERE id = 'r1'`);
  expect(await anyMuseRunActive('u1')).toBe(false);
  await query(`UPDATE agent_runs SET status = 'queued' WHERE id = 'r3'`);
  expect(await anyMuseRunActive('u1')).toBe(false);
  expect(await anyMuseRunActive('u2')).toBe(true);
});
