/** Muse 私聊卡片:写口只有 decideMuseCard、推荐闸、记忆落点。库用真 SQLite(RETURNING / CAS 是这里要钉的东西)。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as any,
  dmOk: true,
  dms: [] as Array<{ text: string; origin: string }>,
  memory: [] as string[],
  logs: [] as string[],
  entries: [] as Array<{ id: string; content: string }>,
  mutations: [] as any[],
  muse: { inboxAutoRead: [] as string[], inboxIgnored: [] as string[] } as any,
  onboarding: {} as any,
}));

vi.mock('../core/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  h.db = new Database(':memory:');
  h.db.exec(`CREATE TABLE inbox_messages (id TEXT, user_id TEXT, title TEXT, body TEXT, sender_kind TEXT, sender_id TEXT, thread TEXT, attachments TEXT, expires_at TEXT, read_at TEXT, broadcast_kind TEXT, archived_at TEXT, deleted_at TEXT, deliver_at TEXT)`);
  h.db.exec(`CREATE TABLE chat_sessions (id TEXT, user_id TEXT)`);
  h.db.exec(`CREATE TABLE chat_messages (id TEXT, session_id TEXT, content TEXT, origin TEXT)`);
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
  deps: () => ({ brain: { memory: {
    appendMemoryEntry: async (_u: string, t: string) => { h.memory.push(t); },
    appendLogEntry: async (_u: string, t: string) => { h.logs.push(t); },
    getMemorySnapshot: async () => ({ entries: h.entries }),
    mutateMemory: async (_u: string, m: any) => { h.mutations.push(m); },
  } } }),
}));
vi.mock('../agents/agentRegistry.js', () => ({ MUSE_AGENT_SLUG: 'muse' }));
vi.mock('./specialAgentsConfig.js', () => ({
  loadSpecialAgentsConfig: () => ({ muse: h.muse }),
  updateMuseConfig: (fn: any) => { const patch = fn(h.muse); Object.assign(h.muse, patch); return { muse: h.muse }; },
}));
vi.mock('./museState.js', () => ({ patchMuseOnboarding: async (p: any) => { Object.assign(h.onboarding, p); } }));

import { decideMuseCard, getMuseCard, inboxAskBlocked, inboxListBlocked, inboxHint, listMuseCards, pickMuseSettings, postIntroCard, postMuseCard, postSummaryCard, recommendBlocked, recommendHint, recordMessageFeedback } from './museCards.js';

const DAY = 86_400_000;
const plugin = (id = 'better-pdf') => ({ kind: 'plugin' as const, key: `plugin:${id}`, payload: { item: { id, name: 'Better PDF' } }, text: '你这周开了 9 份 PDF。' });

beforeEach(() => {
  h.db.exec('DELETE FROM muse_cards');
  h.dmOk = true; h.dms.length = 0; h.memory.length = 0; h.logs.length = 0;
  h.muse.inboxAutoRead = []; h.muse.inboxIgnored = [];
  for (const k of ['heartbeatMinutes', 'activeHours', 'notify', 'maxDmPerDay', 'mode', 'grantedFolders']) delete h.muse[k];
  h.entries = []; h.mutations.length = 0; h.onboarding = {};
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

describe('收件箱卡', () => {
  const ask = () => postMuseCard('u', { kind: 'inbox-ask', key: 'inbox-ask:muse', payload: { category: 'muse', question: '这类以后帮你直接标已读？' }, text: '这类以后帮你直接标已读？' });
  const mail = (id: string, m: Record<string, unknown> = {}) => h.db.prepare(`INSERT INTO inbox_messages (id, user_id, title, body, sender_kind, sender_id, attachments) VALUES (?, 'u', ?, ?, ?, ?, ?)`)
    .run(id, id, '', m.kind ?? 'agent', m.sender ?? 'muse', m.attachments ?? null);
  beforeEach(() => { h.db.exec('DELETE FROM inbox_messages'); });

  it('问一次:只能问点头过才能自动标的类别;问过、答过都不再问', async () => {
    expect(await inboxAskBlocked('u', 'official', h.muse)).toMatch(/only ask about muse/);
    expect(await inboxAskBlocked('u', 'reward', h.muse)).toMatch(/only ask about muse/);
    expect(await inboxAskBlocked('u', 'muse', h.muse)).toBeNull();
    await ask();
    expect(await inboxAskBlocked('u', 'muse', h.muse)).toMatch(/already asked/);
  });
  it('「好」写进 inboxAutoRead,「这类以后都别管」写进 inboxIgnored,「先不用」两边都不写', async () => {
    const a = await ask(); if (!a.ok) throw new Error('x');
    await decideMuseCard('u', a.id, 'yes');
    expect(h.muse.inboxAutoRead).toEqual(['muse']);
    h.db.exec('DELETE FROM muse_cards'); h.muse.inboxAutoRead = [];
    const b = await ask(); if (!b.ok) throw new Error('x');
    await decideMuseCard('u', b.id, 'ignore');
    expect(h.muse.inboxIgnored).toEqual(['muse']);
    expect(h.muse.inboxAutoRead).toEqual([]);
    h.db.exec('DELETE FROM muse_cards'); h.muse.inboxIgnored = [];
    const c = await ask(); if (!c.ok) throw new Error('x');
    await decideMuseCard('u', c.id, 'later');
    expect(h.muse).toMatchObject({ inboxAutoRead: [], inboxIgnored: [] });
    expect((await getMuseCard('u', c.id))?.result).toBe('later');
  });
  it('清单:一条条处理,都处理完自己收起;一天一张', async () => {
    const r = await postMuseCard('u', { kind: 'inbox-list', key: 'inbox-list', payload: { items: [{ id: 'a' }, { id: 'b' }] }, text: '两件' });
    if (!r.ok) throw new Error('x');
    expect(await inboxListBlocked('u')).toMatch(/last 24 hours/);
    expect(await inboxListBlocked('u', Date.now() + DAY + 1000)).toBeNull();
    await decideMuseCard('u', r.id, 'item', { messageId: 'a' });
    const mid = await getMuseCard('u', r.id);
    expect(mid?.status).toBe('pending');
    expect(mid?.payload.items[0].handled).toBe(true);
    await decideMuseCard('u', r.id, 'item', { messageId: 'b' });
    expect((await getMuseCard('u', r.id))?.status).toBe('done');
    expect(await decideMuseCard('u', r.id, 'item', { messageId: 'b' })).toMatchObject({ ok: false, status: 409 });
  });
  it('简报:按类计数,被「别管」的不算;清单规矩只在有要动手的信时才写', async () => {
    mail('m');
    let hint = await inboxHint('u', h.muse);
    expect(hint).toContain('Unread: muse 1');
    expect(hint).not.toContain('inbox_list');
    expect(hint).toContain('inbox_ask');
    mail('r', { kind: 'server', sender: null, attachments: JSON.stringify({ items: [{}], claimed: false }) });
    hint = await inboxHint('u', h.muse);
    expect(hint).toContain('reward 1');
    expect(hint).toContain('inbox_list');
    expect(await inboxHint('u', { ...h.muse, inboxIgnored: ['muse', 'reward'] })).toBe('');
    expect(await inboxHint('u', { ...h.muse, inboxAutoRead: ['muse'] })).toContain('mark muse mail as read');
  });
  it('清单挂了两天没人理,简报才提连通道;提过不再提', async () => {
    mail('r', { kind: 'server', sender: null, attachments: JSON.stringify({ items: [{}], claimed: false }) });
    await postMuseCard('u', { kind: 'inbox-list', key: 'inbox-list', payload: { items: [] }, text: 'x' });
    expect(await inboxHint('u', h.muse)).not.toContain('channel');
    const later = Date.now() + 2 * DAY + 1000;
    expect(await inboxHint('u', h.muse, later)).toContain('card {type:"channel"}');
    await postMuseCard('u', { kind: 'channel', key: 'channel', payload: {}, text: 'x' });
    expect(await inboxHint('u', h.muse, later)).not.toContain('card {type:"channel"}');
  });
});

describe('设置变更卡', () => {
  const base = { heartbeatMinutes: 120, activeHours: null, notify: 'immediate', maxDmPerDay: 0, mode: 'ask' };
  const post = async (patch: Record<string, unknown>) => {
    Object.assign(h.muse, base);
    const { changes } = pickMuseSettings(h.muse, patch);
    const r = await postMuseCard('u', { kind: 'settings', payload: { patch, changes }, text: '', uncapped: true });
    return (r as any).card?.id ?? (await listMuseCards('u'))[0].id;
  };
  it('pickMuseSettings 只挑放行名单里、真的变了的字段', () => {
    const r = pickMuseSettings(base as any, { heartbeatMinutes: 120, notify: 'digest', mode: 'auto', grantedFolders: ['/'] });
    expect(r.patch).toEqual({ notify: 'digest' });
    expect(r.changes).toEqual([{ field: 'notify', from: 'immediate', to: 'digest' }]);
  });
  it('点「改」写进设置;payload 里夹带的权限档、文件夹写不进去', async () => {
    const id = await post({ activeHours: { start: 9, end: 23 }, mode: 'auto', grantedFolders: ['/'] });
    expect((await decideMuseCard('u', id, 'apply')).ok).toBe(true);
    expect(h.muse.activeHours).toEqual({ start: 9, end: 23 });
    expect(h.muse.mode).toBe('ask');
    expect(h.muse.grantedFolders).toBeUndefined();
    expect((await getMuseCard('u', id))!.status).toBe('done');
  });
  it('点「不用」什么都不改,Muse 下个周期读得到', async () => {
    const id = await post({ notify: 'digest' });
    await decideMuseCard('u', id, 'dismiss');
    expect(h.muse.notify).toBe('immediate');
    expect((await getMuseCard('u', id))!.status).toBe('dismissed');
    expect(h.logs.join('\n')).toMatch(/turned down/);
  });
  it('一张卡只认一次:第二下 409,不再写配置', async () => {
    const id = await post({ notify: 'digest' });
    await decideMuseCard('u', id, 'apply');
    h.muse.notify = 'immediate';
    const again = await decideMuseCard('u', id, 'apply');
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(h.muse.notify).toBe('immediate');
  });
});

describe('第一次见面', () => {
  it('答案落两处:作息 / 频率改设置,其余进记忆', async () => {
    Object.assign(h.muse, { activeHours: null, maxDmPerDay: 0 });
    await postIntroCard('u');
    expect(h.onboarding.introAt).toBeGreaterThan(0);
    const [card] = await listMuseCards('u');
    await decideMuseCard('u', card.id, 'answer', { answers: { when: 'daytime', pace: 'daily', focus: ['study', 'bogus'] } });
    expect(h.muse.activeHours).toEqual({ start: 9, end: 21 });
    expect(h.muse.maxDmPerDay).toBe(1);
    expect(h.memory.join('\n')).toMatch(/study/);
    expect(h.memory.join('\n')).not.toMatch(/bogus/);
  });
  it('「只在开着 Forsion 时」「有事才说」对不上设置项:只进记忆', async () => {
    Object.assign(h.muse, { activeHours: { start: 8, end: 20 }, maxDmPerDay: 2 });
    await postIntroCard('u');
    const [card] = await listMuseCards('u');
    await decideMuseCard('u', card.id, 'answer', { answers: { when: 'open', pace: 'as-needed' } });
    expect(h.muse.activeHours).toEqual({ start: 8, end: 20 });
    expect(h.muse.maxDmPerDay).toBe(2);
    expect(h.memory).toHaveLength(2);
  });
  it('跳过:设置和记忆都不动', async () => {
    Object.assign(h.muse, { activeHours: null });
    await postIntroCard('u');
    const [card] = await listMuseCards('u');
    await decideMuseCard('u', card.id, 'skip');
    expect(h.muse.activeHours).toBeNull();
    expect(h.memory).toEqual([]);
    expect((await getMuseCard('u', card.id))!.status).toBe('done');
  });
});

describe('第 14 天小结', () => {
  const setup = async () => {
    await postSummaryCard('u', '两周下来：', ['晚上别提代码', '日报只要三条', '']);
    h.entries = [{ id: 'm1', content: '晚上别提代码' }, { id: 'm2', content: '日报只要三条' }];
    return (await listMuseCards('u'))[0];
  };
  it('只发一次;每条写进记忆', async () => {
    const card = await setup();
    expect(card.payload.items).toEqual(['晚上别提代码', '日报只要三条']);
    expect(h.memory).toEqual(['晚上别提代码', '日报只要三条']);
    expect(h.onboarding.summaryAt).toBeGreaterThan(0);
    expect(await postSummaryCard('u', 'again', ['x'])).toMatch(/already/);
  });
  it('改一条:记忆跟着改,卡还在', async () => {
    const card = await setup();
    await decideMuseCard('u', card.id, 'edit', { index: 0, text: '十点以后别提代码' });
    expect(h.mutations).toEqual([{ action: 'update', id: 'm1', fact: '十点以后别提代码' }]);
    const after = await getMuseCard('u', card.id);
    expect(after!.status).toBe('pending');
    expect(after!.payload.items[0]).toBe('十点以后别提代码');
  });
  it('删到空:记忆跟着删,卡自己收起', async () => {
    const card = await setup();
    await decideMuseCard('u', card.id, 'remove', { index: 1 });
    await decideMuseCard('u', card.id, 'remove', { index: 0 });
    expect(h.mutations.map((m) => [m.action, m.id])).toEqual([['forget', 'm2'], ['forget', 'm1']]);
    expect((await getMuseCard('u', card.id))!.status).toBe('done');
  });
  it('序号越界不碰记忆', async () => {
    const card = await setup();
    expect(await decideMuseCard('u', card.id, 'remove', { index: 9 })).toMatchObject({ ok: false, status: 400 });
    expect(h.mutations).toEqual([]);
  });
});

describe('消息反馈', () => {
  beforeEach(() => {
    h.db.exec('DELETE FROM chat_sessions; DELETE FROM chat_messages');
    h.db.prepare('INSERT INTO chat_sessions VALUES (?, ?)').run('s1', 'u');
    h.db.prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?)').run('m1', 's1', '记得交周报', 'proactive');
    h.db.prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?)').run('m2', 's1', '用户自己说的', null);
  });
  it('「少来点这种」按这类消息记,不只这一条', async () => {
    expect(await recordMessageFeedback('u', 'm1', 'down')).toBe(true);
    expect(h.logs[0]).toMatch(/\[feedback\].*记得交周报.*that kind of message/);
  });
  it('只认这个用户的主动消息', async () => {
    expect(await recordMessageFeedback('u', 'm2', 'up')).toBe(false);
    expect(await recordMessageFeedback('other', 'm1', 'up')).toBe(false);
    expect(h.logs).toEqual([]);
  });
});

describe('收件箱询问按类型', () => {
  it('更新 / 商店 / 维护能问,促销和其余官方信不能问', async () => {
    for (const c of ['update', 'store', 'maintenance', 'muse']) expect(await inboxAskBlocked('u', c, h.muse)).toBeNull();
    for (const c of ['promo', 'official', 'other']) expect(await inboxAskBlocked('u', c, h.muse)).toMatch(/only ask about/);
  });
});
