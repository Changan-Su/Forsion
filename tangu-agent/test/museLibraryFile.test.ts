/**
 * GET /agent/special/muse/library/file(2026-09-27,Muse 自建 Space 的 ctx.agent.library.read):
 * 只读 Library 内的普通文件 —— 越界(`..` / 绝对路径 / 软链指出去)、隐藏段、目录、超大文件一律拒。
 * 真 SQLite(内存)× 真路由 × 临时 TANGU_HOME。
 */
import { beforeAll, afterAll, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import specialRouter from '../src/routes/special.js';

const home = mkdtempSync(path.join(tmpdir(), 'muse-libfile-'));
const lib = path.join(home, 'agents', 'muse', 'Library');
const prevHome = process.env.TANGU_HOME;
let server: Server;
let base: string;
let db: ReturnType<typeof createSqliteHost>['db'];
const read = async (p: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/agent/special/muse/library/file?path=${encodeURIComponent(p)}`, { headers: { Authorization: 'Bearer x' } });
  return { status: r.status, body: await r.json() };
};

beforeAll(async () => {
  process.env.TANGU_HOME = home;
  mkdirSync(path.join(lib, 'Journal'), { recursive: true });
  writeFileSync(path.join(lib, 'Journal', '2026-09-27.md'), '# 2026-09-27\n\n- 01:45 · heartbeat\n');
  writeFileSync(path.join(lib, '.secret'), 'hidden');
  writeFileSync(path.join(lib, 'big.md'), 'x'.repeat(1024 * 1024 + 1));
  writeFileSync(path.join(home, 'outside.md'), 'outside the Library');
  symlinkSync(path.join(home, 'outside.md'), path.join(lib, 'escape.md'));
  symlinkSync(path.join(lib, '.secret'), path.join(lib, 'public.md')); // Library 内软链到隐藏文件
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host: local.host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: {} as any, brain: {} as any });
  await runMigration();
  const app = express(); app.use(specialRouter);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

it('读 Library 里的文本文件', async () => {
  const r = await read('Journal/2026-09-27.md');
  expect(r.status).toBe(200);
  expect(r.body.content).toContain('01:45 · heartbeat');
});

it('越界 / 隐藏 / 目录 / 超大 / 不存在都拒', async () => {
  expect((await read('../outside.md')).status).toBe(400);
  expect((await read(path.join(home, 'outside.md'))).status).toBe(400); // 绝对路径
  expect((await read('Journal/../../outside.md')).status).toBe(400);
  expect((await read('.secret')).status).toBe(400);
  expect((await read('escape.md')).status).toBe(403); // 软链指到 Library 外
  expect((await read('public.md')).status).toBe(403); // 软链指到 Library 里的隐藏文件(Codex 09-27)
  expect((await read('Journal')).status).toBe(404);
  expect((await read('big.md')).status).toBe(413);
  expect((await read('nope.md')).status).toBe(404);
  expect((await read('')).status).toBe(400);
});
