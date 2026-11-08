/**
 * Muse Space 两份布局文件的 IO(services/museSpace.ts;纯规则在 contracts/museSpace.test.ts)。真文件系统 + 临时 TANGU_HOME。
 *   没有 → null / 空摆放,不算问题;坏 JSON / 软链 → 用最后一份有效的 + 一条问题,坏文件一个字节都不动,也拒写;
 *   expectedRev 对不上 → 回最新;接受 / 拒绝提议 → 同一把锁里把提议从卜算子那份摘掉(那份 rev + 1);摆放 rev + 1 落盘;
 *   「备好的」只列 Library 里还在的、按修改时间新 → 旧,软链指出去的不算;停用时 stoppedAt = 那句话的时刻。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/services/museSpace.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMusePlacement, emptyMuseDoc, museLibraryDir, musePlacementFile, museSpaceDocFile, museSpaceDir, museSpaceView, readMuseSpaceState, updateMuseDoc } from './museSpace.js';
import { saveSpecialAgentsConfig } from './specialAgentsConfig.js';
import type { MuseSpaceDoc } from '../contracts/museSpace.js';

let home: string;
const prevHome = process.env.TANGU_HOME;
const NOW = Date.parse('2026-11-08T12:00:00Z');

const writeRaw = (file: string, text: string): void => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const docOf = (over: Partial<MuseSpaceDoc> = {}): MuseSpaceDoc => ({ ...emptyMuseDoc(), rev: 1, ...over });
const setDoc = async (over: Partial<MuseSpaceDoc>, expectedRev = 0): Promise<MuseSpaceDoc> => {
  const r = await updateMuseDoc(expectedRev, (s) => ({ ok: true, doc: { ...(s.doc ?? emptyMuseDoc()), ...over } }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.doc;
};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-muse-space-'));
  process.env.TANGU_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(home, 'agents'), { recursive: true, force: true });
  rmSync(join(home, 'ui'), { recursive: true, force: true });
  saveSpecialAgentsConfig({ muse: { enabled: true } } as any);
});

describe('读', () => {
  it('两份都没有:hasDoc false、空摆放、缺省三张、没有问题', async () => {
    const v = await museSpaceView();
    expect(v).toMatchObject({ enabled: true, hasDoc: false, hero: null, prepared: [], proposed: [], problems: [], rev: { doc: 0, placement: 0 }, stoppedAt: null });
    expect(v.cards.map((c) => c.key)).toEqual(['todos', 'today', 'tracking']);
    expect(v.libraryRoot).toBe(museLibraryDir());
  });

  it('卜算子那份坏了:用最后一份有效的 + 一条问题;坏文件一个字节都不动;它的 update 拒写并交回最后一份有效的', async () => {
    await setDoc({ hero: { text: 'first', at: new Date(NOW).toISOString() } });
    expect(existsSync(join(home, 'ui', 'muse-space.doc.good.json'))).toBe(true);
    const bad = Buffer.from('{"schemaVersion": 1, "hero": oops');
    writeFileSync(museSpaceDocFile(), bad);
    const v = await museSpaceView();
    expect(v.hasDoc).toBe(true);
    expect(v.hero?.text).toBe('first');
    expect(v.problems).toEqual([{ file: 'space', message: expect.stringContaining('not valid JSON') }]);
    const r = await updateMuseDoc(1, () => ({ ok: true, doc: docOf({ hero: { text: 'second', at: new Date(NOW).toISOString() } }) }));
    expect(r).toMatchObject({ ok: false, reason: 'unreadable', lastGood: { hero: { text: 'first' } } });
    expect(readFileSync(museSpaceDocFile()).equals(bad)).toBe(true);
  });

  it('结构不对(schemaVersion 错)也算读坏;没有最后一份有效的 → hasDoc false + 问题,不当空、不重写', async () => {
    writeRaw(museSpaceDocFile(), '{"schemaVersion": 9}');
    const v = await museSpaceView();
    expect(v.hasDoc).toBe(false);
    expect(v.problems[0]).toMatchObject({ file: 'space' });
    expect(readFileSync(museSpaceDocFile(), 'utf8')).toBe('{"schemaVersion": 9}');
  });

  it('space.json 是软链:当读坏(不跟过去读)', async () => {
    const outside = join(home, 'outside.json');
    writeFileSync(outside, JSON.stringify(docOf({ hero: { text: 'from outside', at: new Date(NOW).toISOString() } })));
    mkdirSync(museSpaceDir(), { recursive: true });
    symlinkSync(outside, museSpaceDocFile());
    const v = await museSpaceView();
    expect(v.hero).toBeNull();
    expect(v.problems[0]).toMatchObject({ file: 'space' });
  });

  it('你的摆放坏了:用最后一份有效的 + 问题;摆放操作拒写(409 那条),坏文件不动', async () => {
    const ok = await applyMusePlacement(0, { type: 'hide', key: 'tracking' });
    expect(ok.ok).toBe(true);
    const bad = Buffer.from('not json');
    writeFileSync(musePlacementFile(), bad);
    const v = await museSpaceView();
    expect(v.hidden.map((c) => c.key)).toEqual(['tracking']); // 最后一份有效的
    expect(v.problems).toEqual([{ file: 'placement', message: expect.stringContaining('not valid JSON') }]);
    const r = await applyMusePlacement(1, { type: 'show', key: 'tracking' });
    expect(r).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(readFileSync(musePlacementFile()).equals(bad)).toBe(true);
  });

  it('「备好的」只列还在的、新 → 旧,标题去扩展名;软链指出 Library 的不算', async () => {
    const lib = museLibraryDir();
    writeRaw(join(lib, 'Drafts', 'old.md'), 'a');
    writeRaw(join(lib, 'Reading', 'new notes.md'), 'b');
    utimesSync(join(lib, 'Drafts', 'old.md'), new Date(NOW - 3_600_000), new Date(NOW - 3_600_000));
    utimesSync(join(lib, 'Reading', 'new notes.md'), new Date(NOW), new Date(NOW));
    writeFileSync(join(home, 'secret.md'), 'x');
    symlinkSync(join(home, 'secret.md'), join(lib, 'escape.md'));
    // 直接写原文件(卜算子用 write_file 改的那条路):读时校验
    writeRaw(museSpaceDocFile(), JSON.stringify({ schemaVersion: 1, rev: 2, prepared: ['Drafts/old.md', 'gone.md', 'Reading/new notes.md'] }));
    const v = await museSpaceView();
    expect(v.prepared.map((p) => [p.path, p.title])).toEqual([['Reading/new notes.md', 'new notes'], ['Drafts/old.md', 'old']]);
    expect(v.rev.doc).toBe(2);
    writeRaw(museSpaceDocFile(), JSON.stringify({ schemaVersion: 1, rev: 3, prepared: ['escape.md', 'Drafts/old.md'] }));
    expect((await museSpaceView()).prepared.map((p) => p.path)).toEqual(['Drafts/old.md']);
  });

  it('停用:stoppedAt = 那句话的时刻', async () => {
    await setDoc({ hero: { text: 'hi', at: new Date(NOW).toISOString() } });
    saveSpecialAgentsConfig({ muse: { enabled: false } } as any);
    const v = await museSpaceView();
    expect(v).toMatchObject({ enabled: false, stoppedAt: NOW });
  });
});

describe('写', () => {
  it('卜算子那份:rev 对不上回最新状态,什么都不写;对上了 rev + 1', async () => {
    await setDoc({ prepared: [] });
    const before = readFileSync(museSpaceDocFile(), 'utf8');
    const stale = await updateMuseDoc(0, (s) => ({ ok: true, doc: s.doc! }));
    expect(stale).toMatchObject({ ok: false, reason: 'conflict', state: { doc: { rev: 1 } } });
    expect(readFileSync(museSpaceDocFile(), 'utf8')).toBe(before);
    const next = await setDoc({ hero: { text: 'x', at: new Date(NOW).toISOString() } }, 1);
    expect(next.rev).toBe(2);
  });

  it('卜算子那份:内容没变不写(changed false,rev 不涨)', async () => {
    await setDoc({ hero: { text: 'same', at: new Date(NOW).toISOString() } });
    const r = await updateMuseDoc(1, (s) => ({ ok: true, doc: s.doc! }));
    expect(r).toMatchObject({ ok: true, changed: false, doc: { rev: 1 } });
  });

  it('你的摆放:rev 对不上 → conflict + 最新 view;对上了落盘、rev + 1;格子变了的操作 → invalid', async () => {
    const stale = await applyMusePlacement(3, { type: 'hide', key: 'todos' });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict', view: { rev: { placement: 0 } } });
    const r = await applyMusePlacement(0, { type: 'hide', key: 'todos' });
    expect(r.ok && r.view.rev.placement).toBe(1);
    expect(JSON.parse(readFileSync(musePlacementFile(), 'utf8'))).toMatchObject({ schemaVersion: 1, rev: 1, hidden: ['todos'] });
    const moved = await applyMusePlacement(1, { type: 'move', key: 'todos', to: 0 }); // 藏起来的不在可见格子里
    expect(moved).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('拒绝提议:摆放记墓碑,同一把锁里把提议从卜算子那份摘掉(rev + 1);接受:进格子、也摘掉', async () => {
    await setDoc({ proposed: [
      { key: 'focus-week', ref: { widgetId: 'w_31aa00000000' }, why: 'busy week', at: new Date(NOW).toISOString() },
      { key: 'status', ref: { builtin: 'status' }, why: 'see me', at: new Date(NOW).toISOString() },
    ] });
    const rej = await applyMusePlacement(0, { type: 'reject', key: 'focus-week' }, NOW);
    expect(rej.ok).toBe(true);
    let doc = JSON.parse(readFileSync(museSpaceDocFile(), 'utf8'));
    expect(doc.rev).toBe(2);
    expect(doc.proposed.map((p: any) => p.key)).toEqual(['status']);
    expect(JSON.parse(readFileSync(musePlacementFile(), 'utf8')).tombstones).toEqual([{ key: 'focus-week', at: new Date(NOW).toISOString() }]);
    const acc = await applyMusePlacement(1, { type: 'accept', key: 'status' });
    expect(acc.ok && acc.view.cards.map((c) => c.key)).toEqual(['todos', 'today', 'tracking', 'status']);
    doc = JSON.parse(readFileSync(museSpaceDocFile(), 'utf8'));
    expect(doc).toMatchObject({ rev: 3, proposed: [] });
    expect(acc.ok && acc.view.proposed).toEqual([]);
  });

  it('卜算子那份读坏时接受 / 拒绝:只写摆放、不碰它', async () => {
    await setDoc({ proposed: [{ key: 'status', ref: { builtin: 'status' }, why: 'w' }] });
    await museSpaceView(); // 刷新最后一份有效的
    const bad = Buffer.from('{broken');
    writeFileSync(museSpaceDocFile(), bad);
    const r = await applyMusePlacement(0, { type: 'reject', key: 'status' });
    expect(r.ok).toBe(true);
    expect(readFileSync(museSpaceDocFile()).equals(bad)).toBe(true);
    expect(r.ok && r.view.proposed).toEqual([]); // 合成照样滤掉墓碑里的
  });

  it('写出去的提议只留还挂着的:墓碑里的陈旧提议在下一次更新时摘掉', async () => {
    writeRaw(musePlacementFile(), JSON.stringify({ schemaVersion: 1, rev: 4, order: null, hidden: [], added: [], tombstones: [{ key: 'focus-week', at: new Date(NOW).toISOString() }] }));
    writeRaw(museSpaceDocFile(), JSON.stringify({ schemaVersion: 1, rev: 1, proposed: [{ key: 'focus-week', ref: { widgetId: 'w_31aa00000000' }, why: 'stale' }] }));
    expect((await museSpaceView()).proposed).toEqual([]); // 合成本来就不画
    const s = await readMuseSpaceState();
    expect(s.doc?.proposed).toHaveLength(1);
    await setDoc({ hero: { text: 'new', at: new Date(NOW).toISOString() } }, 1);
    expect(JSON.parse(readFileSync(museSpaceDocFile(), 'utf8')).proposed).toEqual([]);
  });
});
