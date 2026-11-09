/** Muse Space 布局协议的纯规则:读时校验、合成、你在页上的每一下。IO(锁、expectedRev、最后一份有效的)在 services/museSpace.test.ts。 */
import { describe, expect, it } from 'vitest';
import {
  applyPlacementOp, composeMuseSpace, emptyMusePlacement, normalizeLibraryPath, sanitizeMuseSpaceDoc, sanitizeMuseSpacePlacement,
  sanitizePlacementOp, MUSE_HERO_MAX, type MuseSpaceDoc, type MuseSpacePlacement,
} from './museSpace.js';

const NOW = '2026-11-08T12:00:00.000Z';
const doc = (over: Partial<MuseSpaceDoc> = {}): MuseSpaceDoc => ({ schemaVersion: 1, rev: 1, template: 'brief', hero: null, prepared: [], proposed: [], ...over });
const keys = (c: { key: string }[]): string[] => c.map((x) => x.key);
const apply = (d: MuseSpaceDoc | null, p: MuseSpacePlacement, op: unknown): MuseSpacePlacement => {
  const o = sanitizePlacementOp(op);
  if (!o) throw new Error('bad op');
  const r = applyPlacementOp(d, p, o, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.placement;
};

describe('读时校验', () => {
  it('结构不对 = 读坏;个别项不合法只丢那一项', () => {
    expect(sanitizeMuseSpaceDoc('x').ok).toBe(false);
    expect(sanitizeMuseSpaceDoc({ schemaVersion: 2 }).ok).toBe(false);
    const r = sanitizeMuseSpaceDoc({
      schemaVersion: 1, rev: 3,
      hero: { text: 'a'.repeat(400), at: 'nope' },
      prepared: ['Drafts/a.md', '../etc/passwd', '/abs.md', '.hidden/x.md', 'Drafts/a.md', 'b.md', 'c.md', 'd.md'],
      proposed: [{ key: 'focus-week', ref: { widgetId: 'w_31aa' }, why: 'busy week' }, { key: 'todos', ref: { widgetId: 'w_x' } }, { key: 'BAD', ref: { builtin: 'todos' } }],
      cards: [{ key: 'ignored', ref: { builtin: 'today' } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.from(r.value.hero!.text)).toHaveLength(MUSE_HERO_MAX);
    expect(r.value.prepared).toEqual(['Drafts/a.md', 'b.md', 'c.md']);
    expect(keys(r.value.proposed)).toEqual(['focus-week']); // 内置种类名不能指向小组件;大写 key 不合法
    expect(r.value).not.toHaveProperty('cards'); // 卜算子那份不放格子
  });

  it('Library 路径只收相对、无 ..、无隐藏段', () => {
    expect(normalizeLibraryPath('Reading\\置身事内 · 摘录.md')).toBe('Reading/置身事内 · 摘录.md');
    expect(normalizeLibraryPath('./Journal/2026-11-08.md')).toBe('Journal/2026-11-08.md');
    for (const bad of ['', '/x', 'C:/x', 'a/../b', 'a/.git/x', 'a//b']) expect(normalizeLibraryPath(bad)).toBeNull();
  });

  it('摆放:读不懂的项丢掉,order 没给 = null(从没排过)', () => {
    const r = sanitizeMuseSpacePlacement({ schemaVersion: 1, rev: 2, hidden: ['section:today', 'x y'], added: [{ key: 'release', ref: { widgetId: 'w_8f2c' } }, { key: 'release', ref: { widgetId: 'w_dup' } }], tombstones: [{ key: 'focus-week', at: NOW }] });
    expect(r.ok && r.value).toMatchObject({ order: null, hidden: ['section:today'], added: [{ key: 'release' }], tombstones: [{ key: 'focus-week' }] });
  });
});

describe('合成', () => {
  it('第一轮之前也能画:缺省三张 待你看的 · 今天 · 在跟的,两节都显示', () => {
    const c = composeMuseSpace(null, emptyMusePlacement());
    expect(keys(c.cards)).toEqual(['todos', 'today', 'tracking']);
    expect(c.sections).toEqual({ prepared: true, today: true });
  });

  it('接受过卜算子的小组件 → 缺省第二格换成它;提议在墓碑里 / 已在格子里就不挂', () => {
    let p = emptyMusePlacement();
    const d = doc({ proposed: [{ key: 'release', ref: { widgetId: 'w_8f2c' } }, { key: 'focus-week', ref: { widgetId: 'w_31aa' } }] });
    p = apply(d, p, { type: 'accept', key: 'release' });
    p = apply(d, p, { type: 'reject', key: 'focus-week' });
    const c = composeMuseSpace(d, p);
    expect(keys(c.cards)).toEqual(['todos', 'release', 'tracking']);
    expect(c.proposed).toEqual([]);
    // 卜算子换个小组件 id 用同一个 key 再提 → 还是不挂
    expect(composeMuseSpace(doc({ proposed: [{ key: 'focus-week', ref: { widgetId: 'w_new' } }] }), p).proposed).toEqual([]);
  });

  it('你排过的顺序在前,新放上的接在后面;藏起来的不在格子里、在 hidden', () => {
    let p = emptyMusePlacement();
    p = apply(null, p, { type: 'move', key: 'tracking', to: 0 });
    expect(keys(composeMuseSpace(null, p).cards)).toEqual(['tracking', 'todos', 'today']);
    p = apply(null, p, { type: 'add', card: { key: 'status', ref: { builtin: 'status' } } });
    p = apply(null, p, { type: 'hide', key: 'todos' });
    p = apply(null, p, { type: 'hide', key: 'section:prepared' });
    const c = composeMuseSpace(null, p);
    expect(keys(c.cards)).toEqual(['tracking', 'today', 'status']);
    expect(keys(c.hidden)).toEqual(['todos']);
    expect(c.sections).toEqual({ prepared: false, today: true });
  });
});

describe('你在页上的每一下', () => {
  it('从「添加」放回被拒过的卡 → 墓碑清掉;放回藏起来的缺省卡 → 只取消隐藏,不进 added', () => {
    const d = doc({ proposed: [{ key: 'focus-week', ref: { widgetId: 'w_31aa' } }] });
    let p = apply(d, emptyMusePlacement(), { type: 'reject', key: 'focus-week' });
    p = apply(d, p, { type: 'add', card: { key: 'focus-week', ref: { widgetId: 'w_31aa' } } });
    expect(p.tombstones).toEqual([]);
    expect(keys(composeMuseSpace(d, p).cards)).toContain('focus-week');
    p = apply(d, p, { type: 'hide', key: 'todos' });
    p = apply(d, p, { type: 'add', card: { key: 'todos', ref: { builtin: 'todos' } } });
    expect(keys(p.added)).toEqual(['focus-week']);
    expect(keys(composeMuseSpace(d, p).cards)).toContain('todos');
  });

  it('恢复默认:清你的摆放,不清墓碑', () => {
    const d = doc({ proposed: [{ key: 'focus-week', ref: { widgetId: 'w_31aa' } }] });
    let p = apply(d, emptyMusePlacement(), { type: 'reject', key: 'focus-week' });
    p = apply(d, p, { type: 'move', key: 'tracking', to: 0 });
    p = apply(d, p, { type: 'hide', key: 'section:today' });
    p = apply(d, p, { type: 'reset' });
    expect(p).toMatchObject({ order: null, hidden: [], added: [], tombstones: [{ key: 'focus-week' }] });
  });

  it('不适用的一下什么都不改:挪不在格子里的、接受不存在的提议、同一个 key 指向别处', () => {
    const p = emptyMusePlacement();
    expect(applyPlacementOp(null, p, { type: 'move', key: 'nope', to: 0 }, NOW).ok).toBe(false);
    expect(applyPlacementOp(null, p, { type: 'accept', key: 'nope' }, NOW).ok).toBe(false);
    const p2 = apply(null, p, { type: 'add', card: { key: 'release', ref: { widgetId: 'w_a' } } });
    expect(applyPlacementOp(null, p2, { type: 'add', card: { key: 'release', ref: { widgetId: 'w_b' } } }, NOW).ok).toBe(false);
    expect(sanitizePlacementOp({ type: 'move', key: 'todos', to: -1 })).toBeNull();
    expect(sanitizePlacementOp({ type: 'add', card: { key: 'today', ref: { widgetId: 'w_a' } } })).toBeNull();
  });
});
