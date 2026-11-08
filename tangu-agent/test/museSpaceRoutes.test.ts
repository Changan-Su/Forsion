/**
 * 今日简报的两条路由(2026-11-08,Muse Space 方案 D 第一期)。真 express + 真 special 路由 + 真 SQLite(内存)+ 临时 TANGU_HOME。
 *   GET  /agent/special/muse/space                        → { view }(合成好的有效布局);远程来源 403。
 *   POST /agent/special/muse/space/placement { expectedRev, op } → 200 { view } / 409 { detail, view }(rev 对不上、格子变了)/ 400 坏 op;远程来源 403。
 *   拒绝提议:摆放记墓碑,同一把锁里卜算子那份摘掉提议。
 * IO 细节(读坏、最后一份有效的、拒写)在 src/services/museSpace.test.ts。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/museSpaceRoutes.test.ts
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import specialRouter from '../src/routes/special.js';
import { saveSpecialAgentsConfig } from '../src/services/specialAgentsConfig.js';
import { museSpaceDocFile, musePlacementFile } from '../src/services/museSpace.js';

let server: Server;
let base: string;
let home: string;
let db: ReturnType<typeof createSqliteHost>['db'];
const prevHome = process.env.TANGU_HOME;
const prevUser = process.env.TANGU_USER_ID;
const REMOTE = { 'x-forsion-remote': 'tunnel' };
const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${p}`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-muse-space-routes-'));
  process.env.TANGU_HOME = home;
  process.env.TANGU_USER_ID = 'u1';
  const local = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db = local.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host: local.host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: {} as any, brain: {} as any });
  await runMigration();
  saveSpecialAgentsConfig({ muse: { enabled: true } } as any);
  mkdirSync(join(museSpaceDocFile(), '..'), { recursive: true });
  writeFileSync(museSpaceDocFile(), JSON.stringify({ schemaVersion: 1, rev: 4, template: 'brief', hero: { text: 'Hello', at: '2026-11-08T10:05:00Z' }, prepared: [],
    proposed: [{ key: 'focus-week', ref: { widgetId: 'w_31aa00000000' }, why: 'Your week went to Genesis' }] }));
  const app = express(); app.use(express.json()); app.use(specialRouter);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  if (prevUser === undefined) delete process.env.TANGU_USER_ID; else process.env.TANGU_USER_ID = prevUser;
  rmSync(home, { recursive: true, force: true });
});

describe('GET /agent/special/muse/space', () => {
  it('合成好的有效布局:那句话(时刻转成 epoch ms)、缺省三张、挂着的提议、两份 rev', async () => {
    const { status, body } = await call('GET', '/agent/special/muse/space');
    expect(status).toBe(200);
    expect(body.view).toMatchObject({
      enabled: true, hasDoc: true, hero: { text: 'Hello', at: Date.parse('2026-11-08T10:05:00Z'), sources: [] },
      rev: { doc: 4, placement: 0 }, problems: [], stoppedAt: null, sections: { prepared: true, today: true },
    });
    expect(body.view.cards.map((c: any) => c.key)).toEqual(['todos', 'today', 'tracking']);
    expect(body.view.proposed.map((c: any) => c.key)).toEqual(['focus-week']);
  });

  it('远程来源 403(回 Library 绝对路径、读本机文件)', async () => {
    expect((await call('GET', '/agent/special/muse/space', undefined, REMOTE)).status).toBe(403);
  });
});

describe('POST /agent/special/muse/space/placement', () => {
  it('坏 op / 坏 rev → 400;远程来源 403;都不写', async () => {
    expect((await call('POST', '/agent/special/muse/space/placement', { expectedRev: 0, op: { type: 'explode' } })).status).toBe(400);
    expect((await call('POST', '/agent/special/muse/space/placement', { expectedRev: -1, op: { type: 'reset' } })).status).toBe(400);
    expect((await call('POST', '/agent/special/muse/space/placement', { expectedRev: 0, op: { type: 'hide', key: 'todos' } }, REMOTE)).status).toBe(403);
    expect(() => readFileSync(musePlacementFile())).toThrow();
  });

  it('挪一张:200,rev + 1,顺序落盘', async () => {
    const r = await call('POST', '/agent/special/muse/space/placement', { expectedRev: 0, op: { type: 'move', key: 'tracking', to: 0 } });
    expect(r.status).toBe(200);
    expect(r.body.view.cards.map((c: any) => c.key)).toEqual(['tracking', 'todos', 'today']);
    expect(r.body.view.rev.placement).toBe(1);
    expect(JSON.parse(readFileSync(musePlacementFile(), 'utf8'))).toMatchObject({ rev: 1, order: ['tracking', 'todos', 'today'] });
  });

  it('rev 对不上 → 409 + 最新 view;格子里没有的卡挪不了 → 409', async () => {
    const stale = await call('POST', '/agent/special/muse/space/placement', { expectedRev: 0, op: { type: 'hide', key: 'todos' } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: 'conflict', view: { rev: { placement: 1 } } });
    const gone = await call('POST', '/agent/special/muse/space/placement', { expectedRev: 1, op: { type: 'move', key: 'nope', to: 0 } });
    expect(gone.status).toBe(409);
    expect(gone.body.reason).toBe('invalid');
  });

  it('拒绝提议:墓碑落进摆放,卜算子那份同时摘掉提议(rev + 1)', async () => {
    const r = await call('POST', '/agent/special/muse/space/placement', { expectedRev: 1, op: { type: 'reject', key: 'focus-week' } });
    expect(r.status).toBe(200);
    expect(r.body.view.proposed).toEqual([]);
    expect(r.body.view.rev).toEqual({ doc: 5, placement: 2 });
    expect(JSON.parse(readFileSync(museSpaceDocFile(), 'utf8')).proposed).toEqual([]);
    expect(JSON.parse(readFileSync(musePlacementFile(), 'utf8')).tombstones.map((t: any) => t.key)).toEqual(['focus-week']);
  });
});
