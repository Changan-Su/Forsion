/** Muse 私聊卡片:写口只有 decideMuseCard、推荐闸、记忆落点。库用真 SQLite(RETURNING / CAS 是这里要钉的东西)。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as any,
  dmOk: true,
  dms: [] as Array<{ text: string; origin: string }>,
  memory: [] as string[],
  logs: [] as string[],
}));

vi.mock('../core/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  h.db = new Database(':memory:');
  h.db.exec(`CREATE TABLE muse_cards (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, target_key TEXT, payload TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at BIGINT, decided_at BIGINT)`);
  return { query: async (sql: string, params: any[] = []) => { const st = h.db.prepare(sql); return st.reader ? st.all(...params) : (st.run(...params), []); } };
});
vi.mock('./museDm.js', () => ({
  postMuseDm: async (_u: string, text: string, origin: string) => {
    if (!h.dmOk) return { ok: false, error: 'Error: no dm' };
    h.dms.push({ text, origin });
    return { ok: true, sessionId: 's', messageId: 'm' };
  },
}));
vi.mock('../seams/runContext.js', () => ({ runWithAgentSlug: (_s: string, f: () => any) => f() }));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ brain: { memory: { appendMemoryEntry: async (_u: string, t: string) => { h.memory.push(t); }, appendLogEntry: async (_u: string, t: string) => { h.logs.push(t); } } } }),
}));
vi.mock('../agents/agentRegistry.js', () => ({ MUSE_AGENT_SLUG: 'muse' }));

import { decideMuseCard, getMuseCard, listMuseCards, postMuseCard, recommendBlocked, recommendHint } from './museCards.js';

const DAY = 86_400_000;
const plugin = (id = 'better-pdf') => ({ kind: 'plugin' as const, key: `plugin:${id}`, payload: { item: { id, name: 'Better PDF' } }, text: '你这周开了 9 份 PDF。' });

beforeEach(() => {
  h.db.exec('DELETE FROM muse_cards');
  h.dmOk = true; h.dms.length = 0; h.memory.length = 0; h.logs.length = 0;
});

describe('postMuseCard', () => {
  it('发进私聊:origin 是 proactive:card,正文末尾是带 id 的围栏', async () => {
    const r = await postMuseCard('u', plugin());
    expect(r.ok).toBe(true);
    expect(h.dms[0].origin).toBe('proactive:card');
    expect(h.dms[0].text).toMatch(/^你这周开了 9 份 PDF。\n\n```forsion-muse-card\n\{"id":"[0-9a-f-]+"\}\n```$/);
  });
  it('私聊发不出去:这行撤掉,卡片堆里不留来路不明的卡', async () => {
    h.dmOk = false;
    expect((await postMuseCard('u', plugin())).ok).toBe(false);
    expect(await listMuseCards('u')).toEqual([]);
  });
});

describe('推荐闸', () => {
  it('同一样东西不提第二次,超过一周也不行;一周内只有一张', async () => {
    await postMuseCard('u', plugin());
    expect(await recommendBlocked('u', 'plugin:better-pdf')).toMatch(/already recommended this one/);
    expect(await recommendBlocked('u', 'plugin:other')).toMatch(/last 7 days/);
    const later = Date.now() + 8 * DAY;
    expect(await recommendBlocked('u', 'plugin:other', later)).toBeNull();
    expect(await recommendBlocked('u', 'plugin:better-pdf', later)).toMatch(/already recommended this one/);
  });
  it('别的用户的卡不算', async () => {
    await postMuseCard('other', plugin());
    expect(await recommendBlocked('u', 'plugin:better-pdf')).toBeNull();
  });
  it('简报:额度用掉了就不出现;能推荐时列出提过的', async () => {
    expect(await recommendHint('u')).toContain('[Recommendation]');
    await postMuseCard('u', plugin());
    expect(await recommendHint('u')).toBe('');
    expect(await recommendHint('u', Date.now() + 8 * DAY)).toContain('plugin:better-pdf');
  });
});

describe('decideMuseCard', () => {
  it('不感兴趣:写记忆 + LOG,卡定格;再点 409,副作用不重复', async () => {
    const r = await postMuseCard('u', plugin());
    if (!r.ok) throw new Error('post failed');
    const first = await decideMuseCard('u', r.id, 'dismiss');
    expect(first.ok).toBe(true);
    expect((await getMuseCard('u', r.id))?.status).toBe('dismissed');
    expect(h.memory).toEqual(['The user is not interested in the plugin "Better PDF". Do not recommend it again.']);
    expect(h.logs).toHaveLength(1);
    const second = await decideMuseCard('u', r.id, 'dismiss');
    expect(second).toMatchObject({ ok: false, status: 409, error: 'card_not_pending' });
    expect(h.memory).toHaveLength(1);
  });
  it('action 按 kind 白名单;认不得的不动状态', async () => {
    const r = await postMuseCard('u', plugin());
    if (!r.ok) throw new Error('post failed');
    expect(await decideMuseCard('u', r.id, 'open')).toMatchObject({ ok: false, status: 400 });
    expect(await decideMuseCard('u', r.id, 'apply')).toMatchObject({ ok: false, status: 400 });
    expect((await getMuseCard('u', r.id))?.status).toBe('pending');
  });
  it('别的用户点不了', async () => {
    const r = await postMuseCard('u', plugin());
    if (!r.ok) throw new Error('post failed');
    expect(await decideMuseCard('intruder', r.id, 'dismiss')).toMatchObject({ ok: false, status: 404 });
  });
  it('功能卡「去打开」记成 done,不写记忆', async () => {
    const r = await postMuseCard('u', { kind: 'feature', key: 'feature:channels', payload: { feature: 'channels', title: '连微信', why: 'x' }, text: 'x' });
    if (!r.ok) throw new Error('post failed');
    await decideMuseCard('u', r.id, 'open');
    expect((await getMuseCard('u', r.id))?.status).toBe('done');
    expect(h.memory).toEqual([]);
  });
});
