// 搬家(画像写入第 2 步):人点了才扫;先写画像再忘原条目,任何一步断了下次接着做,绝不两边都没有;读不到 ≠ 空;人动过的不覆盖。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
vi.mock('../src/services/specialAgentsConfig.js', async (original) => ({ ...(await original<object>()), resolveBackgroundModelId: async () => bgModel.id }));
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { readHuman, writeHuman } from '../src/agents/humanStore.js';
import { isPortraitFactForgotten, mutatePortrait, portraitEntryId } from '../src/agents/humanPortrait.js';
import { createMemoryRepository } from '../src/services/memoryRepository.js';
import { keepPortraitItem, movePortraitItem, readPortraitMove, startPortraitScan, undoPortraitMove } from '../src/agents/portraitMove.js';

const bgModel = vi.hoisted(() => ({ id: 'bg' }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const NAME = '用户希望被称呼为「阿青」。', ASK = '改完代码先自己跑一遍再报结果。', FACT = '你希望别人叫你阿青。';
let home: string, oldHome: string | undefined, db: { close(): void };
let answer: (entries: Array<{ id: string; content: string }>) => unknown, calls: number;
const repo = (slug = 'nori') => createMemoryRepository(join(home, 'agents', slug));
const soul = async () => (await readHuman({ kind: 'human', file: 'SOUL.md' })).content;
const moveFile = () => join(home, 'human-history', 'portrait-move.json');
const picksOf = (hit: Record<string, string>) => (entries: Array<{ id: string; content: string }>) => ({ picks: entries.filter((e) => hit[e.content]).map((e) => ({ id: e.id, fact: hit[e.content] })) });
const scanned = async () => {
  startPortraitScan('owner');
  for (;;) { const v = await readPortraitMove('owner'); if (!v.scanning) return v; await new Promise((r) => setTimeout(r, 5)); }
};
/** 上一次在 step 那一步断掉:记录文件照那个时刻写好,再走一次打开卡片。 */
const seedMoving = (fact = FACT, content = NAME) => {
  mkdirSync(join(home, 'human-history'), { recursive: true });
  writeFileSync(moveFile(), JSON.stringify({ schemaVersion: 1, kept: [], items: [{ id: 'i1', memorySlug: 'nori', agents: ['nori'], content, fact, state: 'moving' }] }));
};

beforeEach(async () => {
  oldHome = process.env.TANGU_HOME;
  home = mkdtempSync(join(tmpdir(), 'tangu-portrait-move-'));
  process.env.TANGU_HOME = home;
  calls = 0; bgModel.id = 'bg'; answer = picksOf({ [NAME]: FACT });
  const sqlite = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
  db = sqlite.db;
  configureTangu({ host: sqlite.host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: { calculateCost: async () => 0, logApiUsage: async () => {} } as any, brain: { llm: {
    resolveModelAndKey: async () => ({ model: { name: 't', provider: 't' }, apiKey: 'x', baseUrl: '', apiModelId: 't' }),
    buildProviderPayload: async (p: any) => p,
    streamProviderCompletion: async (p: any) => { calls++; const r = answer(JSON.parse(p.payload.messages[1].content)); if (r instanceof Error) throw r; return { content: JSON.stringify(r), finishReason: 'stop', usage: {} }; },
  } } as any });
  await saveAgent({ slug: 'nori', name: 'Nori', systemPrompt: 'x' } as any, true);
  repo().add(NAME); repo().add(ASK);
});
afterEach(() => {
  db.close();
  if (oldHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

describe('scan', () => {
  it('does nothing until asked, then lists only what the model picked', async () => {
    expect((await readPortraitMove('owner')).items).toEqual([]);
    expect(calls).toBe(0);
    const v = await scanned();
    expect(v.items.map((i) => [i.memorySlug, i.content, i.fact, i.state])).toEqual([['nori', NAME, FACT, 'pending']]);
    expect(repo().snapshot().content).toContain(NAME); // 扫不动记忆
    expect(await soul()).toBe('');
  });
  it('agents sharing the default memory collapse into one reading', async () => {
    await saveAgent({ slug: 'mira', name: 'Mira', systemPrompt: 'x', shareDefaultMemory: true } as any, true);
    await saveAgent({ slug: 'kai', name: 'Kai', systemPrompt: 'x', shareDefaultMemory: true } as any, true);
    repo('xyra').add(NAME);
    const v = await scanned();
    const shared = v.items.find((i) => i.memorySlug === 'xyra')!;
    expect(shared.agents).toEqual(expect.arrayContaining(['mira', 'kai']));
    expect(v.items.filter((i) => i.memorySlug === 'xyra')).toHaveLength(1);
  });
  it('an unreadable memory is reported, not treated as empty, and nothing is written for it', async () => {
    writeFileSync(join(home, 'agents', 'nori', '.memory-state.json'), '{ broken');
    const before = readFileSync(join(home, 'agents', 'nori', '.memory-state.json'), 'utf8');
    const v = await scanned();
    expect(v.missed).toEqual(['nori']);
    expect(v.items).toEqual([]);
    expect(readFileSync(join(home, 'agents', 'nori', '.memory-state.json'), 'utf8')).toBe(before);
  });
  it('a model failure on one memory leaves it for next time', async () => {
    answer = () => new Error('boom');
    expect((await scanned()).missed).toEqual(expect.arrayContaining(['nori']));
    answer = picksOf({ [NAME]: FACT });
    expect((await scanned()).items).toHaveLength(1);
  });
  it('no background model: says so and touches nothing', async () => {
    bgModel.id = '';
    const v = await scanned();
    expect(v.scanError).toBe('PORTRAIT_MOVE_NO_MODEL');
    expect(v.items).toEqual([]);
  });
  it('rejects picks with an id it never sent or a sentence over the limit', async () => {
    answer = () => ({ picks: [{ id: 'nope', fact: FACT }, { id: 'e1', fact: 'x'.repeat(301) }] });
    expect((await scanned()).items).toEqual([]);
  });
  it('a sentence the user deleted from the portrait is not offered again', async () => {
    await mutatePortrait({ action: 'add', fact: FACT, actor: 'user', source: { kind: 'user' } });
    await mutatePortrait({ action: 'forget', id: portraitEntryId(FACT), actor: 'user', source: { kind: 'user' } });
    expect(isPortraitFactForgotten(FACT)).toBe(true);
    expect((await scanned()).items).toEqual([]);
  });
  it('a pending entry changed in memory leaves the card; a new one still shows up on the next scan', async () => {
    await scanned();
    const s = repo().snapshot();
    repo().update(s.entries.find((e) => e.content === NAME)!.id, '用户希望被称呼为「小青」。');
    expect((await readPortraitMove('owner')).items).toEqual([]);
    repo().add('用户在学线性代数。');
    answer = picksOf({ '用户在学线性代数。': '你在学线性代数。' });
    expect((await scanned()).items.map((i) => i.fact)).toEqual(['你在学线性代数。']);
  });
});

describe('deciding', () => {
  it('move: the sentence reaches the portrait, the original leaves memory, the history says where from', async () => {
    const [item] = (await scanned()).items;
    const v = await movePortraitItem('owner', item.id);
    expect(v.items[0].state).toBe('moved');
    expect(await soul()).toContain(FACT);
    expect(repo().snapshot().content).not.toContain(NAME);
    expect(repo().snapshot().content).toContain(ASK);
    const doc = await readHuman({ kind: 'human', file: 'SOUL.md' });
    expect(doc.history[0].source).toMatchObject({ kind: 'move', agent: 'nori' });
  });
  it('keep: the entry stays, and later scans never mention it', async () => {
    const [item] = (await scanned()).items;
    await keepPortraitItem('owner', item.id);
    expect(repo().snapshot().content).toContain(NAME);
    expect(await soul()).toBe('');
    expect((await scanned()).items).toEqual([]);
    expect(calls).toBe(2); // 第二次只为别的条目问模型
  });
  it('a pending entry survives a reload (not now = still on the card)', async () => {
    await scanned();
    expect((await readPortraitMove('owner')).items).toHaveLength(1);
  });
  it('move refuses when the entry changed after the scan: nothing is written', async () => {
    const [item] = (await scanned()).items;
    const s = repo().snapshot();
    repo().update(s.entries.find((e) => e.content === NAME)!.id, '用户希望被称呼为「小青」。');
    await expect(movePortraitItem('owner', item.id)).rejects.toMatchObject({ code: 'PORTRAIT_MOVE_GONE' });
    expect(await soul()).toBe('');
    expect(repo().snapshot().content).toContain('小青');
  });
  it('portrait full: memory untouched, the row is still pending', async () => {
    const [item] = (await scanned()).items;
    const doc = await readHuman({ kind: 'human', file: 'SOUL.md' });
    const mine = '人写的段落。'.repeat(400);
    await writeHuman({ kind: 'human', file: 'SOUL.md' }, { content: mine, summary: 'mine', expectedVersion: doc.version }, 'user');
    await expect(movePortraitItem('owner', item.id)).rejects.toMatchObject({ code: 'PORTRAIT_FULL' });
    expect((await readPortraitMove('owner')).items[0].state).toBe('pending');
    expect(repo().snapshot().content).toContain(NAME);
    expect(await soul()).toBe(mine);
  });
  it('the sentence was already in the portrait: only the original goes, and undo keeps the user\'s line', async () => {
    await mutatePortrait({ action: 'add', fact: FACT, actor: 'user', source: { kind: 'user' } });
    const [item] = (await scanned()).items;
    await movePortraitItem('owner', item.id);
    expect((await soul()).split(FACT).length - 1).toBe(1);
    await undoPortraitMove('owner', item.id);
    expect(await soul()).toContain(FACT);
    expect(repo().snapshot().content).toContain(NAME);
  });
  it('undo puts the original back, takes the sentence out, and it counts as kept', async () => {
    const [item] = (await scanned()).items;
    await movePortraitItem('owner', item.id);
    const v = await undoPortraitMove('owner', item.id);
    expect(v.items).toEqual([]);
    expect(await soul()).not.toContain(FACT);
    expect(repo().snapshot().content).toContain(NAME);
    expect((await scanned()).items).toEqual([]);
  });
  it('undo leaves a sentence the user reworded alone', async () => {
    const [item] = (await scanned()).items;
    await movePortraitItem('owner', item.id);
    const doc = await readHuman({ kind: 'human', file: 'SOUL.md' });
    await writeHuman({ kind: 'human', file: 'SOUL.md' }, { content: doc.content.replace(FACT, '叫我阿青就好。'), summary: 'mine', expectedVersion: doc.version }, 'user');
    await undoPortraitMove('owner', item.id);
    expect(await soul()).toContain('叫我阿青就好。');
    expect(repo().snapshot().content).toContain(NAME); // 两边都有:留着比删掉人改过的强
  });
});

describe('Codex review (10-30)', () => {
  it('undo leaves a sentence whose capitalization the user changed', async () => {
    answer = picksOf({ [NAME]: 'You like to be called Qing.' });
    const [item] = (await scanned()).items;
    await movePortraitItem('owner', item.id);
    const doc = await readHuman({ kind: 'human', file: 'SOUL.md' });
    await writeHuman({ kind: 'human', file: 'SOUL.md' }, { content: doc.content.replace('You like to be called Qing.', 'you like to be called qing.'), summary: 'mine', expectedVersion: doc.version }, 'user');
    await undoPortraitMove('owner', item.id);
    expect(await soul()).toContain('you like to be called qing.');
  });
  it('two agents moved the same sentence: undoing one keeps it for the other', async () => {
    await saveAgent({ slug: 'mira', name: 'Mira', systemPrompt: 'x' } as any, true);
    repo('mira').add(NAME);
    const { items } = await scanned();
    expect(items).toHaveLength(2);
    await movePortraitItem('owner', items[0].id); await movePortraitItem('owner', items[1].id);
    await undoPortraitMove('owner', items[0].id);
    expect(await soul()).toContain(FACT);
    expect(repo(items[1].memorySlug).snapshot().content).not.toContain(NAME);
    expect(repo(items[0].memorySlug).snapshot().content).toContain(NAME);
  });
  it('the sentence already sits past what agents read: the original stays', async () => {
    const [item] = (await scanned()).items;
    const doc = await readHuman({ kind: 'human', file: 'SOUL.md' });
    await writeHuman({ kind: 'human', file: 'SOUL.md' }, { content: `${'人写的段落。'.repeat(400)}\n\n- ${FACT}\n`, summary: 'mine', expectedVersion: doc.version }, 'user');
    await expect(movePortraitItem('owner', item.id)).rejects.toMatchObject({ code: 'PORTRAIT_FULL' });
    expect(repo().snapshot().content).toContain(NAME);
    expect((await readPortraitMove('owner')).items[0].state).toBe('pending');
  });
  it('undo that fails on the portrait keeps its record, so it can be retried', async () => {
    const [item] = (await scanned()).items;
    await movePortraitItem('owner', item.id);
    const soulPath = join(home, 'human', 'SOUL.md'); const good = readFileSync(soulPath, 'utf8');
    rmSync(soulPath); mkdirSync(soulPath);
    await expect(undoPortraitMove('owner', item.id)).rejects.toThrow();
    rmSync(soulPath, { recursive: true }); writeFileSync(soulPath, good);
    expect((await readPortraitMove('owner')).items.map((i) => i.state)).toEqual(['moved']);
    await undoPortraitMove('owner', item.id);
    expect(await soul()).not.toContain(FACT);
    expect(repo().snapshot().content.split(NAME).length - 1).toBe(1);
  });
});

describe('picking up an interrupted move (read portrait × read memory)', () => {
  it('written, original still there: finishes the forget', async () => {
    await mutatePortrait({ action: 'add', fact: FACT, actor: 'agent', source: { kind: 'move', agent: 'nori' } });
    seedMoving();
    const v = await readPortraitMove('owner');
    expect(v.items[0].state).toBe('moved');
    expect(repo().snapshot().content).not.toContain(NAME);
  });
  it('written, original gone: marks it done', async () => {
    await mutatePortrait({ action: 'add', fact: FACT, actor: 'agent', source: { kind: 'move', agent: 'nori' } });
    const s = repo().snapshot();
    repo().forget(s.entries.find((e) => e.content === NAME)!.id);
    seedMoving();
    expect((await readPortraitMove('owner')).items[0].state).toBe('moved');
  });
  it('not written, original there: back to pending, never deleted', async () => {
    seedMoving();
    const v = await readPortraitMove('owner');
    expect(v.items[0].state).toBe('pending');
    expect(repo().snapshot().content).toContain(NAME);
    expect(await soul()).toBe('');
  });
  it('not written, original gone: nothing to do, the row goes', async () => {
    const s = repo().snapshot();
    repo().forget(s.entries.find((e) => e.content === NAME)!.id);
    seedMoving();
    expect((await readPortraitMove('owner')).items).toEqual([]);
  });
  it('memory unreadable: the record is left exactly as it was', async () => {
    await mutatePortrait({ action: 'add', fact: FACT, actor: 'agent', source: { kind: 'move', agent: 'nori' } });
    seedMoving();
    const record = readFileSync(moveFile(), 'utf8');
    const state = join(home, 'agents', 'nori', '.memory-state.json');
    const good = readFileSync(state, 'utf8');
    writeFileSync(state, '{ broken');
    expect((await readPortraitMove('owner')).items[0].state).toBe('moving');
    expect(readFileSync(moveFile(), 'utf8')).toBe(record);
    writeFileSync(state, good); // 读得到了就接着做
    expect((await readPortraitMove('owner')).items[0].state).toBe('moved');
    expect(repo().snapshot().content).not.toContain(NAME);
  });
  it('forget fails after the portrait write: stays "moving", both sides keep it, next open finishes', async () => {
    const [item] = (await scanned()).items;
    const state = join(home, 'agents', 'nori', '.memory-state.json');
    const good = readFileSync(state, 'utf8');
    writeFileSync(state, '{ broken');
    await expect(movePortraitItem('owner', item.id)).rejects.toThrow();
    expect(await soul()).toContain(FACT);
    writeFileSync(state, good);
    expect(JSON.parse(readFileSync(moveFile(), 'utf8')).items[0].state).toBe('moving');
    expect((await readPortraitMove('owner')).items[0].state).toBe('moved');
    expect(repo().snapshot().content).not.toContain(NAME);
  });
  it('an unreadable record file is an error, never an empty list written back', async () => {
    await scanned();
    writeFileSync(moveFile(), 'not json');
    await expect(readPortraitMove('owner')).rejects.toMatchObject({ code: 'PORTRAIT_MOVE_UNREADABLE' });
    expect(() => startPortraitScan('owner')).toThrow();
    expect(readFileSync(moveFile(), 'utf8')).toBe('not json');
  });
});

describe('agent removed after the scan', () => {
  it('a pending row goes, without creating the folder again', async () => {
    await scanned();
    rmSync(join(home, 'agents', 'nori'), { recursive: true });
    expect((await readPortraitMove('owner')).items).toEqual([]);
    expect(existsSync(join(home, 'agents', 'nori'))).toBe(false);
  });
});
