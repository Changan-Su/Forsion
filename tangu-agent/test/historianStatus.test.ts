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
import { completeHistorianTask } from '../src/services/historianSession.js';

let server: Server;
let base: string;
let db: ReturnType<typeof createSqliteHost>['db'];
let finish: (() => void) | undefined;
const get = (path: string) => fetch(`${base}/agent/special/historian/activity?${path}`, { headers: { Authorization: 'Bearer x' } });
beforeAll(async () => {
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host: local.host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: {} as any, brain: { llm: {
    resolveModelAndKey: async () => ({ model: {}, apiKey: 'x', baseUrl: '', apiModelId: 'm' }),
    buildProviderPayload: async (p: any) => p,
    streamProviderCompletion: async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { content: 'Saved project constraints.', usage: {} }; },
  } } as any });
  await runMigration();
  await query("INSERT INTO chat_sessions (id, user_id, app_id, title) VALUES ('p', 'u1', 'tangu', 'Parent'), ('other', 'u1', 'tangu', 'Other'), ('foreign', 'u2', 'tangu', 'Foreign')");
  await query("INSERT INTO special_agent_log (id, user_id, agent, action, detail, session_ref) VALUES ('a', 'u1', 'historian', 'summary_updated', 'This conversation only', 'p'), ('b', 'u1', 'historian', 'summary_updated', 'Other conversation', 'other')");
  const app = express(); app.use(specialRouter);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });

it('filters activity by owned parent and reports real task activity and readable model records', async () => {
  expect((await get('sessionId=foreign')).status).toBe(404);
  const task = completeHistorianTask({ sessionId: 'p', userId: 'u1', modelId: 'm', task: 'judge', instructions: 'Summarize.', transcript: 'Some constraints', maxTokens: 100 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    const running = await (await get('sessionId=p')).json() as any;
    expect(running.running).toBe(true);
    expect(running.activity.map((a: any) => a.id)).toEqual(['a']);
    expect(running.records).toEqual([]);
  } finally { finish?.(); await task; }
  const ended = await (await get('sessionId=p&detail=1')).json() as any;
  expect(ended.running).toBe(false);
  expect(ended.records).toHaveLength(1);
  expect(ended.records[0].content).toBe('Saved project constraints.');
  const other = await (await get('sessionId=other&detail=1')).json() as any;
  expect(other.records).toEqual([]);
  expect(other.activity.map((a: any) => a.id)).toEqual(['b']);
});
