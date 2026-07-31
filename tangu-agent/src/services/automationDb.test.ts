/**
 * 阶段二仪器:db_changed 的比对语义 + 模板变量的白名单/消毒。
 * 都是纯逻辑(readDbFile 与 cursors 全靠注入),不碰磁盘、不起引擎。
 */
import { describe, it, expect } from 'vitest';
import { evaluateTriggers, type MuseTrigger, type DbLike, type TriggerContext } from './museTriggers.js';
import type { DbCursor } from './dbCursors.js';
import { expandTemplate, expandCells } from './automationTemplate.js';

const VAULT = '/Users/x/Forsion/Amadeus';

function rule(over: Partial<MuseTrigger>): MuseTrigger {
  return {
    id: 'w-db01',
    desc: 'db rule',
    cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'row_added' },
    cooldownHours: 0,
    lastFiredAt: null,
    enabled: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function db(rows: { id: string; cells: Record<string, unknown> }[]): DbLike {
  return {
    columns: [{ id: 'c1', name: '名称' }, { id: 'c2', name: '状态' }],
    rows,
  };
}

async function run(t: MuseTrigger, data: DbLike | null, cursors: Record<string, DbCursor> = {}) {
  const outDbCursors: Record<string, DbCursor> = {};
  const outContexts: Record<string, TriggerContext> = {};
  const fired = await evaluateTriggers([t], {
    currentVault: VAULT,
    dbCursors: cursors,
    outDbCursors,
    outContexts,
    readDbFile: async () => data,
  });
  return { fired: fired.map((x) => x.id), outDbCursors, outContexts };
}

describe('db_changed 触发', () => {
  it('首次只播种,绝不把满表现有行当成「刚加的」', async () => {
    const r = await run(rule({}), db([{ id: 'r1', cells: {} }, { id: 'r2', cells: {} }]));
    expect(r.fired).toEqual([]);
    expect(r.outDbCursors['w-db01']).toEqual({ v: 1, rowIds: ['r1', 'r2'] });
  });

  it('row_added:只认游标里没见过的行,并把命中行带进上下文', async () => {
    const r = await run(
      rule({}),
      db([{ id: 'r1', cells: { c1: '旧' } }, { id: 'r9', cells: { c1: '新任务' } }]),
      { 'w-db01': { v: 1, rowIds: ['r1'] } },
    );
    expect(r.fired).toEqual(['w-db01']);
    expect(r.outContexts['w-db01'].row?.id).toBe('r9');
    // 列 id 与列名两种键都能取到(列改名不至于当场失效)
    expect(r.outContexts['w-db01'].row?.cells).toMatchObject({ c1: '新任务', 名称: '新任务' });
  });

  it('cell_changed:值变才算;新行归 row_added 管不在这儿重复报', async () => {
    const t = rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c2' } });
    const cur = { 'w-db01': { v: 1 as const, cells: { r1: '进行中' } } };
    expect((await run(t, db([{ id: 'r1', cells: { c2: '进行中' } }]), cur)).fired).toEqual([]);
    expect((await run(t, db([{ id: 'r1', cells: { c2: '完成' } }]), cur)).fired).toEqual(['w-db01']);
    // r2 是新行(游标里没有)→ 不由 cell_changed 报
    expect((await run(t, db([{ id: 'r1', cells: { c2: '进行中' } }, { id: 'r2', cells: { c2: '完成' } }]), cur)).fired).toEqual([]);
  });

  it('equals 不匹配也要推进游标 —— 不推的话下一轮拿更旧的快照比,结论必错', async () => {
    const t = rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c2', equals: '完成' } });
    const r = await run(t, db([{ id: 'r1', cells: { c2: '进行中' } }]), { 'w-db01': { v: 1, cells: { r1: '待办' } } });
    expect(r.fired).toEqual([]);
    expect(r.outDbCursors['w-db01']).toEqual({ v: 1, cells: { r1: '进行中' } });
  });

  it('切库保护:vault 不符整条跳过(否则同路径的另一个库会被静默作用)', async () => {
    const t = rule({ cond: { type: 'db_changed', path: '任务.db', vault: '/别的/库', event: 'row_added' } });
    const r = await run(t, db([{ id: 'r1', cells: {} }, { id: 'r2', cells: {} }]), { 'w-db01': { v: 1, rowIds: [] } });
    expect(r.fired).toEqual([]);
    expect(r.outDbCursors['w-db01']).toBeUndefined(); // 连游标都不该动
  });

  it('笔记视图(source)与表不存在:一律不触发', async () => {
    const noteView: DbLike = { source: { folder: '日记' }, columns: [], rows: [] };
    expect((await run(rule({}), noteView, { 'w-db01': { v: 1, rowIds: [] } })).fired).toEqual([]);
    expect((await run(rule({}), null, { 'w-db01': { v: 1, rowIds: [] } })).fired).toEqual([]);
  });
});

describe('模板变量', () => {
  const ctx: TriggerContext = { dbPath: 't.db', row: { id: 'r1', cells: { 名称: '写周报', c1: '写周报' } } };

  it('列名与列 id 都能取;取不到的变量原样保留(一眼看出没接上)', () => {
    expect(expandTemplate('新任务:{{row.名称}}', ctx)).toBe('新任务:写周报');
    expect(expandTemplate('{{row.c1}}', ctx)).toBe('写周报');
    expect(expandTemplate('{{row.不存在}}', ctx)).toBe('{{row.不存在}}');
    expect(expandTemplate('{{row.名称}}', undefined)).toBe('{{row.名称}}'); // 无上下文
  });

  it('原型链不是变量:{{row.__proto__}} 只是查不到的键', () => {
    expect(expandTemplate('{{row.__proto__}}', ctx)).toBe('{{row.__proto__}}');
    expect(expandTemplate('{{row.constructor}}', ctx)).toBe('{{row.constructor}}');
  });

  it('消毒:块标记必须被打断(整行 <!-- a N --> 会被编译器当成真的块边界劈开页面)', () => {
    const evil: TriggerContext = { row: { id: 'r', cells: { x: '<!-- a 3 -->' } } };
    const out = expandTemplate('{{row.x}}', evil);
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('-->');
  });

  it('换行被压平、单值截断(防一行超长表格内容把通知撑爆)', () => {
    const long: TriggerContext = { row: { id: 'r', cells: { x: `${'啊'.repeat(900)}\n第二行` } } };
    const out = expandTemplate('{{row.x}}', long);
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThanOrEqual(500);
  });

  it('expandCells 逐值展开', () => {
    expect(expandCells({ c1: '{{row.名称}}', c2: '固定' }, ctx)).toEqual({ c1: '写周报', c2: '固定' });
  });
});
