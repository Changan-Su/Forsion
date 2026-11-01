/** 广播英文版(2026-10-23):pull 把服务端 title_en / body_en 落进 inbox_messages 对应列;老云端不给就是 NULL。 */
import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ inserts: [] as Array<{ sql: string; params: any[] }> }));

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, params: any[]) => {
    if (/INSERT INTO inbox_messages/.test(sql)) { state.inserts.push({ sql, params }); return { ok: true }; }
    if (/SELECT 1 AS x FROM inbox_messages WHERE id = \?/.test(sql)) return [{ x: 1 }];
    return [];
  }),
}));
vi.mock('../channels/forward.js', () => ({ forwardInboxToChannels: () => {} }));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ brain: { inbox: { listBroadcasts: async () => [
    { id: 'b1', title: '维护', body: '今晚', title_en: 'Maintenance', body_en: 'Tonight', created_at: '2026-10-23 10:00:00.000001' },
    { id: 'b2', title: '老云端', body: '', created_at: '2026-10-23 10:00:00.000002' },
    { id: 'b3', title: '更新', body: '', created_at: '2026-10-23 10:00:00.000003', kind: 'update' },
    { id: 'b4', title: '没见过的类型', body: '', created_at: '2026-10-23 10:00:00.000004', kind: 'newsletter' },
  ] } } }),
}));

import { pullBroadcastsOnce } from './inboxPull.js';

describe('pullBroadcastsOnce × 英文版', () => {
  it('title_en / body_en 落进同名列,缺省为 NULL', async () => {
    expect(await pullBroadcastsOnce('u1')).toEqual({ added: 4 });
    const col = (i: number, name: string) => {
      const { sql, params } = state.inserts[i];
      const cols = sql.match(/\(([^)]+)\)\s*VALUES/)![1].split(',').map((c) => c.trim());
      const vals = sql.match(/VALUES\s*\((.+)\)\s*ON CONFLICT/s)![1].split(',').map((v) => v.trim());
      const at = cols.indexOf(name); // VALUES 里有字面量('server' 等),参数下标 = 它前面的 ? 个数
      return vals[at] === '?' ? params[vals.slice(0, at).filter((v) => v === '?').length] : vals[at];
    };
    expect([col(0, 'title'), col(0, 'title_en'), col(0, 'body_en')]).toEqual(['维护', 'Maintenance', 'Tonight']);
    expect([col(1, 'title_en'), col(1, 'body_en'), col(1, 'origin_broadcast_id')]).toEqual([null, null, 'b2']);
    // 广播类型:老服务端没这个字段、不认识的值都按 other
    expect([0, 2, 3].map((i) => col(i, 'broadcast_kind'))).toEqual(['other', 'update', 'other']);
  });
});
