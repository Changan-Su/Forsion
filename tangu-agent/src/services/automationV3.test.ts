/**
 * 自动化 v3 仪器:模板算术 `{{= }}` / db 动作三档目标行 + skipIfEmpty + 盖章 / 行物化 /
 * 单 tick 排空(drain)与三件环防线 / 自游标推进 / 插件规则幂等创建 / 真 runActions 链路。
 *
 * 前半全注入不碰磁盘;后半(describe '真 io')用 automationActions.test 同款台架:
 * 内存 SQLite + tmp TANGU_HOME + tmp vault(FORSION_AMADEUS_VAULT),走真 mutateDb / 真账本。
 *
 * 负对照(每条主断言旁边都有一条「改坏了会红」):见各 it 的注释;§6.1 的 A→B→A 环用 maxRounds 注入验证
 * 「没有 cap 就跑飞」——断言轮数被 cap 钉住,不真跑飞。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandTemplate, expandCells } from './automationTemplate.js';
import { applyDbAction, emptyTouch, mergeTouch, stampNewRow, type DbActionIo, type DbActionSpec, type DbTouch } from './automationDbAction.js';
import { drainAutomation, DRAIN_MAX_ROUNDS, type DrainDeps } from './automationDrain.js';
import {
  evaluateTriggers, materializeRow, triggerRowOf, validateTriggerInput, upsertTrigger, loadTriggers, normalizeVaultRel, cursorFor, MAX_TRIGGERS,
  type MuseTrigger, type DbLike, type TriggerContext, type ActionSpec,
} from './museTriggers.js';
import type { DbCursor } from './dbCursors.js';
import type { DbFile } from './amadeusDb.js';
import type { TriggerHit, LaunchResult, TouchedDbs } from './automation.js';

const VAULT = '/Users/x/Forsion/Amadeus';

// ── 夹具 ────────────────────────────────────────────────────────────────────

function rule(over: Partial<MuseTrigger>): MuseTrigger {
  return {
    id: 'w-a',
    desc: 'rule',
    cond: { type: 'db_changed', path: 'A.db', vault: VAULT, event: 'row_added' },
    cooldownHours: 0,
    lastFiredAt: null,
    enabled: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    actions: [{ type: 'notify', title: 'x' }],
    ...over,
  };
}

/** 库存表:数量/锁单数 数字列;出库表:配件 rowlink(单)→ 库存,订单 rowlink(单)→ 订单;订单表:多选 rowlink → 库存。 */
function stock(): DbFile {
  return {
    version: 1, name: '库存',
    columns: [
      { id: 'n', name: '名称', type: 'text' },
      { id: 'q', name: '数量', type: 'number' },
      { id: 'lock', name: '锁单数量', type: 'number' },
      { id: 'no', name: '编号', type: 'autonumber', prefix: 'PC-' },
      { id: 'at', name: '创建时间', type: 'created' },
    ],
    rows: [
      { id: 's1', cells: { n: 'CPU', q: 10, lock: 1, no: 3 } },
      { id: 's2', cells: { n: '显卡', q: 5, lock: 0, no: 7 } },
      { id: 's3', cells: { n: '内存', q: 20, lock: 2 } },
    ],
  };
}
function outbound(): DbFile {
  return {
    version: 1, name: '出库',
    columns: [
      { id: 'part', name: '配件', type: 'rowlink', refDb: '库存.db' },
      { id: 'ord', name: '订单总表', type: 'rowlink', refDb: '订单.db' },
      { id: 'qty', name: '出库数量', type: 'number' },
      { id: 'st', name: '订单状态', type: 'select', options: ['未确认', '已确认'] },
      { id: 'cur', name: '当前库存', type: 'lookup', lookupRel: 'part', lookupCol: 'q' },
    ],
    rows: [
      { id: 'ob1', cells: { part: 's1', ord: 'o1', qty: 1, st: '未确认' } },
      { id: 'ob2', cells: { part: 's2', ord: 'o1', qty: 2, st: '未确认' } },
      { id: 'ob3', cells: { part: 's3', ord: 'o2', qty: 1, st: '未确认' } },
    ],
  };
}
function orders(): DbFile {
  return {
    version: 1, name: '订单',
    columns: [
      { id: 'cust', name: '客户', type: 'text' },
      { id: 'parts', name: '配件', type: 'rowlink', refDb: '库存.db', multiple: true },
      { id: 'cpu', name: 'CPU', type: 'rowlink', refDb: '库存.db' },
      { id: 'st', name: '订单状态', type: 'select' },
      { id: 'total', name: '合计', type: 'lookup', lookupRel: 'parts', lookupCol: 'q', lookupAgg: 'sum' },
    ],
    rows: [
      { id: 'o1', cells: { cust: '张三', parts: ['s1', 's2'], cpu: 's1', st: '未确认' } },
      { id: 'o2', cells: { cust: '李四', parts: [], cpu: '', st: '未确认' } },
    ],
  };
}

/** 内存 io:tables 就是磁盘;mutateDb 直接就地改;路径归一(真 io 走 path.resolve,`./x.db` 与 `x.db` 同一文件)。 */
function memIo(tables: Record<string, DbFile>): DbActionIo & { tables: Record<string, DbFile> } {
  return {
    tables,
    readDb: async (rel) => (tables[normalizeVaultRel(rel)] as DbLike) ?? null,
    mutateDb: async (rel, fn) => {
      const db = tables[normalizeVaultRel(rel)];
      if (!db) throw new Error(`no such table ${rel}`);
      fn(db);
    },
  };
}

const rowCtx = (cells: Record<string, string>, typed: Record<string, any>, id = 'r1', dbPath = 't.db'): TriggerContext =>
  ({ dbPath, row: { id, cells, typed } });

// ── E2 模板算术 ──────────────────────────────────────────────────────────────

describe('{{= }} 模板算术', () => {
  const ctx: TriggerContext = {
    row: { id: 'r1', cells: { 出库数量: '3', qty: '3', 名称: 'CPU' }, typed: { 出库数量: 3, qty: 3, 名称: 'CPU' } },
    target: { id: 't1', cells: { 数量: '10', 锁单数量: '' }, typed: { 数量: 10, 锁单数量: null } },
  };

  it('row/target/裸名三种引用;数字列按数字算(不是字符串拼接);括号深度扫描认 {a}}}', () => {
    expect(expandTemplate('{{= {target.数量} - {row.出库数量} }}', ctx)).toBe('7');
    expect(expandTemplate('{{= {出库数量} * 2 }}', ctx)).toBe('6'); // 裸名 = row
    expect(expandTemplate('{{={target.数量}}}', ctx)).toBe('10'); // 紧贴的 }}} —— 第一个 } 是列引用的
    expect(expandTemplate('剩 {{= {target.数量} - {row.qty} }} 件,{{row.名称}}', ctx)).toBe('剩 7 件,CPU');
    // 负对照:走普通替换的 {{row.出库数量}} 是字符串,"3"+"3" 会拼成 33;算术路径必须给 6
    expect(expandTemplate('{{= {row.qty} + {row.qty} }}', ctx)).toBe('6');
  });

  it('null 结果落成空串(number 列 coerce 成 null,不写 "null");算术结果不回炉二次展开', () => {
    expect(expandTemplate('{{= {target.锁单数量} }}', ctx)).toBe('');
    expect(expandTemplate('{{= {target.锁单数量} + {row.qty} }}', ctx)).toBe('3'); // 空按 0
    const evil: TriggerContext = { row: { id: 'r', cells: { x: '{{row.y}}', y: '秘密' }, typed: { x: '{{row.y}}', y: '秘密' } } };
    expect(expandTemplate('{{= {row.x} }}', evil)).toBe('{{row.y}}');
  });

  it('错误一律抛(未知列 / 未闭合 / 无上下文 / 除零),动作失败即停,不写脏值', () => {
    expect(() => expandTemplate('{{= {row.不存在} }}', ctx)).toThrow(/未知列/);
    expect(() => expandTemplate('{{= {row.qty} ', ctx)).toThrow(/未闭合/);
    expect(() => expandTemplate('{{= {target.数量} }}', { row: ctx.row })).toThrow(/target/);
    expect(() => expandTemplate('{{= {row.qty} / 0 }}', ctx)).toThrow(/除以 0/);
    expect(() => expandCells({ a: '{{= }}' }, ctx)).toThrow();
    // 普通变量查不到仍是「原样保留」,不抛(老语义不变)
    expect(expandTemplate('{{row.不存在}}', ctx)).toBe('{{row.不存在}}');
  });

  it('{{target.X}} 普通替换 + 老上下文(无 typed)退回字符串图', () => {
    expect(expandTemplate('{{target.数量}}/{{target.id}}', ctx)).toBe('10/t1');
    const old: TriggerContext = { row: { id: 'r', cells: { n: '4' } } };
    expect(expandTemplate('{{= {row.n} * 2 }}', old)).toBe('8');
  });
});

// ── E3/E4 db 动作 ─────────────────────────────────────────────────────────────

describe('applyDbAction(内存 io)', () => {
  const NOW = new Date(2026, 8, 2, 9, 5);
  const orderRow = (t: Record<string, DbFile>): TriggerContext => {
    const o = t['订单.db'].rows[0];
    return rowCtx({ 客户: '张三', 配件: 's1s2', CPU: 's1', parts: 's1s2', cpu: 's1' }, { 客户: '张三', 配件: ['s1', 's2'], CPU: 's1', parts: ['s1', 's2'], cpu: 's1' }, o.id, '订单.db');
  };

  it('db_row_add:盖章 autonumber(max+1)/created(YYYY-MM-DDTHH:mm);显式 cells 盖过盖章', async () => {
    const io = memIo({ '库存.db': stock() });
    await applyDbAction({ type: 'db_row_add', path: '库存.db', cells: { 名称: '电源' } }, undefined, io, NOW);
    const added = io.tables['库存.db'].rows.at(-1)!;
    expect(added.cells).toMatchObject({ n: '电源', no: 8, at: '2026-09-02T09:05' });
    // 负对照:显式给了编号 → 以显式为准(与渲染层 {...newRowCells, ...initial} 同序)
    await applyDbAction({ type: 'db_row_add', path: '库存.db', cells: { 名称: '机箱', 编号: '100' } }, undefined, io, NOW);
    expect(io.tables['库存.db'].rows.at(-1)!.cells.no).toBe(100);
    expect(stampNewRow(io.tables['库存.db'], NOW)).toMatchObject({ no: 101 });
  });

  it('updated 盖章(2026-09-02):db_row_add 建行即盖;db_row_edit 只在有格真变了时盖并进 touch.edited;同值写回不盖', async () => {
    // 负对照(已实跑红):stampUpdatedRow 去掉 changed 闸 → 「同值写回不盖」红。
    const t = stock();
    t.columns.push({ id: 'up', name: '修改时间', type: 'updated' });
    t.rows[0].cells.up = '2026-01-01T00:00';
    const io = memIo({ '库存.db': t });
    await applyDbAction({ type: 'db_row_add', path: '库存.db', cells: { 名称: '电源' } }, undefined, io, NOW);
    expect(io.tables['库存.db'].rows.at(-1)!.cells.up).toBe('2026-09-02T09:05');
    const same = String(t.rows[0].cells.n);
    const r0 = await applyDbAction({ type: 'db_row_edit', path: '库存.db', rowId: t.rows[0].id, cells: { 名称: same } }, undefined, io, NOW);
    expect(t.rows[0].cells.up).toBe('2026-01-01T00:00');
    expect(r0.touch.edited.map((e) => e.colId)).toEqual(['n']);
    const LATER = new Date(2026, 8, 3, 10, 0);
    const r1 = await applyDbAction({ type: 'db_row_edit', path: '库存.db', rowId: t.rows[0].id, cells: { 名称: same + '!' } }, undefined, io, LATER);
    expect(t.rows[0].cells.up).toBe('2026-09-03T10:00');
    expect(r1.touch.edited).toContainEqual({ rowId: t.rows[0].id, colId: 'up', key: '2026-09-03T10:00' });
  });

  it('E4 skipIfEmpty:槽位展开为空 → 跳过(不写、记 skipped);非空 → 建行', async () => {
    const io = memIo({ '出库.db': outbound(), '订单.db': orders(), '库存.db': stock() });
    const before = io.tables['出库.db'].rows.length;
    const ctx = orderRow(io.tables);
    const a: ActionSpec = { type: 'db_row_add', path: '出库.db', cells: { 配件: '{{row.显卡}}', 订单总表: '{{row.id}}' }, skipIfEmpty: '配件' };
    const r = await applyDbAction(a, ctx, io, NOW); // {{row.显卡}} 查不到 → 模板串原样保留(非空)→ 不算空槽位,照建
    expect(r.skipped).toBeUndefined();
    // 真正的空:CPU 槽位为空的订单
    const empty = rowCtx({ CPU: '', cpu: '' }, { CPU: '', cpu: '' }, 'o2');
    const r2 = await applyDbAction({ type: 'db_row_add', path: '出库.db', cells: { 配件: '{{row.CPU}}', 订单总表: '{{row.id}}' }, skipIfEmpty: '配件' }, empty, io, NOW);
    expect(r2.skipped).toBe(true);
    expect(io.tables['出库.db'].rows.length).toBe(before + 1);
    // 负对照:同样的空槽位不带 skipIfEmpty → 建了一行空配件(这就是飞书「先建 16 行再清理」的病)
    await applyDbAction({ type: 'db_row_add', path: '出库.db', cells: { 配件: '{{row.CPU}}', 订单总表: '{{row.id}}' } }, empty, io, NOW);
    expect(io.tables['出库.db'].rows.length).toBe(before + 2);
    expect(io.tables['出库.db'].rows.at(-1)!.cells).toMatchObject({ part: '', ord: 'o2' });
  });

  it('E3 rowFrom(单值 → 一行):沿触发行的关联列改目标行,{{target.X}} 是目标行自己的值', async () => {
    const io = memIo({ '库存.db': stock(), '出库.db': outbound() });
    const ctx = rowCtx({ 配件: 's2', part: 's2', 出库数量: '2', qty: '2' }, { 配件: 's2', part: 's2', 出库数量: 2, qty: 2 }, 'ob2', '出库.db');
    const r = await applyDbAction({
      type: 'db_row_edit', path: '库存.db', rowFrom: '配件',
      cells: { 数量: '{{= {target.数量} - {row.出库数量} }}', 锁单数量: '{{= {target.锁单数量} + {row.出库数量} }}' },
    }, ctx, io, NOW);
    expect(r.summary).toContain('edited row s2');
    expect(r.touch).toEqual({ addedIds: [], edited: [{ rowId: 's2', colId: 'q', key: '3' }, { rowId: 's2', colId: 'lock', key: '2' }] }); // 精确因果:写后 key
    expect(io.tables['库存.db'].rows[1].cells).toMatchObject({ q: 3, lock: 2 });
    expect(io.tables['库存.db'].rows[0].cells).toMatchObject({ q: 10, lock: 1 }); // 别的行没动
    // 负对照:不带 rowFrom → 默认「触发行」,ob2 不在库存表 → 抛(不能静默改错行)
    await expect(applyDbAction({ type: 'db_row_edit', path: '库存.db', cells: { 数量: '0' } }, ctx, io, NOW)).rejects.toThrow(/ob2 not found/);
    // rowFrom 空 / 指向不存在的行 → 抛
    const empty = rowCtx({ 配件: '', part: '' }, { 配件: '', part: '' }, 'ob1', '出库.db');
    await expect(applyDbAction({ type: 'db_row_edit', path: '库存.db', rowFrom: '配件', cells: { 数量: '0' } }, empty, io, NOW)).rejects.toThrow(/is empty/);
    const dangling = rowCtx({ 配件: 'nope', part: 'nope' }, { 配件: 'nope', part: 'nope' }, 'ob1', '出库.db'); // 值按解析出的列 id 取
    await expect(applyDbAction({ type: 'db_row_edit', path: '库存.db', rowFrom: '配件', cells: { 数量: '0' } }, dangling, io, NOW)).rejects.toThrow(/nope not found/);
  });

  it('rowFrom 信任边界:必须解析到 rowlink 列且 refDb == 动作 path;否则抛;id 去重', async () => {
    const io = memIo({ '库存.db': stock(), '出库.db': outbound(), '订单.db': orders() });
    // 出库表的 订单状态 是 select 列,cell 值 '未确认' 恰好像个行 id —— 从前照样拿去当库存表的行 id
    const stCtx = rowCtx({ 订单状态: 's1', st: 's1', 配件: 's1' }, { 订单状态: 's1', st: 's1', 配件: 's1' }, 'ob1', '出库.db');
    await expect(applyDbAction({ type: 'db_row_edit', path: '库存.db', rowFrom: '订单状态', cells: { 数量: '0' } }, stCtx, io, NOW))
      .rejects.toThrow(/is a select column, not a relation/);
    // rowlink 但指向别的表(出库.订单总表 → 订单.db,动作却改 库存.db)
    const ordCtx = rowCtx({ 订单总表: 's1', ord: 's1' }, { 订单总表: 's1', ord: 's1' }, 'ob1', '出库.db');
    await expect(applyDbAction({ type: 'db_row_edit', path: '库存.db', rowFrom: '订单总表', cells: { 数量: '0' } }, ordCtx, io, NOW))
      .rejects.toThrow(/links to "订单.db", not to the action's table "库存.db"/);
    // 没有触发表信息(dbPath)/ 触发表读不到 → 抛,不猜
    await expect(applyDbAction({ type: 'db_row_edit', path: '库存.db', rowFrom: '配件', cells: { 数量: '0' } }, { row: stCtx.row }, io, NOW)).rejects.toThrow(/ctx\.dbPath/);
    await expect(applyDbAction({ type: 'db_row_edit', path: '库存.db', rowFrom: '配件', cells: { 数量: '0' } }, { ...stCtx, dbPath: 'nope.db' }, io, NOW)).rejects.toThrow(/nope.db not found/);
    // 路径归一后比对(./库存.db == 库存.db);多值去重:['s1','s1','s2'] 只改两行、各一次
    const dup = rowCtx({ parts: 's1, s1, s2' }, { parts: ['s1', 's1', 's2'] }, 'o1', '订单.db');
    const r = await applyDbAction({ type: 'db_row_edit', path: './库存.db', rowFrom: '配件', cells: { 锁单数量: '{{= {target.锁单数量} + 1 }}' } }, dup, io, NOW);
    expect(r.summary).toContain('edited 2 rows');
    expect(io.tables['库存.db'].rows.map((x) => x.cells.lock)).toEqual([2, 1, 2]);
    expect(stock().rows.map((x) => x.cells.lock)).toEqual([1, 0, 2]);
    // 负对照(实跑过):idsFromRowFrom 去掉 schema 校验(旧:任何 string/string[] 都当 id)→ 订单状态 用例不抛、去改了 s1 → 红
  });

  it('E3 rowFrom(多值 → 逐行):每个目标各自的 target.*;rowId 优先级最高', async () => {
    const io = memIo({ '库存.db': stock(), '订单.db': orders() });
    const ctx = orderRow(io.tables);
    const r = await applyDbAction({ type: 'db_row_edit', path: '库存.db', rowFrom: 'parts', cells: { 锁单数量: '{{= {target.锁单数量} + 1 }}', 名称: '{{target.名称}}!' } }, ctx, io, NOW);
    expect(r.summary).toContain('edited 2 rows');
    expect(io.tables['库存.db'].rows.map((x) => x.cells.lock)).toEqual([2, 1, 2]); // s1 1→2, s2 0→1, s3 不动
    expect(io.tables['库存.db'].rows.map((x) => x.cells.n)).toEqual(['CPU!', '显卡!', '内存']);
    // rowId > rowFrom
    await applyDbAction({ type: 'db_row_edit', path: '库存.db', rowId: 's3', rowFrom: 'parts', cells: { 锁单数量: '9' } }, ctx, io, NOW);
    expect(io.tables['库存.db'].rows.map((x) => x.cells.lock)).toEqual([2, 1, 9]);
  });

  it('E3 match:目标表里 column == value 的全部行(value 可模板);多选关联含即中;0 行不落盘', async () => {
    const io = memIo({ '出库.db': outbound(), '订单.db': orders(), '库存.db': stock() });
    const ctx = rowCtx({ 订单状态: '已确认', st: '已确认' }, { 订单状态: '已确认', st: '已确认' }, 'o1');
    const r = await applyDbAction({ type: 'db_row_edit', path: '出库.db', match: { column: '订单总表', value: '{{row.id}}' }, cells: { 订单状态: '{{row.订单状态}}' } }, ctx, io, NOW);
    expect(r.summary).toContain('edited 2 rows');
    expect(io.tables['出库.db'].rows.map((x) => x.cells.st)).toEqual(['已确认', '已确认', '未确认']);
    // 负对照:value 写死一个不存在的订单 → 0 行、不改任何东西
    let writes = 0;
    const spy: DbActionIo = { ...io, mutateDb: async (rel, fn) => { if (fn(io.tables[rel]) !== false) writes++; } };
    const r0 = await applyDbAction({ type: 'db_row_edit', path: '出库.db', match: { column: '订单总表', value: 'o404' }, cells: { 订单状态: '已取消' } }, ctx, spy, NOW);
    expect(r0.summary).toContain('matched 0 rows');
    expect(writes).toBe(0);
    // 多选关联:订单表 parts 含 s1 的订单
    const r2 = await applyDbAction({ type: 'db_row_edit', path: '订单.db', match: { column: 'parts', value: 's1' }, cells: { 订单状态: '含CPU' } }, undefined, io, NOW);
    expect(r2.summary).toContain('edited row o1');
    // 计算列也能 match(合计 = 库存数量之和 15)
    const r3 = await applyDbAction({ type: 'db_row_edit', path: '订单.db', match: { column: '合计', value: '15' }, cells: { 客户: '{{target.客户}}-大单' } }, undefined, io, NOW);
    expect(r3.summary).toContain('edited row o1');
    expect(io.tables['订单.db'].rows[0].cells.cust).toBe('张三-大单');
  });

  it('多选关联往返:{{row.parts}} 展成 "s1, s2",写回 multiple rowlink 列拆回 [s1, s2](不是一个悬空 id "s1s2")', async () => {
    const io = memIo({ '订单.db': orders(), '库存.db': stock() });
    const src: DbLike = orders();
    const mat = await materializeRow(src, src.rows[0], async (rel) => (rel === '库存.db' ? (stock() as DbLike) : null));
    const trow = triggerRowOf(src, 'o1', mat);
    expect(trow.cells.parts).toBe('s1, s2');
    expect(trow.cells.合计).toBe('15');
    await applyDbAction({ type: 'db_row_add', path: '订单.db', cells: { 客户: '复制', parts: '{{row.parts}}', CPU: '{{row.CPU}}' } }, { row: trow }, io, NOW);
    expect(io.tables['订单.db'].rows.at(-1)!.cells).toMatchObject({ cust: '复制', parts: ['s1', 's2'], cpu: 's1' });
  });

  it('目标行的 lookup 在 target.* 里已物化(出库行的「当前库存」沿配件取库存数量)', async () => {
    const io = memIo({ '出库.db': outbound(), '库存.db': stock() });
    await applyDbAction({ type: 'db_row_edit', path: '出库.db', rowId: 'ob1', cells: { 出库数量: '{{= {target.当前库存} - 4 }}' } }, undefined, io, NOW);
    expect(io.tables['出库.db'].rows[0].cells.qty).toBe(6);
  });
});

// ── E1 物化 ───────────────────────────────────────────────────────────────────

describe('materializeRow', () => {
  it('先 lookup 后 formula;依赖表缺失/读坏 → 抛(失败即关)', async () => {
    const t: DbLike = {
      columns: [
        { id: 'rel', name: '配件', type: 'rowlink', refDb: '库存.db' },
        { id: 'p', name: '库存数', type: 'lookup', lookupRel: 'rel', lookupCol: 'q' },
        { id: 'f', name: '翻倍', type: 'formula', formula: '{库存数} * 2' },
      ],
      rows: [{ id: 'r1', cells: { rel: 's2' } }],
    };
    const m = await materializeRow(t, t.rows[0], async (rel) => (rel === '库存.db' ? (stock() as DbLike) : null));
    expect(m).toMatchObject({ rel: 's2', p: 5, f: 10 });
    // 依赖表缺(null)/ 坏(rejects)→ 抛(失败即关;从前折成 p:null / f:0 是把坏表当空表)
    await expect(materializeRow(t, t.rows[0], async () => null)).rejects.toThrow(/库存.db.*not found/);
    await expect(materializeRow(t, t.rows[0], async () => { throw new Error('bad json'); })).rejects.toThrow(/库存.db.*bad json/);
  });
});

// ── E7 + §6.1 drain ──────────────────────────────────────────────────────────

/** 游标身份三件套:一律从规则自己的 cond 抄(手写等于把闸门抄错)。 */
const idy = (t: MuseTrigger): Pick<DbCursor, 'v' | 'path' | 'event' | 'vault'> => {
  const c = t.cond as Extract<MuseTrigger['cond'], { type: 'db_changed' }>;
  return { v: 2, path: c.path, event: c.event, vault: c.vault };
};

/** 「模拟动作」的回报:表路径 → 精确因果(与 applyDbAction 的 DbTouch 同形);'busy' = 单飞挡下。 */
type Act = (t: MuseTrigger, ctx?: TriggerContext) => TouchedDbs | 'busy';
const added = (path: string, ...ids: string[]): TouchedDbs => ({ [path]: { addedIds: ids, edited: [] } });

/** 内存世界:表 + 游标 + 规则;launch 用「模拟动作」直接改表并回报 touched;disableTriggers 改规则数组的 enabled。 */
function world(tables: Record<string, DbLike>, triggers: MuseTrigger[], act: Act) {
  const cursors: Record<string, DbCursor> = {};
  const logs: string[] = [];
  const marked: string[][] = [];
  const launches: Array<{ id: string; row?: string }> = [];
  const deps: DrainDeps = {
    loadTriggers: async () => triggers.map((t) => ({ ...t })),
    loadCursors: async () => ({ ...cursors }),
    setCursors: async (patch) => { Object.assign(cursors, patch); },
    evaluate: evaluateTriggers,
    launch: async (hits: TriggerHit[]): Promise<LaunchResult> => {
      const launched = new Set<string>();
      const touched: Record<string, TouchedDbs> = {};
      const busy = new Set<string>();
      for (const h of hits) {
        if (busy.has(h.t.id)) continue;
        const r = act(h.t, h.ctx);
        if (r === 'busy') { busy.add(h.t.id); continue; }
        launches.push({ id: h.t.id, row: h.ctx?.row?.id });
        launched.add(h.t.id);
        for (const [p, touch] of Object.entries(r)) {
          const acc = (touched[h.t.id] ??= {});
          const into = (acc[p] ??= { addedIds: [], edited: [] });
          for (const rid of touch.addedIds) if (!into.addedIds.includes(rid)) into.addedIds.push(rid);
          into.edited.push(...touch.edited);
        }
      }
      // ⚠️ 只撤 launched,**不删 touched** —— 与真 launchAutomationTriggers 的 M6 语义逐字一致:
      // busy 的规则本轮有 hit 没跑成 → 不 ack(那些行别当已消费);但**已跑成**的 hit 真写了表,
      // 自写因果丢掉 = 下一 tick 把自己刚写的行当成外部事件再触发一次。两件事互不相干。
      // (第四轮补:这行 `delete touched[id]` 是 M6 从真实现里删掉的那句,台架里留着 = 把错误语义固化进夹具。)
      for (const id of busy) launched.delete(id);
      return { launched: [...launched], touched };
    },
    // 与 automation.advanceSelfCursors 同算法的内存版:按精确因果**合并**(真函数的 io 注入版在下面单独测)
    advanceSelfCursors: async (touched) => {
      for (const [id, byPath] of Object.entries(touched)) {
        const t = triggers.find((x) => x.id === id);
        if (!t || t.cond.type !== 'db_changed') continue;
        const touch = byPath[t.cond.path];
        const cur = cursors[id];
        if (!touch || !cur) continue;
        // ⚠️ 与真函数同款:合并出来的游标必须原样带上身份三件套(展开 cur),丢一个字段 = 下轮判不符白重播种
        if (t.cond.event === 'row_added') cursors[id] = { ...cur, rowIds: [...new Set([...(cur.rowIds ?? []), ...touch.addedIds])] };
        else {
          const cells = { ...(cur.cells ?? {}) };
          for (const e of touch.edited) if (e.colId === t.cond.columnId && Object.hasOwn(cells, e.rowId)) cells[e.rowId] = e.key;
          cursors[id] = { ...cur, cells };
        }
      }
    },
    markTriggersFired: async (ids) => { marked.push(ids); },
    disableTriggers: async (ids, reason) => { for (const t of triggers) if (ids.includes(t.id)) { t.enabled = false; t.disabledReason = reason; } },
    activityLines: [],
    currentVault: VAULT,
    readDbFile: async (rel) => tables[rel] ?? null,
    log: (m) => logs.push(m),
  };
  /** 播游标:身份三件套(v/path/event/vault)一律从规则自己的 cond 抄 —— 测试里手写等于把闸门抄错。 */
  const seed = (id: string, part: Partial<DbCursor>): void => {
    const c = triggers.find((t) => t.id === id)?.cond as Extract<MuseTrigger['cond'], { type: 'db_changed' }>;
    if (!c) throw new Error(`seed: 没有规则 ${id}`);
    cursors[id] = { v: 2, path: c.path, vault: c.vault, event: c.event, ...part };
  };
  return { deps, cursors, seed, logs, marked, launches, tables, triggers };
}

const tbl = (rows: Array<{ id: string; cells?: Record<string, unknown> }>): DbLike => ({
  columns: [{ id: 'c1', name: '名称', type: 'text' }, { id: 'c2', name: '状态', type: 'text' }],
  rows: rows.map((r) => ({ id: r.id, cells: r.cells ?? {} })),
});
let seq = 0;
const addRow = (db: DbLike, cells: Record<string, unknown> = {}): string => { const id = `n${++seq}`; db.rows.push({ id, cells }); return id; };

describe('drainAutomation', () => {
  it('自写不可见:规则 A 盯 A.db 又写 A.db → 只跑一次就停(2 轮);负对照:去掉自游标推进 → 一路跑到 cap', async () => {
    const mk = () => {
      const tables = { 'A.db': tbl([{ id: 'r1' }]) };
      const A = rule({ id: 'w-a' });
      const w = world(tables, [A], () => added('A.db', addRow(tables['A.db'])));
      w.seed('w-a', { rowIds: ['r1'] });
      addRow(tables['A.db'], { c1: '用户加的' });
      return w;
    };
    const w = mk();
    const r = await drainAutomation(w.deps);
    expect(r.rounds).toBe(2);
    expect(r.capHit).toBe(false);
    expect(w.launches).toHaveLength(1);
    expect(w.cursors['w-a'].rowIds).toEqual(w.tables['A.db'].rows.map((x) => x.id)); // 自己写的那行已在游标里
    expect(w.marked).toEqual([['w-a']]); // 循环末统一 mark 一次
    // 负对照:自游标不推 → 自己的写入每轮都像新行,只有 cap 能停
    const w2 = mk();
    w2.deps.advanceSelfCursors = async () => {};
    const r2 = await drainAutomation(w2.deps);
    expect(r2.capHit).toBe(true);
    expect(r2.rounds).toBe(DRAIN_MAX_ROUNDS);
    expect(w2.logs.some((l) => l.includes('drain cap hit'))).toBe(true);
  });

  it('跨规则可见 + E7 逐行:A 写 B.db 两行 → B 在第 2 轮命中两次(各自 ctx);全部处理完才停', async () => {
    const tables = { 'A.db': tbl([{ id: 'r1' }]), 'B.db': tbl([]) };
    const A = rule({ id: 'w-a' });
    const B = rule({ id: 'w-b', cond: { type: 'db_changed', path: 'B.db', vault: VAULT, event: 'row_added' } });
    const w = world(tables, [A, B], (t, ctx) => {
      if (t.id === 'w-a') return added('B.db', addRow(tables['B.db'], { c1: `来自 ${ctx?.row?.id} 甲` }), addRow(tables['B.db'], { c1: '乙' }));
      return {}; // B 只 notify
    });
    w.seed('w-a', { rowIds: ['r1'] });
    w.seed('w-b', { rowIds: [] });
    addRow(tables['A.db']);
    const r = await drainAutomation(w.deps);
    expect(w.launches.map((l) => l.id)).toEqual(['w-a', 'w-b', 'w-b']);
    expect(w.launches.slice(1).map((l) => l.row)).toEqual(tables['B.db'].rows.map((x) => x.id));
    expect(r.rounds).toBe(2); // 第 2 轮 B 没写表 → 停
    expect(r.capHit).toBe(false);
    expect(w.cursors['w-b'].rowIds).toEqual(tables['B.db'].rows.map((x) => x.id));
    expect(r.launched.sort()).toEqual(['w-a', 'w-b']);
  });

  it('§6.1 环:A→B→A 必须在 20 轮停下并 log;负对照:cap 注入 45 → 跑到 45 轮(说明没有 cap 就跑飞)', async () => {
    const mk = () => {
      const tables = { 'A.db': tbl([{ id: 'r1' }]), 'B.db': tbl([]) };
      const A = rule({ id: 'w-a' });
      const B = rule({ id: 'w-b', cond: { type: 'db_changed', path: 'B.db', vault: VAULT, event: 'row_added' } });
      const w = world(tables, [A, B], (t) => (t.id === 'w-a' ? added('B.db', addRow(tables['B.db'])) : added('A.db', addRow(tables['A.db']))));
      w.seed('w-a', { rowIds: ['r1'] });
      w.seed('w-b', { rowIds: [] });
      addRow(tables['A.db']);
      return w;
    };
    const w = mk();
    const r = await drainAutomation(w.deps);
    expect(r.capHit).toBe(true);
    expect(r.rounds).toBe(20);
    expect(w.logs.filter((l) => l.includes('drain cap hit'))).toHaveLength(1);
    expect(w.launches.length).toBe(20);
    expect(w.marked).toHaveLength(1);
    // 环里的行没有丢:每一轮的写入都被下一轮消费;cap 处最后那次写入留在游标外(规则已停用,用户检查启用后才消费)
    expect(w.cursors['w-a'].rowIds.length + w.cursors['w-b'].rowIds.length).toBe(w.tables['A.db'].rows.length + w.tables['B.db'].rows.length - 1);
    const w2 = mk();
    const r2 = await drainAutomation(w2.deps, { maxRounds: 45 });
    expect(r2.rounds).toBe(45);
    expect(r2.capHit).toBe(true);
    expect(w2.launches.length).toBe(45); // 轮数完全由 cap 钉住 —— 没有 cap 这条链就是无穷
  });

  it('cap 命中 → 停用最后一轮起跑的规则(写 disabledReason)→ 同一世界再 drain 一次 0 命中;负对照:不停用 → 第二次又跑 20 轮', async () => {
    const mk = (disable: boolean) => {
      const tables = { 'A.db': tbl([{ id: 'r1' }]), 'B.db': tbl([]) };
      const A = rule({ id: 'w-a' });
      const B = rule({ id: 'w-b', cond: { type: 'db_changed', path: 'B.db', vault: VAULT, event: 'row_added' } });
      const w = world(tables, [A, B], (t) => (t.id === 'w-a' ? added('B.db', addRow(tables['B.db'])) : added('A.db', addRow(tables['A.db']))));
      w.seed('w-a', { rowIds: ['r1'] });
      w.seed('w-b', { rowIds: [] });
      addRow(tables['A.db']);
      if (!disable) delete w.deps.disableTriggers;
      return w;
    };
    const w = mk(true);
    const r1 = await drainAutomation(w.deps);
    expect(r1.capHit).toBe(true);
    expect(r1.disabled).toEqual(['w-b']); // 第 20 轮起跑的是 B(A 在奇数轮、B 在偶数轮)
    expect(w.triggers.find((t) => t.id === 'w-b')).toMatchObject({ enabled: false, disabledReason: expect.stringContaining('自动化环') });
    expect(w.logs.some((l) => l.includes('drain cap hit') && l.includes('已停用规则 w-b') && l.includes('手动启用'))).toBe(true);
    const rowsAfter = w.tables['A.db'].rows.length + w.tables['B.db'].rows.length;
    // 第二个 tick:B 已停用 → B 写的最后一行让 A 跑一次(A 写 B.db),B 不再接 → 2 轮即停,表不再无限增长
    const r2 = await drainAutomation(w.deps);
    expect(r2.capHit).toBe(false);
    expect(w.launches.slice(20).map((l) => l.id)).toEqual(['w-a']);
    expect(w.tables['A.db'].rows.length + w.tables['B.db'].rows.length).toBe(rowsAfter + 1);
    const r3 = await drainAutomation(w.deps);
    expect(r3.launched).toEqual([]); // 第三个 tick:0 命中
    // 负对照:没有停用 → 每个 tick 都续跑 20 轮,表每 tick 长 20 行(这就是「cap 挡不住跨 tick 的环」)
    const w2 = mk(false);
    await drainAutomation(w2.deps);
    const n = w2.tables['A.db'].rows.length + w2.tables['B.db'].rows.length;
    const again = await drainAutomation(w2.deps);
    expect(again.capHit).toBe(true);
    expect(w2.tables['A.db'].rows.length + w2.tables['B.db'].rows.length).toBe(n + 20);
    expect(w2.triggers.every((t) => t.enabled)).toBe(true);
  });

  it('精确因果合并:R 盯 T 且写 T,同批 S 也写 T 一行 → R 下一轮能看见 S 的行(整表重读会把它吞进 R 的游标)', async () => {
    const tables = { 'A.db': tbl([{ id: 'a1' }]), 'T.db': tbl([{ id: 't1' }]) };
    const R = rule({ id: 'w-r', cond: { type: 'db_changed', path: 'T.db', vault: VAULT, event: 'row_added' } });
    const S = rule({ id: 'w-s' });
    let sRow = '';
    const w = world(tables, [R, S], (t) => {
      if (t.id === 'w-r') return added('T.db', addRow(tables['T.db'], { c1: 'R 写的' }));
      sRow = addRow(tables['T.db'], { c1: 'S 写的' });
      return added('T.db', sRow);
    });
    w.seed('w-r', { rowIds: ['t1'] });
    w.seed('w-s', { rowIds: ['a1'] });
    addRow(tables['A.db']); // 用户加一行 → S
    addRow(tables['T.db']); // 用户加一行 → R
    const r = await drainAutomation(w.deps);
    expect(w.launches.slice(0, 2).map((l) => l.id).sort()).toEqual(['w-r', 'w-s']); // 同批
    expect(w.launches.slice(2)).toEqual([{ id: 'w-r', row: sRow }]); // 第 2 轮 R 只看见 S 写的那行(自己写的不可见)
    expect(r.rounds).toBe(3);
    expect(r.capHit).toBe(false);
    expect(w.cursors['w-r'].rowIds).toEqual(tables['T.db'].rows.map((x) => x.id)); // 收尾:全消费
    // 负对照(实跑过):world 的 advanceSelfCursors 换回 cursorFor(整表)→ launches 只有 2 条(S 的行被 R 的游标吞掉)→ 红
  });

  it('让位/单飞:launched 为空但命中非空 → 立刻退出且不 ack(下轮重来);busy 的规则整条不 ack', async () => {
    const tables = { 'A.db': tbl([{ id: 'r1' }]) };
    const w = world(tables, [rule({ id: 'w-a' })], () => 'busy');
    w.seed('w-a', { rowIds: ['r1'] });
    addRow(tables['A.db']);
    const r = await drainAutomation(w.deps);
    expect(r.rounds).toBe(1);
    expect(w.cursors['w-a'].rowIds).toEqual(['r1']); // 没 ack:新行下轮还能触发(S0)
    expect(w.marked).toEqual([]);
    expect(w.logs.some((l) => l.includes('无一起跑'))).toBe(true);
    // 负对照:整批让位时若 ack 了游标,这行就永久丢 —— 下一次 drain 必须还能命中
    const w2 = world(tables, [rule({ id: 'w-a' })], () => []);
    Object.assign(w2.cursors, w.cursors);
    const r2 = await drainAutomation(w2.deps);
    expect(w2.launches).toHaveLength(1);
    expect(r2.launched).toEqual(['w-a']);
  });

  it('非 db 规则只评估一次;Muse 唤醒类跨轮去重且游标视同已接受;没命中的规则基线立即提交', async () => {
    const tables = { 'A.db': tbl([{ id: 'r1' }]), 'C.db': tbl([{ id: 'x' }]) };
    const A = rule({ id: 'w-a' });
    const M = rule({ id: 'w-m', actions: undefined, cond: { type: 'db_changed', path: 'A.db', vault: VAULT, event: 'row_added' } }); // 无 actions → 唤醒 Muse
    const F = rule({ id: 'w-f', cond: { type: 'file_chars_gte', path: '/x', n: 1 } });
    const C = rule({ id: 'w-c', cond: { type: 'db_changed', path: 'C.db', vault: VAULT, event: 'row_added' } });
    let fileHits = 0;
    const w = world(tables, [A, M, F, C], (t) => { if (t.id === 'w-a') return added('A.db', addRow(tables['A.db'])); if (t.id === 'w-f') fileHits++; return {}; });
    w.deps.evaluate = (trs, env) => evaluateTriggers(trs, { ...env, readFileChars: async () => 5 });
    w.seed('w-a', { rowIds: ['r1'] });
    w.seed('w-m', { rowIds: ['r1'] });
    w.seed('w-c', { rowIds: ['x', 'gone'] }); // C 表删过一行:没命中也要把基线跟上(gone 掉出游标)
    addRow(tables['A.db']);
    const r = await drainAutomation(w.deps);
    expect(fileHits).toBe(1); // 第 2 轮只评估 db_changed,file 规则不会再发
    expect(r.museFired.map((t) => t.id)).toEqual(['w-m']); // A 自写的行第 2 轮又让 M 命中一次,去重后一条
    expect(w.cursors['w-m'].rowIds).toEqual(tables['A.db'].rows.map((x) => x.id)); // M 的游标已跟到表尾
    expect(w.cursors['w-c'].rowIds).toEqual(['x']);
    expect(r.launched.sort()).toEqual(['w-a', 'w-f']);
  });

  // H4(2026-09-02):把 automationDrain.ts 那条「loadTriggers 必须先于 loadCursors」的注释变成仪器。
  // 它是 P0-2「停用→启用不引爆」的唯一 race-free 依据(upsertTrigger 是「先 dropCursors 再 saveTriggers」,
  // 所以任何读到 enabled:true 的 drain 必然在 drop 之后才读游标),从前只由一行注释守着 —— 调换两行,
  // 停用期间的积压会一次全部打出去,而 cursorMismatch 逐字相符、零日志,仓里没有任何测试会红。
  it('H4 承重不变式:每一轮都必须 loadTriggers 在先、loadCursors 在后(调换即积压一次引爆)', async () => {
    const tables = { 'A.db': tbl([{ id: 'r1' }]) };
    const w = world(tables, [rule({ id: 'w-a' })], () => added('A.db', addRow(tables['A.db'])));
    w.seed('w-a', { rowIds: ['r1'] });
    addRow(tables['A.db']);
    const order: string[] = [];
    const { loadTriggers: lt, loadCursors: lc } = w.deps;
    w.deps.loadTriggers = async () => { order.push('loadTriggers'); return lt(); };
    w.deps.loadCursors = async () => { order.push('loadCursors'); return lc(); };
    const r = await drainAutomation(w.deps);
    expect(r.rounds).toBe(2); // 自写不可见 → 第 2 轮无命中退出
    // 逐轮成对,且每一对里 triggers 在先(drain 每轮都重载,只钉第 1 轮等于漏掉后面所有轮)
    expect(order).toEqual(['loadTriggers', 'loadCursors', 'loadTriggers', 'loadCursors']);
    for (let i = 0; i < order.length; i += 2) expect(order.slice(i, i + 2)).toEqual(['loadTriggers', 'loadCursors']);
  });

  it('db 纯动作链的用户冷却在 drain 内也生效(第 2 轮不因 lastFiredAt 未落盘而复触)', async () => {
    const tables = { 'A.db': tbl([{ id: 'r1' }]), 'B.db': tbl([]) };
    const A = rule({ id: 'w-a', cooldownHours: 1 });
    const B = rule({ id: 'w-b', cond: { type: 'db_changed', path: 'B.db', vault: VAULT, event: 'row_added' } });
    const w = world(tables, [A, B], (t) => (t.id === 'w-a' ? added('B.db', addRow(tables['B.db'])) : added('A.db', addRow(tables['A.db']))));
    w.seed('w-a', { rowIds: ['r1'] });
    w.seed('w-b', { rowIds: [] });
    addRow(tables['A.db']);
    const r = await drainAutomation(w.deps);
    // A(1 轮)→ B 写 A.db(2 轮)→ A 在冷却期内不再命中 → 3 轮评估无命中退出
    expect(w.launches.map((l) => l.id)).toEqual(['w-a', 'w-b']);
    expect(r.capHit).toBe(false);
  });
});

// ── 真 io:advanceSelfCursors / upsertTrigger 插件 / runActions 链路 ─────────────

describe('真 io', () => {
  let vault = '';
  let real: typeof import('./automation.js');
  let amadeus: typeof import('./amadeusDb.js');
  let cursorsMod: typeof import('./dbCursors.js');
  beforeAll(async () => {
    process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-v3-'));
    vault = mkdtempSync(join(tmpdir(), 'tangu-v3-vault-'));
    process.env.FORSION_AMADEUS_VAULT = vault;
    delete process.env.TANGU_USER_ID;
    const { configureTangu } = await import('../seams/runtime.js');
    const { createTanguProfile } = await import('../profiles/index.js');
    const { createSqliteHost } = await import('../adapters/standalone/sqliteHost.js');
    const { toSqliteDDL } = await import('../core/dialectDDL.js');
    const { STANDALONE_SCHEMA } = await import('../db/schemaStandalone.js');
    const { runMigration } = await import('../db/migrate.js');
    const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'local' });
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
    await runMigration();
    real = await import('./automation.js');
    amadeus = await import('./amadeusDb.js');
    cursorsMod = await import('./dbCursors.js');
    mkdirSync(join(vault, 'erp'), { recursive: true });
    // 文件放在 erp/ 下,夹具里的 refDb 要跟着带前缀(rowFrom 的信任边界按 refDb == 动作 path 比)
    const erp = (db: DbFile): DbFile => ({ ...db, columns: db.columns.map((c) => (c.refDb ? { ...c, refDb: `erp/${c.refDb}` } : c)) });
    writeFileSync(join(vault, 'erp', '库存.db'), amadeus.serializeDb(erp(stock())));
    writeFileSync(join(vault, 'erp', '出库.db'), amadeus.serializeDb(erp(outbound())));
    writeFileSync(join(vault, 'erp', '订单.db'), amadeus.serializeDb(erp(orders())));
  });
  const readTable = (name: string): DbFile => JSON.parse(readFileSync(join(vault, 'erp', name), 'utf8'));

  it('runActions → touched 只含真写过的表及精确因果(skipped 不算);launchAutomationTriggers 回报 launched/touched', async () => {
    const t = rule({
      id: 'w-real',
      cond: { type: 'db_changed', path: 'erp/订单.db', vault, event: 'row_added' },
      actions: [
        { type: 'db_row_add', path: 'erp/出库.db', cells: { 配件: '{{row.CPU}}', 订单总表: '{{row.id}}', 出库数量: '1' }, skipIfEmpty: '配件' },
        { type: 'db_row_add', path: './erp/出库.db', cells: { 配件: '{{row.显示器}}', 订单总表: '{{row.id}}' }, skipIfEmpty: '配件' },
        { type: 'db_row_edit', path: 'erp/库存.db', rowFrom: 'CPU', cells: { 锁单数量: '{{= {target.锁单数量} + 1 }}' } },
      ],
    });
    const ctx = rowCtx({ CPU: 's1', 显示器: '', cpu: 's1' }, { CPU: 's1', 显示器: '', cpu: 's1' }, 'o1', 'erp/订单.db');
    const r = await real.launchAutomationTriggers([{ t, ctx }]);
    expect(r.launched).toEqual(['w-real']);
    expect(Object.keys(r.touched['w-real']).sort()).toEqual(['erp/出库.db', 'erp/库存.db']); // 路径归一(./ 压掉);skipped 那步不算
    const addedId = readTable('出库.db').rows.at(-1)!.id;
    expect(r.touched['w-real']['erp/出库.db']).toEqual({ addedIds: [addedId], edited: [] });
    expect(r.touched['w-real']['erp/库存.db']).toEqual({ addedIds: [], edited: [{ rowId: 's1', colId: 'lock', key: '2' }] });
    expect(readTable('出库.db').rows.at(-1)!.cells).toMatchObject({ part: 's1', ord: 'o1', qty: 1 });
    expect(readTable('出库.db').rows).toHaveLength(4); // 显示器槽位空 → 没建行
    expect(readTable('库存.db').rows[0].cells.lock).toBe(2);
    const ledger = await real.listExecutions('w-real');
    expect(ledger[0].steps.map((s) => s.ok)).toEqual([true, true, true]);
    expect(ledger[0].steps[1].skipped).toBe(true);
  });

  it('runActions 写投影列(真 io)→ 对侧表因果并进 touched[对侧表] 且标 mirror;本表零写不进 touched;磁盘无投影 cell;账本 summary 记 mirrored', async () => {
    const st = readTable('库存.db');
    st.columns.push({ id: 'links', name: '出库(投影)', type: 'lookup', refDb: 'erp/出库.db', lookupBackCol: 'part', lookupKind: 'links' });
    writeFileSync(join(vault, 'erp', '库存.db'), amadeus.serializeDb(st));
    const t = rule({
      id: 'w-proj',
      cond: { type: 'db_changed', path: 'erp/出库.db', vault, event: 'cell_changed', columnId: 'part' },
      actions: [{ type: 'db_row_edit', path: 'erp/库存.db', rowId: 's3', cells: { '出库(投影)': 'ob2' } }],
    });
    const r = await real.launchAutomationTriggers([{ t }]);
    expect(r.launched).toEqual(['w-proj']);
    expect(Object.keys(r.touched['w-proj'])).toEqual(['erp/出库.db']); // 本表没落盘 → 不在 touched
    // 现状 s3 ← ob3.part;目标 [ob2] → ob2 覆盖为 s3、ob3 摘掉(单值列删键)
    expect(r.touched['w-proj']['erp/出库.db']).toEqual({ addedIds: [], edited: [{ rowId: 'ob2', colId: 'part', key: 's3' }, { rowId: 'ob3', colId: 'part', key: '' }], mirror: true });
    const out = readTable('出库.db');
    expect(out.rows.find((x) => x.id === 'ob2')!.cells.part).toBe('s3');
    expect('part' in out.rows.find((x) => x.id === 'ob3')!.cells).toBe(false);
    expect(readTable('库存.db').rows.every((x) => !('links' in x.cells))).toBe(true);
    const ledger = await real.listExecutions('w-proj');
    expect(ledger[0].steps[0].ok).toBe(true);
    expect(ledger[0].steps[0].summary).toMatch(/mirrored 2 link cell\(s\) to erp\/出库\.db/);
  });

  it('advanceSelfCursors(真函数,注入 io):只对本规则自己盯且写过的表**合并**因果;别的规则不动;未播种跳过', async () => {
    const A = rule({ id: 'w-self', cond: { type: 'db_changed', path: 'erp/出库.db', vault, event: 'row_added' } });
    const B = rule({ id: 'w-other', cond: { type: 'db_changed', path: 'erp/出库.db', vault, event: 'row_added' } });
    const C = rule({ id: 'w-elsewhere', cond: { type: 'db_changed', path: 'erp/订单.db', vault, event: 'cell_changed', columnId: 'st' } });
    const D = rule({ id: 'w-unseeded', cond: { type: 'db_changed', path: 'erp/出库.db', vault, event: 'row_added' } });
    const patches: Record<string, DbCursor>[] = [];
    const io = {
      loadTriggers: async () => [A, B, C, D],
      loadCursors: async () => ({
        'w-self': { ...idy(A), rowIds: ['ob1', 'ob2', 'ob3'] },
        'w-other': { ...idy(B), rowIds: ['ob1'] },
        'w-elsewhere': { ...idy(C), cols: ['st'], cells: { o1: '未确认', o2: '未确认' } }, // 单列游标也带 cols(n=1 也带)
      }),
      setCursors: async (p: Record<string, DbCursor>) => { patches.push(p); },
      currentVault: vault,
    };
    const touch = (t: Partial<DbTouch>): DbTouch => ({ addedIds: [], edited: [], ...t });
    await real.advanceSelfCursors({
      'w-self': { './erp/出库.db': touch({ addedIds: ['mine', 'ob1'] }) },
      'w-other': { 'erp/库存.db': touch({ addedIds: ['x'] }) },
      'w-elsewhere': { 'erp/订单.db': touch({ edited: [{ rowId: 'o1', colId: 'st', key: '已确认' }, { rowId: 'o2', colId: 'cust', key: '别的列' }, { rowId: 'new', colId: 'st', key: '新行' }] }) },
      'w-unseeded': { 'erp/出库.db': touch({ addedIds: ['y'] }) },
    }, io);
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0]).sort()).toEqual(['w-elsewhere', 'w-self']); // other 写的不是自己盯的表 → 不推;unseeded 无游标 → 跳过
    // 合并:只 append 自己新增的(已在游标里的不重复);表里别人加的 4th 行(上一用例 w-real 写的)**不在**游标里 → 对本规则可见
    expect(patches[0]['w-self'].rowIds).toEqual(['ob1', 'ob2', 'ob3', 'mine']);
    expect(readTable('出库.db').rows).toHaveLength(4);
    // cell_changed:只改监听列(st)的已知行;别的列 / 新行不动
    expect(patches[0]['w-elsewhere'].cells).toEqual({ o1: '已确认', o2: '未确认' });
    expect(patches[0]['w-elsewhere'].cols).toEqual(['st']); // 合并后 cols 必须跟着走,丢了下轮当未播种
    // 负对照(实跑过):改回整表重读(cursorFor)→ w-self.rowIds 变成表里 4 行(把 w-real 写的那行吞了)→ 红
    await real.advanceSelfCursors({}, io);
    expect(patches).toHaveLength(1);
    // 缺省 io 走真 dbCursors 文件(TANGU_HOME 已指到 tmp)
    await cursorsMod.setCursors({ 'w-self': { ...idy(A), rowIds: ['ob1'] } });
    await real.advanceSelfCursors({ 'w-self': { 'erp/出库.db': touch({ addedIds: ['z'] }) } }, { ...io, loadCursors: cursorsMod.loadCursors, setCursors: cursorsMod.setCursors });
    expect((await cursorsMod.loadCursors())['w-self']?.rowIds).toEqual(['ob1', 'z']);
  });

  it('F1 advanceSelfCursors 多列:只换本列那一格,其余列 key 原样,cols 跟着走;游标形状不符(旧单列游标 × 多列规则)不合并', async () => {
    const M = rule({ id: 'w-multi', cond: { type: 'db_changed', path: 'erp/订单.db', vault, event: 'cell_changed', columnId: 'cust', columnIds: ['cust', 'st'] } });
    const S = rule({ id: 'w-stale', cond: { type: 'db_changed', path: 'erp/订单.db', vault, event: 'cell_changed', columnId: 'cust', columnIds: ['cust', 'st'] } });
    const patches: Record<string, DbCursor>[] = [];
    const io = {
      loadTriggers: async () => [M, S],
      loadCursors: async () => ({
        'w-multi': { ...idy(M), cols: ['cust', 'st'], cells: { o1: '甲\u001f未确认', o2: '乙\u001f未确认' } },
        'w-stale': { ...idy(S), cells: { o1: '甲', o2: '乙' } }, // 改成多列前的旧游标:身份对但缺 cols
      }),
      setCursors: async (p: Record<string, DbCursor>) => { patches.push(p); },
      currentVault: vault,
    };
    const edited = [
      { rowId: 'o1', colId: 'st', key: '已确认' },
      { rowId: 'o2', colId: 'cust', key: '丙' },
      { rowId: 'o1', colId: 'other', key: '不盯的列' },
      { rowId: 'new', colId: 'st', key: '新行' },
    ];
    await real.advanceSelfCursors({ 'w-multi': { 'erp/订单.db': { addedIds: [], edited } }, 'w-stale': { 'erp/订单.db': { addedIds: [], edited } } }, io);
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0])).toEqual(['w-multi']); // stale:形状不符不合并(评估侧会重播种)
    expect(patches[0]['w-multi']).toEqual({ ...idy(M), cols: ['cust', 'st'], cells: { o1: '甲\u001f已确认', o2: '丙\u001f未确认' } });
    expect(patches[0]['w-multi'].path).toBe('erp/订单.db'); // 身份三件套必须原样跟着走(丢了下轮判不符白重播种)
    // 负对照(实跑过):合并处改回 `e.colId !== String(c.columnId)` + `cells[e.rowId] = e.key` → o1 变成裸 '已确认'(丢了 cust 那格,下轮当成「变了」自触发)→ 红
  });

  it('launcher 兜底:旧式 agentSlug 规则任一 hit 未起跑(agent 不存在)→ 整条不进 launched/touched', async () => {
    const t = rule({ id: 'w-llm', actions: undefined, agentSlug: 'no-such-agent', cond: { type: 'db_changed', path: 'erp/订单.db', vault, event: 'row_added' } });
    const r = await real.launchAutomationTriggers([{ t, ctx: rowCtx({}, {}, 'o1', 'erp/订单.db') }, { t, ctx: rowCtx({}, {}, 'o2', 'erp/订单.db') }]);
    expect(r.launched).toEqual([]);
    expect(r.touched).toEqual({});
    // 负对照(实跑过):去掉 `else busy.add(t.id)` 且让第一个 hit ok —— 本用例 agent 不存在两 hit 都 false,旧代码也不进 launched;
    // 真正的 N-1 吞行在评估侧已由「hasLLM 只取一行」堵住(automationDb.test 有负对照)
  });

  it('★ M5 fireTrigger(面板试跑 / 按钮块):跑完必须推本规则自游标 —— 否则「试跑」= 下一 tick 真跑第二遍', async () => {
    // 规则盯出库表,动作又往出库表加行(自写不可见的正例)。试跑写进去的那行若不进自己的游标,
    // 下一次巡检就把它当成外部事件,整条链(含 notify / 写别的表)再跑一遍。
    const t = rule({
      id: 'w-m5',
      cond: { type: 'db_changed', path: 'erp/出库.db', vault, event: 'row_added' },
      actions: [{ type: 'db_row_add', path: 'erp/出库.db', cells: { 配件: 's1', 出库数量: '1' } }],
    });
    const file = join(process.env.TANGU_HOME!, 'agents', 'muse', 'triggers.json');
    writeFileSync(file, JSON.stringify([t]));
    const before = readTable('出库.db').rows.map((r) => r.id);
    await cursorsMod.setCursors({ 'w-m5': { v: 2, path: 'erp/出库.db', event: 'row_added', vault, rowIds: before } });
    const r = await real.fireTrigger(t, 'manual');
    expect(r.status).toBe('done');
    const added = readTable('出库.db').rows.map((x) => x.id).filter((x) => !before.includes(x));
    expect(added).toHaveLength(1);
    // ★ 试跑写的那行进了自己的游标 → 下一 tick 它不是「新行」
    expect((await cursorsMod.loadCursors())['w-m5']?.rowIds).toEqual([...before, ...added]);
    const stillNew = await evaluateTriggers([t], {
      now: new Date(), currentVault: vault,
      dbCursors: await cursorsMod.loadCursors(), outDbCursors: {},
      readDbFile: async (rel) => (normalizeVaultRel(rel) === 'erp/出库.db' ? (readTable('出库.db') as DbLike) : null),
    });
    expect(stillNew).toEqual([]); // 负对照:把 fireTrigger 里的 advanceSelfCursors 去掉 → 这里变成命中 1 条
  });

  it('★ M6 launchAutomationTriggers(注入 LaunchIo):同规则有 hit 被单飞挡下 → 不进 launched,但**已跑成**那几个 hit 的自写因果照样回报', async () => {
    // 「不 ack」与「合并自写因果」是两件事:前者管「没处理的行别当已消费」,后者管「处理过的写入别当别人的改动」。
    // 连坐删掉 touched → 下一 tick 把自己刚写的行当成外部事件再触发一次(纯动作链无冷却时就是自激)。
    const t = rule({ id: 'w-m6', cond: { type: 'db_changed', path: 'erp/订单.db', vault, event: 'row_added' } });
    const seen: string[] = [];
    const io = {
      runActions: (async (rt: MuseTrigger, _o: unknown, ctx?: TriggerContext) => {
        seen.push(String(ctx?.row?.id));
        return ctx?.row?.id === 'o1'
          ? { execId: 'e1', status: 'done' as const, steps: [], touched: { 'erp/出库.db': { addedIds: ['x1'], edited: [] } } }
          : { execId: '', status: 'busy' as const, steps: [], touched: {} };
      }) as unknown as typeof real.runActions,
    };
    const r = await real.launchAutomationTriggers(
      [{ t, ctx: rowCtx({}, {}, 'o1', 'erp/订单.db') }, { t, ctx: rowCtx({}, {}, 'o2', 'erp/订单.db') }],
      io,
    );
    expect(seen).toEqual(['o1', 'o2']);
    expect(r.launched).toEqual([]);                       // 有 hit 没跑成 → 整条不 ack
    expect(r.touched['w-m6']).toEqual({ 'erp/出库.db': { addedIds: ['x1'], edited: [] } }); // ★ 但因果不许连坐删掉
    // 负对照:把 `for (const id of busy) launched.delete(id)` 改回 `{ launched.delete(id); delete touched[id] }` → 上一行红
  });

  it('E8 upsertTrigger:plugin: 前缀 id 只在 allowPluginCreate 下幂等创建;形态闸;MAX_TRIGGERS 照查;非插件 id 仍「未找到」', async () => {
    const v = validateTriggerInput({ desc: 'erp 种子', cond_type: 'db_changed', path: 'erp/订单.db', event: 'row_added', vault, actions: [{ type: 'notify', title: 'n' }] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // 不开闸(manage_automation 工具那条路)→ 未找到
    const denied = await upsertTrigger(v.value, 'plugin:pc-erp:order-added');
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining('未找到') });
    // 开闸 → 按该 id 创建;再来一次 = 更新(幂等)
    const created = await upsertTrigger(v.value, 'plugin:pc-erp:order-added', { allowPluginCreate: true });
    expect(created).toMatchObject({ ok: true, created: true, trigger: { id: 'plugin:pc-erp:order-added' } });
    const again = await upsertTrigger({ ...v.value, desc: '改描述' }, 'plugin:pc-erp:order-added', { allowPluginCreate: true });
    expect(again).toMatchObject({ ok: true, created: false, trigger: { desc: '改描述' } });
    expect((await loadTriggers()).filter((t) => t.id === 'plugin:pc-erp:order-added')).toHaveLength(1);
    // 形态闸
    expect(await upsertTrigger(v.value, 'plugin:Pc_Erp:x', { allowPluginCreate: true })).toMatchObject({ ok: false, error: expect.stringContaining('形态') });
    expect(await upsertTrigger(v.value, 'plugin:only-one-seg', { allowPluginCreate: true })).toMatchObject({ ok: false });
    // 非插件 id 即使开闸也不创建
    expect(await upsertTrigger(v.value, 'w-nope', { allowPluginCreate: true })).toMatchObject({ ok: false, error: expect.stringContaining('未找到') });
    // MAX_TRIGGERS 照查:直接把 triggers.json 填满
    const file = join(process.env.TANGU_HOME!, 'agents', 'muse', 'triggers.json');
    const list = JSON.parse(readFileSync(file, 'utf8')) as MuseTrigger[];
    while (list.length < MAX_TRIGGERS) list.push(rule({ id: `w-fill${list.length}` }));
    writeFileSync(file, JSON.stringify(list));
    expect(await upsertTrigger(v.value, 'plugin:pc-erp:another', { allowPluginCreate: true })).toMatchObject({ ok: false, error: expect.stringContaining('上限') });
    // 已存在的插件规则在满额下仍可更新
    expect(await upsertTrigger(v.value, 'plugin:pc-erp:order-added', { allowPluginCreate: true })).toMatchObject({ ok: true, created: false });
  });
});

// ── W2-A 可编辑投影列(lookupKind='links'):写投影 = 翻译成对侧 rowlink 写;对侧因果标 mirror 并入自游标 ──

describe('可编辑投影列(lookupKind=links)', () => {
  const NOW = new Date(2026, 8, 2, 10, 30);
  /** 库存表 + 投影列「出库(投影)」:值 = 出库表里 part 指回本行的行 id;真值只在出库表的 part cell。 */
  const proj = (): DbFile => {
    const s = stock();
    s.columns.push({ id: 'links', name: '出库(投影)', type: 'lookup', refDb: '出库.db', lookupBackCol: 'part', lookupKind: 'links' });
    return s;
  };
  /** memIo + 落盘计数(回调返回 false 不算写)。 */
  const countIo = (tables: Record<string, DbFile>) => {
    const io = memIo(tables);
    const writes: Record<string, number> = {};
    io.mutateDb = async (rel, fn) => {
      const db = tables[normalizeVaultRel(rel)];
      if (!db) throw new Error(`no such table ${rel}`);
      if (fn(db) !== false) writes[normalizeVaultRel(rel)] = (writes[normalizeVaultRel(rel)] ?? 0) + 1;
    };
    return { io, writes };
  };
  const parts = (t: DbFile): Array<string | null> => t.rows.map((r) => (r.cells.part as string | undefined) ?? null);

  it('db_row_edit 写投影列 → 对侧表恰好 mutate 一次(整格赋值:多的摘少的加),本表零写盘且磁盘无投影 cell;因果在 mirrors 且标 mirror', async () => {
    const tables = { '库存.db': proj(), '出库.db': outbound() };
    const { io, writes } = countIo(tables);
    // 现状 s1 ← ob1.part;目标 [ob2, ob3] → ob1 摘掉(单值列删键)、ob2/ob3 覆盖为 s1
    const edit = (v: string): DbActionSpec => ({ type: 'db_row_edit', path: '库存.db', rowId: 's1', cells: { '出库(投影)': v } });
    const r = await applyDbAction(edit('ob2, ob3'), undefined, io, NOW);
    expect(writes).toEqual({ '出库.db': 1 });
    expect(parts(tables['出库.db'])).toEqual([null, 's1', 's1']);
    expect('links' in tables['库存.db'].rows[0].cells).toBe(false);
    expect(r.touch).toEqual({ addedIds: [], edited: [] }); // 本表没动
    expect(r.mirrors).toEqual([{ path: '出库.db', touch: { addedIds: [], edited: [
      { rowId: 'ob1', colId: 'part', key: '' }, { rowId: 'ob2', colId: 'part', key: 's1' }, { rowId: 'ob3', colId: 'part', key: 's1' },
    ], mirror: true } }]);
    expect(r.summary).toMatch(/mirrored 3 link cell\(s\) to 出库\.db/);
    // 幂等:同值再写 → 对侧不落盘、无 mirrors
    const r2 = await applyDbAction(edit('ob3, ob2'), undefined, io, NOW);
    expect(writes).toEqual({ '出库.db': 1 });
    expect(r2.mirrors).toBeUndefined();
    // 混合:普通列 + 投影列 → 本表写 1 次(只落普通列),对侧写 1 次;空串 = 全摘
    const r3 = await applyDbAction({ type: 'db_row_edit', path: '库存.db', rowId: 's1', cells: { 数量: '9', '出库(投影)': '' } }, undefined, io, NOW);
    expect(writes).toEqual({ '出库.db': 2, '库存.db': 1 });
    expect(tables['库存.db'].rows[0].cells.q).toBe(9);
    expect(r3.touch.edited).toEqual([{ rowId: 's1', colId: 'q', key: '9' }]);
    expect(parts(tables['出库.db'])).toEqual([null, null, null]);
    // 拒:目标行不存在 → 抛,对侧不写(绝不报成功但什么都没改)
    await expect(applyDbAction(edit('nope'), undefined, io, NOW)).rejects.toThrow(/nope not found in 出库\.db/);
    expect(writes).toEqual({ '出库.db': 2, '库存.db': 1 });
  });

  it('对侧 backCol 不是 rowlink 列 → 抛;多值 backCol 追加成数组,key 按 join(\'\') 与游标同口径;变了的对侧行盖 updated 章进 mirror 因果', async () => {
    const tables = { '库存.db': proj(), '出库.db': outbound() };
    tables['库存.db'].columns.push({ id: 'links2', name: '标签(投影)', type: 'lookup', refDb: '出库.db', lookupBackCol: 'qty', lookupKind: 'links' });
    const { io, writes } = countIo(tables);
    await expect(applyDbAction({ type: 'db_row_edit', path: '库存.db', rowId: 's1', cells: { '标签(投影)': 'ob1' } }, undefined, io, NOW))
      .rejects.toThrow(/"qty" in 出库\.db is not a relation/);
    expect(writes).toEqual({});
    // 多值:出库表加一个多选 rowlink 列 tags + updated 章列,投影指向它
    tables['出库.db'].columns.push({ id: 'tags', name: '标签', type: 'rowlink', refDb: '库存.db', multiple: true }, { id: 'up', name: '修改时间', type: 'updated' });
    tables['出库.db'].rows[0].cells.tags = ['s2'];
    tables['库存.db'].columns.find((c) => c.id === 'links2')!.lookupBackCol = 'tags';
    const r = await applyDbAction({ type: 'db_row_edit', path: '库存.db', rowId: 's1', cells: { '标签(投影)': 'ob1, ob2' } }, undefined, io, NOW);
    expect(tables['出库.db'].rows[0].cells.tags).toEqual(['s2', 's1']);
    expect(tables['出库.db'].rows[1].cells.tags).toEqual(['s1']);
    // key 必须与游标播种(cursorFor → cellKeyOf,数组 join(''))逐字同,否则多值列的自写下一轮被当成别人的改动
    const seeded = cursorFor({ type: 'db_changed', path: '出库.db', vault: VAULT, event: 'cell_changed', columnId: 'tags' }, tables['出库.db'] as unknown as DbLike)!;
    expect(r.mirrors![0].touch.edited.find((e) => e.rowId === 'ob1' && e.colId === 'tags')!.key).toBe(seeded.cells!.ob1);
    expect(r.mirrors![0].touch.edited).toEqual([
      { rowId: 'ob1', colId: 'tags', key: 's2s1' }, { rowId: 'ob1', colId: 'up', key: '2026-09-02T10:30' },
      { rowId: 'ob2', colId: 'tags', key: 's1' }, { rowId: 'ob2', colId: 'up', key: '2026-09-02T10:30' },
    ]);
    expect(tables['出库.db'].rows[2].cells.up).toBeUndefined(); // 没变的行不盖章
  });

  it('db_row_add 带投影值 → 新行 id 在本表回调后才有,对侧指回它;新行磁盘无投影 cell', async () => {
    const tables = { '库存.db': proj(), '出库.db': outbound() };
    const { io, writes } = countIo(tables);
    const r = await applyDbAction({ type: 'db_row_add', path: '库存.db', cells: { 名称: '电源', '出库(投影)': 'ob3' } }, undefined, io, NOW);
    const nid = r.touch.addedIds[0];
    expect(nid).toBeTruthy();
    expect(writes).toEqual({ '库存.db': 1, '出库.db': 1 });
    expect(tables['库存.db'].rows.at(-1)!.cells).toMatchObject({ n: '电源', no: 8 });
    expect('links' in tables['库存.db'].rows.at(-1)!.cells).toBe(false);
    expect(tables['出库.db'].rows[2].cells.part).toBe(nid);
    expect(r.mirrors).toEqual([{ path: '出库.db', touch: { addedIds: [], edited: [{ rowId: 'ob3', colId: 'part', key: nid }], mirror: true } }]);
  });

  it('mergeTouch:mirror 只在两边都是投影翻译时保留(空 into 视为无来源);直接写 + 投影写混合 → 不标', () => {
    const m = (): DbTouch => ({ addedIds: [], edited: [{ rowId: 'a', colId: 'c', key: '1' }], mirror: true });
    const d = (): DbTouch => ({ addedIds: ['z'], edited: [] });
    expect(mergeTouch(emptyTouch(), m()).mirror).toBe(true);
    expect(mergeTouch(mergeTouch(emptyTouch(), m()), m()).mirror).toBe(true);
    expect(mergeTouch(mergeTouch(emptyTouch(), d()), m()).mirror).toBeUndefined();
    expect(mergeTouch(mergeTouch(emptyTouch(), m()), d()).mirror).toBeUndefined();
  });

  it('drain:规则盯对侧 backCol、动作写本表投影列 → 对侧恰好变一次、只跑一轮不二次触发;负对照 = 丢掉 mirror 因果 → 被自己的投影写再触发一次', async () => {
    const mk = (keepMirror: boolean) => {
      const tables = { '库存.db': proj(), '出库.db': outbound() };
      const R = rule({
        id: 'w-r',
        cond: { type: 'db_changed', path: '出库.db', vault: VAULT, event: 'cell_changed', columnId: 'part' },
        actions: [{ type: 'db_row_edit', path: '库存.db', rowId: 's1', cells: { '出库(投影)': 'ob1, ob2' } }],
      });
      const w = world(tables as unknown as Record<string, DbLike>, [R], () => ({}));
      w.cursors['w-r'] = cursorFor(R.cond as Extract<MuseTrigger['cond'], { type: 'db_changed' }>, tables['出库.db'] as unknown as DbLike)!; // 播种
      tables['出库.db'].rows[1].cells.part = 's3'; // 用户改 ob2:s2 → s3,触发 R
      const io = memIo(tables);
      w.deps.launch = async (hits) => {
        const launched: string[] = [];
        const touched: Record<string, TouchedDbs> = {};
        for (const h of hits) {
          const a = h.t.actions![0] as DbActionSpec;
          const r = await applyDbAction(a, h.ctx, io, NOW);
          w.launches.push({ id: h.t.id, row: h.ctx?.row?.id });
          if (!launched.includes(h.t.id)) launched.push(h.t.id);
          const acc = (touched[h.t.id] ??= {});
          if (r.touch.addedIds.length || r.touch.edited.length) acc[normalizeVaultRel(a.path)] = mergeTouch(acc[normalizeVaultRel(a.path)] ?? emptyTouch(), r.touch);
          if (keepMirror) for (const m of r.mirrors ?? []) acc[m.path] = mergeTouch(acc[m.path] ?? emptyTouch(), m.touch);
        }
        return { launched, touched };
      };
      return { w, tables };
    };
    const { w, tables } = mk(true);
    const r = await drainAutomation(w.deps);
    expect(w.launches).toEqual([{ id: 'w-r', row: 'ob2' }]);
    expect(r.rounds).toBe(2); // 第 2 轮重评估:自己的投影写已在游标里 → 0 命中即停
    expect(r.capHit).toBe(false);
    expect(parts(tables['出库.db'])).toEqual(['s1', 's1', 's3']); // ob2 被投影写指回 s1,恰好一次
    expect(w.cursors['w-r'].cells!.ob2).toBe('s1'); // 自游标已吃掉自己的投影写
    await drainAutomation(w.deps); // 下一 tick:仍不二次触发
    expect(w.launches).toHaveLength(1);
    // 负对照:对侧因果没并进 touched(本表零写 → touched 为空 → drain 不重评估直接停),下一 tick 把自己的投影写当成别人的改动,再触发一次
    const neg = mk(false);
    const r2 = await drainAutomation(neg.w.deps);
    expect(r2.rounds).toBe(1);
    expect(neg.w.launches).toHaveLength(1);
    await drainAutomation(neg.w.deps);
    expect(neg.w.launches).toHaveLength(2);
    expect(neg.w.launches[1]).toEqual({ id: 'w-r', row: 'ob2' }); // 被自己的写再触发(动作幂等 → 第三 tick 才安静)
  });
});
