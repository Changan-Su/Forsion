// 记忆分层第二步(11-09):Agent 记忆的整理是跨文件的一个事务(断了接着做、整次撤销)、画像整理只挪不改、图钉、
// 无基线并集不复活、后台整理的闸、召回的用量计数。台架在 scripts/lib/tiers-live.mjs(真模型)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
vi.mock('../src/services/specialAgentsConfig.js', async (original) => ({ ...(await original<object>()), resolveBackgroundModelId: async () => bgModel.id }));
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { readHuman, writeHuman } from '../src/agents/humanStore.js';
import { mutatePortrait, portraitEntryId } from '../src/agents/humanPortrait.js';
import { applyPortraitOrganize, OrganizeRejected, pinPortraitEntry, portraitOrganizeHistory, undoPortraitOrganize } from '../src/agents/portraitLayers.js';
import { applyAgentOrganize, agentOrganizeHistory, crashOrganizeAfterForTests, detailEntryId, pinAgentEntry, readAgentLayers, undoAgentOrganize } from '../src/services/agentMemoryLayers.js';
import { resetMemoryOrganizeForTests, runOrganize, validateOrganizePlan, type OrganizeItem } from '../src/services/memoryOrganize.js';
import { flushMemoryUseForTests, noteMemoryUse, readMemoryUse } from '../src/services/memoryUsage.js';
import { createMemoryRepository } from '../src/services/memoryRepository.js';
import { normalizeMemoryFact } from '../src/contracts/entryMark.js';
import { portraitResidentChars, portraitResidentText, splitPortrait } from '../src/contracts/memoryLayers.js';

const bgModel = vi.hoisted(() => ({ id: 'bg' }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let home: string, oldHome: string | undefined, db: { close(): void };
let answer: (input: any) => unknown;
const SOUL = { kind: 'human' as const, file: 'SOUL.md' as const };
const base = () => join(home, 'agents', 'aria');
const repo = () => createMemoryRepository(base());
const memoryFile = () => readFileSync(join(base(), 'MEMORY.md'), 'utf8');
const topicFile = (key: string) => join(base(), 'Library', 'memory', `${key}.md`);
const id = (fact: string) => normalizeMemoryFact(fact);
const CAT = '用户养了一只叫团子的猫。', TRIP = '用户 11 月 2 日去了杭州。', NAME = '用户希望被叫夏夏。', RUN = '用户每周二晚上跑步。';
const LIFE = { key: 'life', title: '日常', about: '宠物、运动与日常生活的细节' };
const organize = (moves: Array<[string, string]>) => {
  const l = readAgentLayers(base());
  const pick = (fact: string) => l.resident.find((r) => r.identity === id(fact))!;
  return applyAgentOrganize(base(), { expectedVersion: l.version, topics: [LIFE], before: { count: l.resident.length, chars: l.residentChars },
    moves: moves.map(([fact, to]) => ({ identity: id(fact), raw: pick(fact).entry.content, to, by: pick(fact).by })) });
};
const setSoul = async (content: string) => writeHuman(SOUL, { content, summary: 'seed', expectedVersion: (await readHuman(SOUL)).version }, 'user');

beforeEach(async () => {
  oldHome = process.env.TANGU_HOME;
  home = mkdtempSync(join(tmpdir(), 'tangu-memory-layers-'));
  process.env.TANGU_HOME = home;
  bgModel.id = 'bg'; answer = () => ({ keep: [] });
  const sqlite = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
  db = sqlite.db;
  configureTangu({ host: sqlite.host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: { calculateCost: async () => 0, logApiUsage: async () => {} } as any, brain: {
    memory: createLocalMemoryBrain({ deviceId: 'test', deviceName: null }),
    llm: {
      resolveModelAndKey: async () => ({ model: { name: 't', provider: 't' }, apiKey: 'x', baseUrl: '', apiModelId: 't' }),
      buildProviderPayload: async (p: any) => p,
      streamProviderCompletion: async (p: any) => ({ content: JSON.stringify(answer(JSON.parse(p.payload.messages[1].content))), finishReason: 'stop', usage: {} }),
    } } as any });
  await saveAgent({ slug: 'aria', name: 'Aria', systemPrompt: 'x' } as any, true);
  repo().mutate({ action: 'add', fact: NAME, source: { kind: 'manual' } });
  for (const f of [CAT, TRIP, RUN]) repo().add(f);
});
afterEach(() => {
  crashOrganizeAfterForTests(null); resetMemoryOrganizeForTests();
  db.close();
  if (oldHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Agent memory: organize is one transaction across files (R3)', () => {
  it('writes the details first (verbatim, author marked), then takes them out of resident; one record undoes it all', () => {
    const r = organize([[CAT, 'life'], [RUN, 'life'], [TRIP, 'archive']]);
    expect(readFileSync(topicFile('life'), 'utf8')).toBe(`# 日常\n\n宠物、运动与日常生活的细节\n\n- ${CAT} <!--tg by=agent-->\n- ${RUN} <!--tg by=agent-->\n`);
    expect(readFileSync(topicFile('archive'), 'utf8')).toContain(`- ${TRIP} <!--tg by=agent-->`);
    expect(memoryFile()).not.toContain(CAT); expect(memoryFile()).toContain(NAME);
    const l = readAgentLayers(base());
    expect(l.topics.map((t) => [t.key, t.entries.map((e) => e.text)])).toEqual([['life', [CAT, RUN]]]);
    expect(l.archive!.entries.map((e) => e.text)).toEqual([TRIP]);
    expect(l.residentChars).toBe(NAME.length);
    expect(agentOrganizeHistory(base()).map((h) => h.id)).toEqual([r.id]);
    const undone = undoAgentOrganize(base(), r.id);
    expect(undone.undoneAt).toBeTruthy(); expect(undone.undoChanged).toEqual([]);
    for (const f of [NAME, CAT, TRIP, RUN]) expect(memoryFile()).toContain(f);
    expect(existsSync(topicFile('life'))).toBe(false); expect(existsSync(topicFile('archive'))).toBe(false);
    expect(undoAgentOrganize(base(), r.id).undoneAt).toBe(undone.undoneAt); // 撤第二次 = 什么都不做
  });
  it.each(['writing', 'committing'] as const)('killed right after %s: the next read finishes it, nothing lost or duplicated', (phase) => {
    crashOrganizeAfterForTests(phase);
    expect(() => organize([[CAT, 'life']])).toThrow(/simulated crash/);
    expect(readFileSync(topicFile('life'), 'utf8')).toContain(CAT); // 详情先写好了
    const l = readAgentLayers(base()); // 读的时候接着做
    expect(memoryFile()).not.toContain(CAT);
    expect(l.topics[0].entries.map((e) => e.text)).toEqual([CAT]);
    expect(l.resident.some((r) => r.identity === id(CAT))).toBe(false);
    expect(agentOrganizeHistory(base())).toHaveLength(1);
  });
  it('killed in the middle of an undo: the next read finishes the undo', () => {
    const r = organize([[CAT, 'life']]);
    crashOrganizeAfterForTests('restoring');
    expect(() => undoAgentOrganize(base(), r.id)).toThrow(/simulated crash/);
    expect(memoryFile()).toContain(CAT); expect(existsSync(topicFile('life'))).toBe(true); // 先放回常驻,详情里那份还在
    const l = readAgentLayers(base());
    expect(existsSync(topicFile('life'))).toBe(false);
    expect(l.resident.filter((x) => x.identity === id(CAT))).toHaveLength(1);
    expect(agentOrganizeHistory(base())[0].undoneAt).toBeTruthy();
  });
  it('undo after someone removed an entry from the topic file: that one is not revived, the change is reported', () => {
    const r = organize([[CAT, 'life'], [RUN, 'life']]);
    writeFileSync(topicFile('life'), `# 日常\n\n宠物、运动与日常生活的细节\n\n- ${RUN} <!--tg by=agent-->\n`);
    const undone = undoAgentOrganize(base(), r.id);
    expect(undone.undoChanged).toEqual(['life']);
    expect(memoryFile()).toContain(RUN); expect(memoryFile()).not.toContain(CAT);
  });
  it('an unreadable organize record stops writes instead of being treated as "nothing pending"', () => {
    writeFileSync(join(base(), '.memory-organize.json'), '{broken');
    expect(() => organize([[CAT, 'life']])).toThrow(/unreadable/);
    expect(memoryFile()).toContain(CAT);
  });
});

describe('Agent memory: where an entry is comes from the content (R1, R8)', () => {
  it('a first-contact union that puts a moved line back into MEMORY.md does not revive it: the detail copy wins', () => {
    organize([[CAT, 'life']]);
    repo().add(CAT); // 另一台还没整理过,无基线并集把常驻那份带了回来
    const l = readAgentLayers(base());
    expect(l.resident.find((r) => r.identity === id(CAT))!.shadowed).toBe(true);
    expect(l.residentChars).not.toBeGreaterThan(readAgentLayers(base()).resident.filter((r) => !r.shadowed).map((r) => r.text).join('\n').length);
    expect(l.topics[0].entries.map((e) => e.text)).toEqual([CAT]);
  });
  it('the same entry moved into two topics on two devices settles into one (smallest key) everywhere', () => {
    organize([[CAT, 'life']]);
    mkdirSync(join(base(), 'Library', 'memory'), { recursive: true });
    writeFileSync(topicFile('family'), `# 家人\n\n家人和宠物\n\n- ${CAT} <!--tg by=agent-->\n`);
    const l = readAgentLayers(base());
    expect(l.topics.map((t) => [t.key, t.entries.length])).toEqual([['family', 1]]);
  });
  it('pins: a pinned resident entry stays even if a topic copy shows up; pinning a detail entry brings it back resident', () => {
    const cat = repo().snapshot().entries.find((e) => e.content.includes(CAT))!;
    pinAgentEntry(base(), { id: cat.id, pinned: true });
    expect(memoryFile()).toContain(`${CAT} <!--tg pin by=agent-->`);
    mkdirSync(join(base(), 'Library', 'memory'), { recursive: true });
    writeFileSync(topicFile('life'), `# 日常\n\n宠物、运动与日常生活的细节\n\n- ${CAT} <!--tg by=agent-->\n- ${RUN} <!--tg by=agent-->\n`);
    let l = readAgentLayers(base());
    expect(l.resident.find((r) => r.identity === id(CAT))).toMatchObject({ pinned: true, shadowed: false });
    expect(l.topics[0].entries.map((e) => e.text)).toEqual([RUN]);
    pinAgentEntry(base(), { id: detailEntryId(id(RUN)), pinned: true });
    l = readAgentLayers(base());
    expect(l.resident.filter((r) => r.identity === id(RUN))).toMatchObject([{ pinned: true, shadowed: false }]);
    expect(l.topics).toEqual([]);
    // 人写的那条(界面上手写)钉住时记号写明是人写的,挪进详情也认得出
    const name = repo().snapshot().entries.find((e) => e.content.includes(NAME))!;
    pinAgentEntry(base(), { id: name.id, pinned: true });
    expect(memoryFile()).toContain(`${NAME} <!--tg pin by=user-->`);
  });
});

describe('portrait: organize only moves, never rewrites (R2, R3)', () => {
  const ORIGINAL = `# 林夏\n\n- 你叫林夏。\n- 你每周六上午学钢琴。\n\n## 最近认识的\n\n- 你养了一只猫。\n\n## 从其他 AI 导入 · 11-03\n\n- 你在读博。 <!--tg by=import from=2026-11-03-->\n`;
  const topics = [{ key: 'life', title: '日常与爱好', about: '兴趣、宠物与周末安排' }, { key: 'study', title: '学习', about: '学业、课程和研究方向' }];
  const moves = [{ identity: id('你每周六上午学钢琴。'), to: 'life' }, { identity: id('你养了一只猫。'), to: 'life' }, { identity: id('你在读博。'), to: 'study' }];
  it('human-written, agent-written and imported entries move verbatim with who wrote them; one record undoes it', async () => {
    await setSoul(ORIGINAL);
    const r = await applyPortraitOrganize({ expectedVersion: (await readHuman(SOUL)).version, moves, topics });
    const doc = await readHuman(SOUL);
    const t = Object.fromEntries(splitPortrait(doc.content).topics.map((x) => [x.key, x.entries.map((e) => e.raw)]));
    expect(t).toEqual({ life: ['- 你每周六上午学钢琴。 <!--tg by=user-->', '- 你养了一只猫。 <!--tg by=agent-->'], study: ['- 你在读博。 <!--tg by=import from=2026-11-03-->'] });
    expect(portraitResidentText(doc.content)).toBe('# 林夏\n\n- 你叫林夏。');
    expect((await portraitOrganizeHistory()).map((h) => h.id)).toEqual([r.id]);
    await undoPortraitOrganize(r.id);
    expect((await readHuman(SOUL)).content).toBe(ORIGINAL);
    expect((await portraitOrganizeHistory())[0].undoneAt).toBeTruthy();
  });
  it('a pinned entry is never moved; if the result would still be over 70% of the limit nothing is written', async () => {
    await setSoul(ORIGINAL.replace('- 你养了一只猫。', '- 你养了一只猫。 <!--tg pin-->'));
    await applyPortraitOrganize({ expectedVersion: (await readHuman(SOUL)).version, moves, topics });
    expect(portraitResidentText((await readHuman(SOUL)).content)).toContain('你养了一只猫。');
    await setSoul(`${'人自己写的一段话。'.repeat(170)}\n\n${ORIGINAL}`);
    const before = await readHuman(SOUL);
    await expect(applyPortraitOrganize({ expectedVersion: before.version, moves, topics })).rejects.toBeInstanceOf(OrganizeRejected);
    expect((await readHuman(SOUL)).version).toBe(before.version);
  });
  it('pinning a detail entry brings it back resident, pinned, in its own place', async () => {
    await setSoul(ORIGINAL);
    await applyPortraitOrganize({ expectedVersion: (await readHuman(SOUL)).version, moves, topics });
    const doc = await readHuman(SOUL);
    await pinPortraitEntry({ id: portraitEntryId('你养了一只猫。'), pinned: true, expectedVersion: doc.version });
    const after = (await readHuman(SOUL)).content;
    expect(portraitResidentText(after)).toContain('## 最近认识的\n\n- 你养了一只猫。');
    expect(after).toContain('你养了一只猫。 <!--tg pin by=agent-->');
    expect(splitPortrait(after).topics.find((x) => x.key === 'life')!.entries.map((e) => e.text)).toEqual(['你每周六上午学钢琴。']);
  });
  it('an agent write past the limit still lands when a background model is set (front-end writes always succeed); without one it is refused as before', async () => {
    await setSoul(`- ${'你在很多方面都有很具体的习惯。'.repeat(140)}\n`);
    expect(portraitResidentChars((await readHuman(SOUL)).content)).toBeGreaterThan(2000);
    await mutatePortrait({ action: 'add', fact: '你喜欢喝茶。', actor: 'agent', source: { kind: 'agent', agent: 'aria' } as any });
    expect((await readHuman(SOUL)).content).toContain('你喜欢喝茶。');
    bgModel.id = '';
    await expect(mutatePortrait({ action: 'add', fact: '你喜欢爬山。', actor: 'agent', source: { kind: 'agent', agent: 'aria' } as any })).rejects.toMatchObject({ code: 'PORTRAIT_FULL' });
  });
});

describe('background organize (R7)', () => {
  const item = (over: Partial<OrganizeItem>): OrganizeItem => ({ id: 'e1', text: 'x', by: 'agent', pinned: false, uses30: 0, lastUsed: null, ...over });
  it('the gate: pinned stays, only agent-written can be archived, an id named twice is dropped, a topic needs a real description', () => {
    const items = [item({ id: 'e1', pinned: true }), item({ id: 'e2', by: 'user' }), item({ id: 'e3' }), item({ id: 'e4' }), item({ id: 'e5', by: 'import' })];
    const plan = validateOrganizePlan({
      keep: ['e4'], move: [{ id: 'e1', topic: 'life' }, { id: 'e4', topic: 'life' }, { id: 'e5', topic: 'life' }, { id: 'e3', topic: 'bad' }],
      archive: ['e2', 'e3'],
      topics: [{ key: 'life', title: '日常', about: '宠物与日常生活的细节' }, { key: 'bad', title: '杂项', about: '杂项' }],
    }, items, []);
    expect(plan.moves).toEqual([{ id: 'e5', topic: 'life' }]);
    expect(plan.topics.map((t) => t.key)).toEqual(['life']);
    expect(plan.ignored.join('\n')).toMatch(/only entries an agent wrote/);
  });
  it('runs on the background model, moves until resident is low enough, and refuses a plan that leaves too much resident', async () => {
    for (let i = 0; i < 40; i++) repo().add(`用户的第 ${i + 1} 条生活细节:这是一句故意写长一些的话,用来占掉常驻的字数,让整理有事可做;再多写几个字,让四十条加起来明显超过四千字的常驻上限。`);
    answer = (input) => ({ move: input.entries.filter((e: any) => e.text.includes('生活细节')).slice(0, 2).map((e: any) => ({ id: e.id, topic: 'life' })), topics: [LIFE] });
    const before = memoryFile();
    expect(await runOrganize({ kind: 'agent', slug: 'aria' }, { userId: 'u', manual: true })).toMatchObject({ status: 'skipped', reason: 'rejected' });
    expect(memoryFile()).toBe(before);
    answer = (input) => ({ move: input.entries.filter((e: any) => e.text.includes('生活细节')).map((e: any) => ({ id: e.id, topic: 'life' })), keep: [], topics: [LIFE] });
    const out: any = await runOrganize({ kind: 'agent', slug: 'aria' }, { userId: 'u', manual: true });
    expect(out).toMatchObject({ status: 'organized', moved: 40 });
    expect(out.after.chars).toBeLessThanOrEqual(2800);
    expect(readAgentLayers(base()).topics[0].entries).toHaveLength(40);
    bgModel.id = '';
    expect(await runOrganize({ kind: 'agent', slug: 'aria' }, { userId: 'u', manual: true })).toMatchObject({ status: 'skipped', reason: 'no_model' });
  });
});

describe('usage counts (R6)', () => {
  it('counts per entry identity for 30 days, marks ignored', async () => {
    noteMemoryUse(base(), '.memory-usage.json', [CAT, `- ${CAT} <!--tg by=agent-->`, RUN]);
    noteMemoryUse(base(), '.memory-usage.json', [CAT]);
    await flushMemoryUseForTests();
    const use = readMemoryUse(base(), '.memory-usage.json');
    expect(use(CAT).uses30).toBe(2); // 同一次(一轮召回)里同一条只算一次 expect(use(RUN).uses30).toBe(1); expect(use(NAME)).toEqual({ uses30: 0, lastUsed: null });
    expect(readFileSync(join(base(), '.memory-usage.json'), 'utf8')).not.toContain('团子'); // 只存身份的哈希
  });
});
