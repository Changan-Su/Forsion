/**
 * /agent/inbox 路由集成测试:真 SQLite(内存)+ 真 express(listen 随机端口,fetch 直打,不引 supertest)。
 * 覆盖:四 filter 可见集/unread-count(latestId 含已读)/PATCH 读写/read-all 不动未投递/软删语义
 * (视图消失但广播游标仍含该行)/pull 无 seam 时优雅降级。
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
import inboxRouter from '../src/routes/inbox.js';

const USER = 'u1';
let srv: Server;
let base: string;

const api = async (path: string, init?: RequestInit): Promise<any> => {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x', ...(init?.headers || {}) },
  });
  return r.json();
};

const utc = (msOffset: number): string => new Date(Date.now() + msOffset).toISOString().slice(0, 19).replace('T', ' ');

async function seed(id: string, opts: Partial<Record<'deliver_at' | 'read_at' | 'archived_at' | 'deleted_at' | 'origin' | 'created_at', string | null>> = {}): Promise<void> {
  await query(
    `INSERT INTO inbox_messages (id, user_id, title, body, sender_kind, sender_id, origin_broadcast_id, deliver_at, read_at, archived_at, deleted_at, created_at)
     VALUES (?, ?, ?, '', 'agent', 'xyra', ?, ?, ?, ?, ?, ?)`,
    [id, USER, `标题-${id}`, opts.origin ?? null, opts.deliver_at ?? null, opts.read_at ?? null, opts.archived_at ?? null, opts.deleted_at ?? null, opts.created_at ?? utc(0)],
  );
}

beforeAll(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();

  const app = express();
  app.use(express.json());
  app.use(inboxRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;

  // 六态种子(created_at 递增控制排序):m1 未读已投/m2 已读/m3 归档/m4 软删+广播锚/m5 定时未来/m6 过去 deliver_at 已投未读
  await seed('m1', { created_at: utc(-50_000) });
  await seed('m2', { read_at: utc(-40_000), created_at: utc(-40_000) });
  await seed('m3', { archived_at: utc(-30_000), created_at: utc(-30_000) });
  await seed('m4', { deleted_at: utc(-20_000), origin: 'b1', created_at: utc(-20_000) });
  await seed('m5', { deliver_at: utc(3600_000), created_at: utc(-10_000) });
  await seed('m6', { deliver_at: utc(-5_000), created_at: utc(-5_000) });
});

afterAll(() => { srv?.close(); });

describe('/agent/inbox', () => {
  it('未带 token → 401', async () => {
    const r = await fetch(`${base}/agent/inbox`);
    expect(r.status).toBe(401);
  });

  it('filter=all:已投递、未归档、未删(m6 由过去 deliver_at 生效)', async () => {
    const { messages } = await api('/agent/inbox?filter=all');
    expect(messages.map((m: any) => m.id)).toEqual(['m6', 'm2', 'm1']);
  });

  it('filter=unread', async () => {
    const { messages } = await api('/agent/inbox?filter=unread');
    expect(messages.map((m: any) => m.id)).toEqual(['m6', 'm1']);
  });

  it('filter=archived / filter=scheduled', async () => {
    expect((await api('/agent/inbox?filter=archived')).messages.map((m: any) => m.id)).toEqual(['m3']);
    expect((await api('/agent/inbox?filter=scheduled')).messages.map((m: any) => m.id)).toEqual(['m5']);
  });

  it('unread-count:count=未读数,latestId=最新已投递(含已读)', async () => {
    const r = await api('/agent/inbox/unread-count');
    expect(r.count).toBe(2);
    expect(r.latestId).toBe('m6');
  });

  it('PATCH read 往返 + 归档不隐含已读', async () => {
    expect((await api('/agent/inbox/m1', { method: 'PATCH', body: JSON.stringify({ read: true }) })).ok).toBe(true);
    expect((await api('/agent/inbox/unread-count')).count).toBe(1);
    expect((await api('/agent/inbox/m1', { method: 'PATCH', body: JSON.stringify({ read: false }) })).ok).toBe(true);
    expect((await api('/agent/inbox/unread-count')).count).toBe(2);
    // 空 body → 400
    const bad = await fetch(`${base}/agent/inbox/m1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: '{}' });
    expect(bad.status).toBe(400);
  });

  it('read-all:清未读但不动未投递的定时消息', async () => {
    expect((await api('/agent/inbox/read-all', { method: 'POST' })).ok).toBe(true);
    expect((await api('/agent/inbox/unread-count')).count).toBe(0);
    const m5 = await query<any[]>(`SELECT read_at FROM inbox_messages WHERE id = 'm5'`);
    expect(m5[0].read_at).toBeNull();
  });

  it('DELETE 软删:视图消失、广播游标仍含软删行', async () => {
    expect((await api('/agent/inbox/m6', { method: 'DELETE' })).ok).toBe(true);
    const { messages } = await api('/agent/inbox?filter=all');
    expect(messages.map((m: any) => m.id)).not.toContain('m6');
    // m4 是软删的广播行,MAX 游标必须仍能看到它(不过滤 deleted_at)
    const cur = await query<any[]>(`SELECT MAX(created_at) AS c FROM inbox_messages WHERE user_id = ? AND origin_broadcast_id IS NOT NULL`, [USER]);
    expect(cur[0].c).toBeTruthy();
    // 已删的再删 → 404
    const r = await fetch(`${base}/agent/inbox/m6`, { method: 'DELETE', headers: { Authorization: 'Bearer x' } });
    expect(r.status).toBe(404);
  });

  it('pull:未配置云端(brain 无 inbox seam)→ 200 优雅降级', async () => {
    const r = await api('/agent/inbox/pull', { method: 'POST' });
    expect(r.pulled).toBe(false);
    expect(r.added).toBe(0);
  });
});
