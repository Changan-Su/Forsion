/**
 * 广播拉取 pullBroadcastsOnce 测试:真 SQLite(内存)+ fake brain.inbox。
 * 覆盖:首拉 since=undefined/created_at 微秒原文逐字节落库/幂等 added=0/绕过预查直接重放 INSERT
 * 验证部分唯一索引+无 target ON CONFLICT 在 SQLite 真实生效/游标推进原文相等/软删不复活/
 * 翻页与 5 页护栏/seam 缺失 added=0。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { pullBroadcastsOnce } from '../src/services/inboxPull.js';

const USER = 'u1';
const B1 = { id: 'b1', title: 'T1', body: 'B1', created_at: '2026-07-01 10:00:00.123456' };
const B2 = { id: 'b2', title: 'T2', body: 'B2', created_at: '2026-07-01 10:00:01.000001' };

let listBroadcasts: ReturnType<typeof vi.fn>;

function setup(withSeam = true): void {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  listBroadcasts = vi.fn(async () => []);
  configureTangu({
    host,
    brain: (withSeam ? { inbox: { listBroadcasts } } : {}) as any,
    billing: {} as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
}

beforeEach(async () => {
  setup();
  await runMigration();
});

async function rows(): Promise<any[]> {
  return query<any[]>(`SELECT * FROM inbox_messages WHERE user_id = ? ORDER BY created_at ASC`, [USER]);
}

describe('pullBroadcastsOnce', () => {
  it('首拉:since=undefined,微秒原文逐字节落库,sender=forsion', async () => {
    listBroadcasts.mockResolvedValueOnce([B1, B2]);
    const { added } = await pullBroadcastsOnce(USER);
    expect(added).toBe(2);
    expect(listBroadcasts).toHaveBeenCalledWith(undefined);
    const all = await rows();
    expect(all.map((r) => r.created_at)).toEqual([B1.created_at, B2.created_at]);
    expect(all[0].sender_kind).toBe('server');
    expect(all[0].sender_id).toBe('forsion');
    expect(all[0].origin_broadcast_id).toBe('b1');
  });

  it('幂等:同批再拉 added=0;游标推进为上批 max 原文', async () => {
    listBroadcasts.mockResolvedValueOnce([B1, B2]);
    await pullBroadcastsOnce(USER);
    listBroadcasts.mockResolvedValueOnce([B1, B2]);
    const { added } = await pullBroadcastsOnce(USER);
    expect(added).toBe(0);
    expect(listBroadcasts).toHaveBeenLastCalledWith(B2.created_at);
    expect((await rows()).length).toBe(2);
  });

  it('绕过预查直接重放 INSERT:部分唯一索引 + 无 target ON CONFLICT 在 SQLite 真实生效', async () => {
    listBroadcasts.mockResolvedValueOnce([B1]);
    await pullBroadcastsOnce(USER);
    await query(
      `INSERT INTO inbox_messages (id, user_id, title, body, sender_kind, sender_id, origin_broadcast_id, created_at)
       VALUES (?, ?, 'dup', '', 'server', 'forsion', ?, ?) ON CONFLICT DO NOTHING`,
      [uuidv4(), USER, B1.id, B1.created_at],
    );
    expect((await rows()).length).toBe(1);
  });

  it('软删不复活:软删广播行后同批再拉 added=0', async () => {
    listBroadcasts.mockResolvedValueOnce([B1, B2]);
    await pullBroadcastsOnce(USER);
    await query(`UPDATE inbox_messages SET deleted_at = '2026-07-02 00:00:00' WHERE origin_broadcast_id = 'b2'`);
    listBroadcasts.mockResolvedValueOnce([B1, B2]);
    const { added } = await pullBroadcastsOnce(USER);
    expect(added).toBe(0);
    // 游标仍是 b2 的 created_at(软删行参与游标)
    expect(listBroadcasts).toHaveBeenLastCalledWith(B2.created_at);
  });

  it('翻页:满页 200 继续拉,未满页停', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `p${i}`, title: `t${i}`, body: '', created_at: `2026-07-01 09:00:00.${String(100000 + i)}`,
    }));
    const page2 = [{ id: 'last', title: 'last', body: '', created_at: '2026-07-01 09:30:00.000000' }];
    listBroadcasts.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const { added } = await pullBroadcastsOnce(USER);
    expect(added).toBe(201);
    expect(listBroadcasts).toHaveBeenCalledTimes(2);
  });

  it('病态同游标死循环 → 5 页护栏终止', async () => {
    const page = Array.from({ length: 200 }, (_, i) => ({
      id: `q${i}`, title: `t${i}`, body: '', created_at: `2026-07-01 08:00:00.${String(100000 + i)}`,
    }));
    listBroadcasts.mockResolvedValue(page); // 恒返满页同数据
    const { added } = await pullBroadcastsOnce(USER);
    expect(added).toBe(200); // 首页全新,其后全 dup
    expect(listBroadcasts).toHaveBeenCalledTimes(5);
  });

  it('seam 缺失 → added=0 不抛', async () => {
    setup(false);
    await runMigration();
    const { added } = await pullBroadcastsOnce(USER);
    expect(added).toBe(0);
  });
});
