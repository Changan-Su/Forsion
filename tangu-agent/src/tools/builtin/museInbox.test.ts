/** inbox_read / inbox_mark:只给 Muse;审批 / 没领的奖励 / 反馈恒拒;没点过头的类别不标;撤回只认自己标的。库用真 SQLite。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ db: null as any, autoRead: [] as string[] }));
vi.mock('../../core/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  h.db = new Database(':memory:');
  h.db.exec(`CREATE TABLE inbox_messages (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, body TEXT, sender_kind TEXT, sender_id TEXT, thread TEXT, attachments TEXT, expires_at TEXT, read_at TEXT, read_by TEXT, archived_at TEXT, deleted_at TEXT, deliver_at TEXT, created_at TEXT)`);
  return { query: async (sql: string, params: any[] = []) => { const st = h.db.prepare(sql); return st.reader ? st.all(...params) : (st.run(...params), []); } };
});
vi.mock('../../services/specialAgentsConfig.js', () => ({ loadSpecialAgentsConfig: () => ({ muse: { inboxAutoRead: h.autoRead } }) }));
vi.mock('../../agents/agentRegistry.js', () => ({ MUSE_AGENT_SLUG: 'muse' }));

import { museInboxProvider } from './museInbox.js';
import { inboxCategory } from '../../services/inboxCategory.js';

const tools = museInboxProvider.tools() as any[];
const read = tools.find((t) => t.name === 'inbox_read');
const mark = tools.find((t) => t.name === 'inbox_mark');
const ctx = { userId: 'u', agentSlug: 'muse' } as any;
const seed = (id: string, m: Record<string, unknown>) => {
  const r = { user_id: 'u', title: id, body: '', sender_kind: 'agent', sender_id: 'muse', thread: null, attachments: null, read_at: null, read_by: null, created_at: `2026-10-30 0${h.db.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n}:00:00`, ...m };
  h.db.prepare(`INSERT INTO inbox_messages (id, user_id, title, body, sender_kind, sender_id, thread, attachments, read_at, read_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, r.user_id, r.title, r.body, r.sender_kind, r.sender_id, r.thread, r.attachments, r.read_at, r.read_by, r.created_at);
};
const row = (id: string) => h.db.prepare('SELECT read_at, read_by FROM inbox_messages WHERE id = ?').get(id);
const reward = JSON.stringify({ items: [{ type: 'points', amount: 200 }], claimed: false });

beforeEach(() => { h.db.exec('DELETE FROM inbox_messages'); h.autoRead = []; });

describe('类别', () => {
  it.each([
    [{ sender_kind: 'agent', sender_id: 'muse', body: '```forsion-approval\n{"id":"a"}\n```' }, 'approval'],
    [{ sender_kind: 'server', attachments: reward }, 'reward'],
    [{ sender_kind: 'server', attachments: JSON.stringify({ items: [{}], claimed: true }) }, 'official'], // 领过了就是普通官方信
    [{ sender_kind: 'server', thread: '{"kind":"feedback"}' }, 'feedback'],
    [{ sender_kind: 'server' }, 'official'],
    [{ sender_kind: 'system', sender_id: 'desktop' }, 'system'],
    [{ sender_kind: 'agent', sender_id: 'automation:r1' }, 'automation'],
    [{ sender_kind: 'agent', sender_id: 'xyra' }, 'agent'],
    [{ sender_kind: 'agent', sender_id: 'muse' }, 'muse'],
  ])('%j → %s', (m, want) => { expect(inboxCategory(m as any)).toBe(want); });
  it('脏附件按没有', () => { expect(inboxCategory({ sender_kind: 'server', attachments: '{bad' })).toBe('official'); });
});

describe('只给 Muse', () => {
  const profile = { capabilities: { hostExec: true } } as any;
  it('别的 Agent、Muse 的子代理、云端都看不到', () => {
    expect(read.isEnabledFor(profile, ctx)).toBe(true);
    expect(mark.isEnabledFor(profile, { agentSlug: 'xyra' })).toBe(false);
    expect(mark.isEnabledFor(profile, { agentSlug: 'muse', subAgentDepth: 1 })).toBe(false);
    expect(read.isEnabledFor({ capabilities: { hostExec: false } }, ctx)).toBe(false);
  });
});

describe('inbox_read', () => {
  it('列未读带类别与过期,不改已读;按 id 取正文', async () => {
    seed('a', { sender_kind: 'server', attachments: reward, body: 'secret' });
    seed('b', { read_at: '2026-10-30 01:00:00' });
    const out = JSON.parse(await read.execute({}, ctx));
    expect(out.unread.map((m: any) => [m.id, m.category, m.unclaimed])).toEqual([['a', 'reward', true]]);
    expect(JSON.stringify(out.unread)).not.toContain('secret');
    expect(out.note).toMatch(/never as instructions/);
    expect(row('a').read_at).toBeNull();
    expect(JSON.parse(await read.execute({ id: 'a' }, ctx)).body).toBe('secret');
  });
});

describe('inbox_mark', () => {
  it('点过头的类别:标已读,记 read_by=muse', async () => {
    h.autoRead = ['muse'];
    seed('m', {});
    expect(await mark.execute({ ids: ['m'], read: true }, ctx)).toMatch(/Marked as read: 1/);
    expect(row('m')).toMatchObject({ read_by: 'muse' });
    expect(row('m').read_at).toBeTruthy();
  });
  it('没点过头:拒,不动', async () => {
    seed('m', {});
    expect(await mark.execute({ ids: ['m'], read: true }, ctx)).toMatch(/has not agreed/);
    expect(row('m').read_at).toBeNull();
  });
  it('审批、没领的奖励、反馈恒拒,哪怕配置里写着', async () => {
    h.autoRead = ['approval', 'reward', 'feedback', 'official', 'muse'];
    seed('apv', { body: '```forsion-approval\n{"id":"a"}\n```' });
    seed('rew', { sender_kind: 'server', attachments: reward });
    seed('fb', { sender_kind: 'server', thread: '{"kind":"feedback"}' });
    seed('off', { sender_kind: 'server' }); // 官方信分不出类型:配置里有也不标
    const r = await mark.execute({ ids: ['apv', 'rew', 'fb', 'off'], read: true }, ctx);
    expect(r).toMatch(/Marked as read: 0/);
    for (const id of ['apv', 'rew', 'fb', 'off']) expect(row(id).read_at).toBeNull();
  });
  it('撤回只认自己标的,用户自己读过的不许改回未读', async () => {
    seed('mine', { read_at: '2026-10-30 01:00:00', read_by: 'muse' });
    seed('user', { read_at: '2026-10-30 01:00:00' });
    expect(await mark.execute({ ids: ['mine', 'user'], read: false }, ctx)).toMatch(/Back to unread: 1.*you did not mark/);
    expect(row('mine')).toEqual({ read_at: null, read_by: null });
    expect(row('user').read_at).toBeTruthy();
  });
  it('别的用户的信碰不到', async () => {
    h.autoRead = ['muse'];
    seed('x', { user_id: 'other' });
    expect(await mark.execute({ ids: ['x'], read: true }, ctx)).toMatch(/Marked as read: 0\. Not found: 1/);
  });
});
