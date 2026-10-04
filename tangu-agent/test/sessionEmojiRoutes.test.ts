import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

let db: ReturnType<typeof createSqliteHost>['db'];
let server: Server;
let base: string;
beforeEach(async () => {
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
  db = local.db; db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host: local.host, profile: createTanguProfile({ sandboxMode: 'none' }), brain: {} as any, billing: {} as any });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, updated_at) VALUES ('s', 'u', 'tangu', 'Test', '2026-09-29 10:00:00')`);
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title) VALUES ('other', 'other-user', 'tangu', 'Other')`);
  const app = express(); app.use(express.json()); app.use(sessionsRouter);
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); db.close(); });
async function call(method: string, path: string, body?: any) {
  const r = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

describe('session emoji API', () => {
  it('saves complete emoji, preserves activity ordering, round-trips and clears it', async () => {
    const saved = await call('PATCH', '/agent/sessions/s', { emoji: '👨‍👩‍👧‍👦' });
    expect(saved.status).toBe(200);
    expect(saved.body.session.emoji).toBe('👨‍👩‍👧‍👦');
    expect((await call('GET', '/agent/sessions/s/detail')).body.session.emoji).toBe('👨‍👩‍👧‍👦');
    expect((await query<any[]>(`SELECT updated_at FROM chat_sessions WHERE id = 's'`))[0].updated_at).toBe('2026-09-29 10:00:00');
    expect((await call('PATCH', '/agent/sessions/s', { emoji: null })).body.session.emoji).toBeNull();
  });
  it('rejects invalid icons without changing other fields and cannot edit another owner', async () => {
    expect((await call('PATCH', '/agent/sessions/s', { title: 'Changed', emoji: 'hello' })).status).toBe(400);
    expect((await call('GET', '/agent/sessions/s/detail')).body.session.title).toBe('Test');
    expect((await call('PATCH', '/agent/sessions/other', { emoji: '🎨' })).status).toBe(404);
  });
  it('creation accepts flags and rejects multiple emojis', async () => {
    expect((await call('POST', '/agent/sessions', { app_id: 'tangu', emoji: '🇨🇳' })).body.session.emoji).toBe('🇨🇳');
    expect((await call('POST', '/agent/sessions', { app_id: 'tangu', emoji: '🌱🎨' })).status).toBe(400);
  });
});
