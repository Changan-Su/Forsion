import { afterAll, beforeAll, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

beforeAll(async () => {
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host: local.host, profile: createTanguProfile({ sandboxMode: 'none' }), brain: {} as any, billing: {} as any });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title) VALUES
    ('s', 'u', 'tangu', 'Current session'), ('other', 'other-user', 'tangu', 'Someone else')`);
  server = express().use(sessionsRouter).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

it('sends no message body for unchanged browser history and returns newly committed messages', async () => {
  const history = (id: string, tag?: string) => fetch(`${base}/agent/sessions/${id}/messages?limit=200`, {
    cache: 'no-store',
    headers: { Authorization: 'Bearer x', 'Cache-Control': 'no-cache', ...(tag ? { 'If-None-Match': tag } : {}) },
  });
  const large = 'message payload '.repeat(32_768);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m1', 's', 'user', ?, 1)`, [large]);
  const first = await history('s');
  const etag = first.headers.get('ETag');
  expect(first.status).toBe(200);
  expect(etag).toBeTruthy();
  expect(first.headers.get('Cache-Control')).toBe('private, no-store');
  expect((await first.json()).messages[0].content).toBe(large);
  const unchanged = await history('s', etag!);
  expect(unchanged.status).toBe(304);
  expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m2', 's', 'user', 'from another tab', 2)`);
  const changed = await history('s', etag!);
  expect(changed.status).toBe(200);
  expect(changed.headers.get('ETag')).not.toBe(etag);
  expect((await changed.json()).messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
  expect((await history('other', etag!)).status).toBe(404);
});
