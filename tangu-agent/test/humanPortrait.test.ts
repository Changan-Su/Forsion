// 画像写入第 1 步(10-29):human/SOUL.md 的条目增删改、预算、墓碑、标题语言;remember 的 person 档、门禁与跨档挪;
// 画像条目 / 交给所有 Agent 两条路由(本机 / 远端拒);空模板不进提示词;通道会话不注入人的本子和画像;两台设备合并画像条目。
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createAiStudioProfile, createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { humanDir, readUserMdForPrompt, USER_MD_TEMPLATE, LEGACY_USER_MD_TEMPLATES, userMdFile } from '../src/core/tanguHome.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { readHuman, writeHuman } from '../src/agents/humanStore.js';
import { joinFirstContact, renderAboutHuman } from '../src/agents/humanFolder.js';
import { isPortraitFactForgotten, mergePortrait, mutatePortrait, PortraitFullError, portraitEntries, portraitEntryId, readPortrait } from '../src/agents/humanPortrait.js';
import { memoryLogProvider } from '../src/tools/builtin/memoryLog.js';
import { createMemoryRepository } from '../src/services/memoryRepository.js';
import humanRouter from '../src/routes/human.js';

let home: string, base: string, server: Server, database: { close(): void };
const previousHome = process.env.TANGU_HOME;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // 每步都过真文件锁 + fsync:机器忙时 5 秒默认不够,超时的那条还在跑会踩下一条的 beforeEach
const soul = () => join(humanDir(), 'SOUL.md');
const readSoul = () => { try { return readFileSync(soul(), 'utf8'); } catch { return ''; } };
const setSoul = async (content: string) => {
  const doc = await readHuman({ kind: 'human', file: 'SOUL.md' });
  await writeHuman({ kind: 'human', file: 'SOUL.md' }, { content, summary: 'fixture', expectedVersion: doc.version }, 'user');
};
const api = async (url: string, method = 'GET', body?: any, extraHeaders = {}) => {
  const r = await fetch(base + url, { method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const tombstones = () => join(home, 'human-history', 'portrait-tombstones.json');
const tool = () => memoryLogProvider.tools().find((t) => t.name === 'remember')! as any;
const ctx = (extra: Record<string, unknown> = {}) => ({ userId: 'owner', sessionId: 'portrait-session', runId: 'portrait-run', appId: 'tangu', execMode: 'host' as const, ...extra });
const remember = (args: any, extra: Record<string, unknown> = {}, slug = 'first') => runWithAgentSlug(slug, () => tool().execute(args, ctx(extra))) as Promise<string>;
const agentMemory = (slug = 'first') => createMemoryRepository(join(home, 'agents', slug)).snapshot();

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-portrait-'))); process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await saveAgent({ slug: 'first', name: 'First', systemPrompt: 'fixture' });
  await saveAgent({ slug: 'second', name: 'Second', systemPrompt: 'fixture' });
  const app = express(); app.use(express.json()); app.use(humanRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  database?.close();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});
beforeEach(async () => {
  await setSoul('');
  rmSync(tombstones(), { force: true });
});

describe('portrait entries (human/SOUL.md)', () => {
  it('adds under its own section, picks the heading by the sentence\'s script and never touches what the human wrote', async () => {
    await setSoul('# About Lin\n\nLin writes this paragraph herself.\n\n- Likes tea\n');
    const added = await mutatePortrait({ action: 'add', fact: 'You prefer to be called Lin.', actor: 'agent', source: { kind: 'remember', agent: 'first' } });
    expect(readSoul()).toBe('# About Lin\n\nLin writes this paragraph herself.\n\n- Likes tea\n\n## Recently learned\n\n- You prefer to be called Lin.\n');
    expect(added.entry).toEqual({ id: portraitEntryId('You prefer to be called Lin.'), content: 'You prefer to be called Lin.' });
    await mutatePortrait({ action: 'add', fact: '你在学日语。', actor: 'agent', source: { kind: 'remember', agent: 'first' } });
    expect(readSoul().endsWith('## Recently learned\n\n- You prefer to be called Lin.\n- 你在学日语。\n')).toBe(true); // 已有那一节就接在最后一条后面
    // 修改记录带来源:哪个 Agent、哪条路
    const doc = await readHuman({ kind: 'human', file: 'SOUL.md' });
    expect(doc.history[0]).toMatchObject({ actor: 'agent', summary: '你在学日语。', source: { kind: 'remember', agent: 'first', action: 'add' } });
    // 没有那一节、这句是中文 → 中文标题
    await setSoul('');
    await mutatePortrait({ action: 'add', fact: '你习惯晚上写代码。', actor: 'agent', source: { kind: 'remember', agent: 'first' } });
    expect(readSoul()).toBe('## 最近认识的\n\n- 你习惯晚上写代码。\n');
    // 人自己写的同名节(任意级标题)也认:接在那一节最后一条后面,下一节不动
    await setSoul('### recently learned\n\n- one\n\n## Other\n\ntext\n');
    await mutatePortrait({ action: 'add', fact: 'two', actor: 'agent', source: { kind: 'remember' } });
    expect(readSoul()).toBe('### recently learned\n\n- one\n- two\n\n## Other\n\ntext\n');
  });

  it('dedupes, updates in place keeping the marker, forgets with a tombstone, and only an explicit add lifts it', async () => {
    await setSoul('Intro.\n\n  * Likes tea\n');
    const dup = await mutatePortrait({ action: 'add', fact: '  likes   TEA ', actor: 'agent', source: { kind: 'remember' } });
    expect(dup.duplicate).toBe(true); expect(dup.change).toBeNull();
    const view = await readPortrait();
    expect(view).toMatchObject({ entries: [{ content: 'Likes tea' }], limit: 2000 });
    expect(view.version).toHaveLength(12);
    const updated = await mutatePortrait({ action: 'update', id: view.entries[0].id, fact: 'Likes green tea', expectedVersion: view.version, actor: 'agent', source: { kind: 'remember' } });
    expect(readSoul()).toBe('Intro.\n\n  * Likes green tea\n');
    expect(updated.entry?.content).toBe('Likes green tea');
    expect(isPortraitFactForgotten('Likes tea')).toBe(true); // 改写掉的旧说法也挡住自动写回
    // 版本对不上 = 冲突,不写
    await expect(mutatePortrait({ action: 'forget', id: updated.entry!.id, expectedVersion: view.version, actor: 'agent', source: { kind: 'remember' } })).rejects.toMatchObject({ code: 'HUMAN_CONFLICT' });
    await mutatePortrait({ action: 'forget', id: updated.entry!.id, expectedVersion: updated.document.version.slice(0, 12), actor: 'user', source: { kind: 'user' } });
    expect(readSoul()).toBe('Intro.\n\n');
    expect(isPortraitFactForgotten('likes green tea')).toBe(true);
    const skipped = await mutatePortrait({ action: 'add', fact: 'Likes green tea', actor: 'agent', source: { kind: 'dream' }, skipForgotten: true });
    expect(skipped.forgotten).toBe(true); expect(readSoul()).toBe('Intro.\n\n');
    await mutatePortrait({ action: 'add', fact: 'Likes green tea', actor: 'agent', source: { kind: 'remember' } });
    expect(isPortraitFactForgotten('Likes green tea')).toBe(false);
    // 删掉 Agent 那一节的最后一条:那一节的标题一起收掉
    await setSoul('Intro.\n\n## Recently learned\n\n- only one\n');
    await mutatePortrait({ action: 'forget', id: portraitEntryId('only one'), actor: 'agent', source: { kind: 'remember' } });
    expect(readSoul()).toBe('Intro.\n');
  });

  it('refuses an agent add past 2,000 characters with its own entries, still lets it shorten or forget, and never limits the human', async () => {
    const prose = `# Me\n\n${'p'.repeat(1900)}\n`;
    await setSoul(`${prose}\n## Recently learned\n\n- ${'x'.repeat(60)}\n`);
    const err = await mutatePortrait({ action: 'add', fact: 'y'.repeat(80), actor: 'agent', source: { kind: 'remember' } }).catch((e) => e);
    expect(err).toBeInstanceOf(PortraitFullError);
    expect(err.section).toEqual([{ id: portraitEntryId('x'.repeat(60)), content: 'x'.repeat(60) }]);
    expect(readSoul()).not.toContain('y'.repeat(80));
    await mutatePortrait({ action: 'update', id: portraitEntryId('x'.repeat(60)), fact: 'x'.repeat(30), actor: 'agent', source: { kind: 'remember' } });
    await mutatePortrait({ action: 'forget', id: portraitEntryId('x'.repeat(30)), actor: 'agent', source: { kind: 'remember' } });
    expect(readSoul()).toContain('p'.repeat(1900)); // 人写的那段一字不动
    await mutatePortrait({ action: 'add', fact: 'z'.repeat(200), actor: 'user', source: { kind: 'user' } }); // 人从回执撤销 / 加回不受预算限制
    expect(readSoul()).toContain('z'.repeat(200));
  });

  it('an unreadable tombstone list is an error for Dream, not "nothing was forgotten"', async () => {
    writeFileSync(tombstones(), '{broken');
    expect(() => isPortraitFactForgotten('x')).toThrow(/unreadable/);
    await expect(mutatePortrait({ action: 'add', fact: 'x', actor: 'agent', source: { kind: 'dream' }, skipForgotten: true })).rejects.toMatchObject({ code: 'PORTRAIT_TOMBSTONES_INVALID' });
    expect(readSoul()).toBe('');
    // 显式写入照常落下,也不拿空列表盖掉那份读不懂的
    await mutatePortrait({ action: 'add', fact: 'x', actor: 'agent', source: { kind: 'remember' } });
    expect(readFileSync(tombstones(), 'utf8')).toBe('{broken');
  });
});

describe('remember: person scope', () => {
  it('offers person only where the portrait may be written; the slim definitions stay byte-identical elsewhere', () => {
    const t = tool();
    const local = t.definitionFor(ctx()).function;
    expect(local.parameters.properties.scope.enum).toEqual(['agent', 'person']);
    expect(local.parameters.properties.from).toBeUndefined(); // 旧条目在哪一档由 id 查,不让模型说
    expect(local.parameters.required).toEqual(['action', 'fact']); // 不带 scope 的旧调用照旧按 agent
    expect(t.definitionFor({ ...ctx(), projectScoped: true }).function.parameters.properties.scope.enum).toEqual(['agent', 'project', 'person']);
    expect(t.definitionFor(ctx())).toBe(t.definitionFor(ctx())); // 同一份对象:逐轮字节一致
    for (const off of [{ channelSession: true }, { channelUnknown: true }, { subAgentDepth: 1 }, { ephemeral: true }, { remote: { marked: true } }, { profile: createAiStudioProfile() }]) {
      expect(t.definitionFor(ctx({ execMode: 'sandbox', ...off })), JSON.stringify(Object.keys(off))).toBe(t.definition);
    }
  });

  it('writes the portrait, lists it, and returns the receipt the desktop draws', async () => {
    const added = JSON.parse(await remember({ action: 'add', scope: 'person', fact: 'You prefer to be called Lin.' }));
    expect(added).toMatchObject({ ok: true, action: 'add', scope: 'person', entry: { id: portraitEntryId('You prefer to be called Lin.'), content: 'You prefer to be called Lin.' }, count: 1, limit: 2000 });
    expect(added.version).toHaveLength(12);
    expect(readSoul()).toContain('- You prefer to be called Lin.');
    expect(agentMemory().content).toBe(''); // 没进 Agent 自己的记忆
    const again = JSON.parse(await remember({ action: 'add', scope: 'person', fact: 'You prefer to be called Lin.' }));
    expect(again).toMatchObject({ ok: true, duplicate: true, scope: 'person' });
    const listed = JSON.parse(await remember({ action: 'list', fact: null }));
    expect(listed.person).toMatchObject({ version: added.version, entries: [{ id: added.entry.id }], limit: 2000 });
    const forgotten = JSON.parse(await remember({ action: 'forget', scope: 'person', id: added.entry.id, expectedVersion: added.version, fact: null }));
    expect(forgotten).toMatchObject({ ok: true, action: 'forget', scope: 'person', id: added.entry.id, count: 0 });
    expect((await readHuman({ kind: 'human', file: 'SOUL.md' })).history[0].source).toEqual({ kind: 'remember', agent: 'first', action: 'forget' });
  });

  it('refuses person where it is not offered, and never falls back to the Agent\'s own memory', async () => {
    const before = agentMemory().version;
    for (const off of [{ channelSession: true }, { subAgentDepth: 1 }]) {
      const r = await remember({ action: 'add', scope: 'person', fact: 'You live in Hangzhou.' }, off);
      expect(r).toMatch(/^Error: scope "person" .* not available/);
      expect(r).toContain('Nothing was written');
    }
    expect(await remember({ action: 'add', scope: 'person', fact: 'You live in Hangzhou.' }, { remote: { marked: true } })).toMatch(/^Error: Remote sessions cannot/);
    expect(await remember({ action: 'add', scope: 'person', fact: 'You live in Hangzhou.' }, { channelSession: true })).toContain('chat channel');
    expect(agentMemory().version).toBe(before);
    expect(readSoul()).toBe('');
    // 没有 mutateMemory 的后端:person 也不会落到最后那条 append
    const brain = deps().brain.memory as any;
    const mutate = brain.mutateMemory; const append = vi.spyOn(brain, 'appendMemoryEntry');
    delete brain.mutateMemory;
    try {
      expect(await remember({ action: 'add', scope: 'person', fact: 'You live in Hangzhou.' }, { channelSession: true })).toMatch(/^Error/);
      expect(JSON.parse(await remember({ action: 'add', scope: 'person', fact: 'You live in Hangzhou.' }))).toMatchObject({ ok: true, scope: 'person' });
      expect(append).not.toHaveBeenCalled();
    } finally { brain.mutateMemory = mutate; append.mockRestore(); }
  });

  it('a full portrait names the entries agents added so the model can merge them', async () => {
    await setSoul(`${'p'.repeat(1950)}\n\n## Recently learned\n\n- You like tea.\n`);
    const r = await remember({ action: 'add', scope: 'person', fact: 'You also like long walks after dinner.' });
    expect(r).toMatch(/^Error: the portrait is full/);
    expect(r).toContain('You like tea.');
    expect(r).toContain('Nothing was written');
  });

  it('supersedes across scopes by moving: write the new sentence, then forget the old entry', async () => {
    const old = JSON.parse(await remember({ action: 'add', fact: 'The user wants to be called Master.' }, {}, 'second'));
    const moved = JSON.parse(await remember({ action: 'update', scope: 'person', id: old.entry.id, expectedVersion: old.version, fact: 'You prefer to be called Lin.' }, {}, 'second'));
    expect(moved).toMatchObject({ ok: true, action: 'update', scope: 'person', entry: { content: 'You prefer to be called Lin.' }, moved: { from: 'agent', id: old.entry.id, content: 'The user wants to be called Master.' } });
    expect(readSoul()).toContain('- You prefer to be called Lin.');
    expect(agentMemory('second').content).toBe('');
    expect((await readHuman({ kind: 'human', file: 'SOUL.md' })).history[0].source).toMatchObject({ kind: 'move', agent: 'second' });
    // 反方向:画像里的一条被推翻、新说法只对这个 Agent 成立
    const listed = JSON.parse(await remember({ action: 'list', fact: null }, {}, 'second'));
    const back = JSON.parse(await remember({ action: 'update', scope: 'agent', id: listed.person.entries[0].id, expectedVersion: listed.person.version, fact: 'In our role-play the user is Captain.' }, {}, 'second'));
    expect(back).toMatchObject({ ok: true, scope: 'agent', moved: { from: 'person', content: 'You prefer to be called Lin.' } });
    expect(readSoul()).not.toContain('Lin');
    expect(agentMemory('second').content).toBe('In our role-play the user is Captain.');
  });

  it('a version copied with a typo after its first 8 characters still moves the entry', async () => {
    const old = JSON.parse(await remember({ action: 'add', fact: 'The user is an early bird.' }));
    const garbled = `${old.version.slice(0, 9)}0000-0000-0000-000000000000`;
    const moved = JSON.parse(await remember({ action: 'update', scope: 'person', id: old.entry.id, expectedVersion: garbled, fact: 'You get up early.' }));
    expect(moved).toMatchObject({ ok: true, scope: 'person', moved: { from: 'agent', id: old.entry.id } });
    expect(readSoul()).toContain('You get up early.');
  });

  it('a move whose old entry cannot be forgotten undoes the new sentence and reports a conflict', async () => {
    const old = JSON.parse(await remember({ action: 'add', fact: 'The user is a night owl.' }));
    // 读的时候版本已经不对:什么都不写
    const stale = await remember({ action: 'update', scope: 'person', id: old.entry.id, expectedVersion: '00000000-0000-4000-8000-000000000000', fact: 'You work late at night.' });
    expect(stale).toMatch(/^Error: expectedVersion is not current\. Nothing was written\./);
    expect(stale).toContain(`keeping scope "person", with expectedVersion ${old.version}`); // 版本过期了也能原样重发,别退回原档
    const noted = JSON.parse(await remember({ action: 'add', scope: 'person', fact: 'You like tea.' }));
    expect(noted.note).toMatch(/your own memory/); // 自己记忆里有东西:提醒拿掉矛盾的旧说法
    await remember({ action: 'forget', scope: 'person', id: noted.entry.id, expectedVersion: noted.version });
    expect(readSoul()).toBe('');
    // 写成画像之后、忘掉旧条目之前记忆被别处改了:撤回画像那一笔
    const brain = deps().brain.memory as any; const real = brain.mutateMemory.bind(brain);
    const spy = vi.spyOn(brain, 'mutateMemory').mockImplementation(async (u: any, m: any) => { if (m.action === 'forget') throw Object.assign(new Error('Memory changed since it was read'), { code: 'MEMORY_VERSION_CONFLICT' }); return real(u, m); });
    try {
      const r = await remember({ action: 'update', scope: 'person', id: old.entry.id, expectedVersion: old.version, fact: 'You work late at night.' });
      expect(r).toMatch(/^Error: scope "agent" changed while the entry was being moved.*Nothing was changed/);
    } finally { spy.mockRestore(); }
    expect(readSoul()).toBe('');
    expect(agentMemory().content).toContain('The user is a night owl.');
  });
});

describe('portrait routes', () => {
  it('lists and forgets portrait entries on the host only, and refuses remote callers', async () => {
    const added = await mutatePortrait({ action: 'add', fact: 'You like tea.', actor: 'agent', source: { kind: 'remember', agent: 'first' } });
    const got = await api('/agent/human/SOUL.md/entries');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ entries: [{ id: added.entry!.id, content: 'You like tea.' }], limit: 2000 });
    expect((await api('/agent/human/SOUL.md/entries', 'GET', undefined, { 'x-forsion-remote': 'tunnel' })).status).toBe(403);
    expect((await api('/agent/human/SOUL.md/entries', 'POST', { action: 'forget', id: added.entry!.id, expectedVersion: got.body.version }, { 'x-forsion-remote': 'tunnel' })).status).toBe(403);
    expect((await api('/agent/human/SOUL.md/entries', 'POST', { action: 'forget', id: added.entry!.id })).status).toBe(428);
    expect((await api('/agent/human/SOUL.md/entries', 'POST', { action: 'forget', id: added.entry!.id, expectedVersion: 'aaaaaaaaaaaa' })).status).toBe(409);
    const forgot = await api('/agent/human/SOUL.md/entries', 'POST', { action: 'forget', id: added.entry!.id, expectedVersion: got.body.version });
    expect(forgot.status).toBe(200);
    expect(forgot.body.entries).toEqual([]);
    expect((await readHuman({ kind: 'human', file: 'SOUL.md' })).history[0]).toMatchObject({ actor: 'user', source: { kind: 'user', action: 'forget' } });
    const back = await api('/agent/human/SOUL.md/entries', 'POST', { action: 'add', fact: 'You like tea.', expectedVersion: forgot.body.version });
    expect(back.body.entry).toEqual({ id: added.entry!.id, content: 'You like tea.' });
  });

  it('promotes one memory entry into human/AGENT.md, then forgets it; a stale version moves nothing', async () => {
    const r = JSON.parse(await remember({ action: 'add', fact: 'Say it when you are not sure instead of guessing.' }));
    expect((await api('/agent/agents/first/memory/promote', 'POST', { id: r.entry.id, expectedVersion: r.version }, { 'x-forsion-remote': 'tunnel' })).status).toBe(403);
    expect((await api('/agent/agents/first/memory/promote', 'POST', { id: r.entry.id, expectedVersion: 'stale' })).status).toBe(409);
    expect(agentMemory().content).toContain('Say it when you are not sure');
    const ok = await api('/agent/agents/first/memory/promote', 'POST', { id: r.entry.id, expectedVersion: r.version });
    expect(ok.status).toBe(200);
    expect(readFileSync(join(humanDir(), 'AGENT.md'), 'utf8')).toBe('- Say it when you are not sure instead of guessing.\n');
    expect(ok.body.agentMd.version).toBe((await readHuman({ kind: 'human', file: 'AGENT.md' })).version);
    expect(ok.body.memoryVersion).toBe(agentMemory().version);
    expect(agentMemory().content).not.toContain('Say it when you are not sure');
    expect((await readHuman({ kind: 'human', file: 'AGENT.md' })).history[0]).toMatchObject({ actor: 'user', source: { kind: 'promote', agent: 'first' } });
    expect((await api('/agent/agents/nobody/memory/promote', 'POST', { id: 'x', expectedVersion: 'y' })).status).toBe(404);
  });
});

describe('what the prompt reads about the human', () => {
  it('an untouched USER.md template (new or old) is empty for the prompt, and first contact still recognises both', () => {
    for (const tpl of [USER_MD_TEMPLATE, ...LEGACY_USER_MD_TEMPLATES]) {
      rmSync(join(humanDir(), 'MEMORY.md'), { force: true }); writeFileSync(userMdFile(), tpl);
      expect(readUserMdForPrompt()).toBe('');
      expect(renderAboutHuman()).not.toContain('What they wrote about themselves');
      expect(joinFirstContact(tpl, 'Real notes.')).toBe('Real notes.');
    }
    expect(USER_MD_TEMPLATE).not.toContain('Agents may also add');
    writeFileSync(userMdFile(), 'Lin keeps her own notes.');
    expect(readUserMdForPrompt()).toBe('Lin keeps her own notes.');
  });

  it('a session connected to a chat channel gets only AGENT.md, without the human\'s notes or the portrait', async () => {
    writeFileSync(join(humanDir(), 'AGENT.md'), 'Lead with the answer.');
    writeFileSync(join(humanDir(), 'MEMORY.md'), 'Lin keeps her own notes.');
    await setSoul('- You like tea.\n');
    const full = renderAboutHuman();
    expect(full).toContain('Lin keeps her own notes.'); expect(full).toContain('You like tea.');
    const shared = renderAboutHuman({ private: false });
    expect(shared).toContain('Lead with the answer.');
    expect(shared).not.toContain('Lin keeps her own notes.'); expect(shared).not.toContain('You like tea.');
  });
});

describe('merging the portrait from two devices', () => {
  const base = '# Lin\n\nShe wrote this.\n\n## Recently learned\n\n- one\n- two\n';
  it('both devices added an entry: both stay, no conflict copy', () => {
    const r = mergePortrait(`${base}- three\n`, base, `${base}- four\n`);
    expect(r).toEqual({ content: `${base}- four\n- three\n`, conflict: false });
  });
  it('one device deleted an entry while the other added one', () => {
    const ours = base.replace('- one\n', '');
    const r = mergePortrait(ours, base, `${base}- four\n`);
    expect(r.conflict).toBe(false);
    expect(portraitEntries(r.content).map((e) => e.content)).toEqual(['two', 'four']);
  });
  it('both devices changed the same paragraph: cloud text wins and the local copy is kept as a conflict copy', () => {
    const r = mergePortrait(base.replace('She wrote this.', 'She wrote this, locally.'), base, base.replace('She wrote this.', 'She wrote this, elsewhere.'));
    expect(r.conflict).toBe(true);
    expect(r.content).toContain('She wrote this, elsewhere.');
  });
});
