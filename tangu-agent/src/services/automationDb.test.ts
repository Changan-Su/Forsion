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

/** 游标身份三件套(cursorFor 一律写全;造入参 / 拼期望值共用这一处,手写等于把闸门抄错)。 */
const idy = (event: 'row_added' | 'cell_changed', path = '任务.db') =>
  ({ v: 2 as const, path, vault: VAULT, event });

function db(rows: { id: string; cells: Record<string, unknown> }[]): DbLike {
  return {
    columns: [{ id: 'c1', name: '名称' }, { id: 'c2', name: '状态' }],
    rows,
  };
}

/** tables 的值:表 / null(不存在)/ Error(读炸 → rejects)。 */
async function run(t: MuseTrigger, data: DbLike | null, cursors: Record<string, DbCursor> = {}, tables: Record<string, DbLike | null | Error> = {}) {
  const outDbCursors: Record<string, DbCursor> = {};
  const outContexts: Record<string, TriggerContext> = {};
  const outHits: Array<{ id: string; ctx: TriggerContext }> = [];
  const logs: string[] = [];
  const fired = await evaluateTriggers([t], {
    currentVault: VAULT,
    dbCursors: cursors,
    outDbCursors,
    outContexts,
    outHits,
    today: '2026-09-02',
    log: (m) => logs.push(m),
    // 主表按规则 path 给;lookup 依赖表按路径从 tables 取
    readDbFile: async (rel) => {
      if (rel === (t.cond as any).path) return data;
      const v = tables[rel];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
  });
  return { fired: fired.map((x) => x.id), fireds: fired, outDbCursors, outContexts, outHits, logs };
}

describe('db_changed 触发', () => {
  it('首次只播种,绝不把满表现有行当成「刚加的」', async () => {
    const r = await run(rule({}), db([{ id: 'r1', cells: {} }, { id: 'r2', cells: {} }]));
    expect(r.fired).toEqual([]);
    expect(r.outDbCursors['w-db01']).toEqual({ ...idy('row_added'), rowIds: ['r1', 'r2'] });
  });

  it('row_added:只认游标里没见过的行,并把命中行带进上下文', async () => {
    const r = await run(
      rule({}),
      db([{ id: 'r1', cells: { c1: '旧' } }, { id: 'r9', cells: { c1: '新任务' } }]),
      { 'w-db01': { ...idy('row_added'), rowIds: ['r1'] } },
    );
    expect(r.fired).toEqual(['w-db01']);
    expect(r.outContexts['w-db01'].row?.id).toBe('r9');
    // 列 id 与列名两种键都能取到(列改名不至于当场失效)
    expect(r.outContexts['w-db01'].row?.cells).toMatchObject({ c1: '新任务', 名称: '新任务' });
  });

  it('cell_changed:值变才算;新行归 row_added 管不在这儿重复报', async () => {
    const t = rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c2' } });
    const cur = { 'w-db01': { ...idy('cell_changed'), cols: ['c2'], cells: { r1: '进行中' } } };
    expect((await run(t, db([{ id: 'r1', cells: { c2: '进行中' } }]), cur)).fired).toEqual([]);
    expect((await run(t, db([{ id: 'r1', cells: { c2: '完成' } }]), cur)).fired).toEqual(['w-db01']);
    // r2 是新行(游标里没有)→ 不由 cell_changed 报
    expect((await run(t, db([{ id: 'r1', cells: { c2: '进行中' } }, { id: 'r2', cells: { c2: '完成' } }]), cur)).fired).toEqual([]);
  });

  it('equals 不匹配也要推进游标 —— 不推的话下一轮拿更旧的快照比,结论必错', async () => {
    const t = rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c2', equals: '完成' } });
    const r = await run(t, db([{ id: 'r1', cells: { c2: '进行中' } }]), { 'w-db01': { ...idy('cell_changed'), cols: ['c2'], cells: { r1: '待办' } } });
    expect(r.fired).toEqual([]);
    expect(r.outDbCursors['w-db01']).toEqual({ ...idy('cell_changed'), cols: ['c2'], cells: { r1: '进行中' } });
  });

  it('切库保护:vault 不符整条跳过(否则同路径的另一个库会被静默作用)', async () => {
    const t = rule({ cond: { type: 'db_changed', path: '任务.db', vault: '/别的/库', event: 'row_added' } });
    const r = await run(t, db([{ id: 'r1', cells: {} }, { id: 'r2', cells: {} }]), { 'w-db01': { ...idy('row_added'), rowIds: [] } });
    expect(r.fired).toEqual([]);
    expect(r.outDbCursors['w-db01']).toBeUndefined(); // 连游标都不该动
  });

  it('E7 排空:两行新增 → 同一规则命中两次(同一个对象引用)、outHits 逐行、游标一次消费全表', async () => {
    const r = await run(
      rule({}),
      db([{ id: 'r1', cells: {} }, { id: 'r8', cells: { c1: '甲' } }, { id: 'r9', cells: { c1: '乙' } }]),
      { 'w-db01': { ...idy('row_added'), rowIds: ['r1'] } },
    );
    expect(r.fired).toEqual(['w-db01', 'w-db01']);
    expect(r.fireds[0]).toBe(r.fireds[1]); // muse 侧按 includes 引用相等分流,克隆会静默送去唤醒 Muse
    expect(r.outHits.map((h) => h.ctx.row?.id)).toEqual(['r8', 'r9']);
    expect(r.outContexts['w-db01'].row?.id).toBe('r9'); // 老出参 = 最后一次命中
    expect(r.outDbCursors['w-db01']).toEqual({ ...idy('row_added'), rowIds: ['r1', 'r8', 'r9'] });
  });

  it('E7 cell_changed:多行同时变 → 逐行命中;游标一次跟上全表', async () => {
    const t = rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c2', equals: '完成' } });
    const r = await run(
      t,
      db([{ id: 'r1', cells: { c2: '完成' } }, { id: 'r2', cells: { c2: '完成' } }, { id: 'r3', cells: { c2: '搁置' } }]),
      { 'w-db01': { ...idy('cell_changed'), cols: ['c2'], cells: { r1: '待办', r2: '进行中', r3: '待办' } } },
    );
    expect(r.outHits.map((h) => h.ctx.row?.id)).toEqual(['r1', 'r2']); // r3 变了但 equals 不符
    expect(r.outDbCursors['w-db01']).toEqual({ ...idy('cell_changed'), cols: ['c2'], cells: { r1: '完成', r2: '完成', r3: '搁置' } });
  });

  it('F1 多列监听:两列任一变化都报;where 照常与之 AND;游标带 cols 一次跟上全表', async () => {
    const t = rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c1', columnIds: ['c1', 'c2'] } });
    const cur = { 'w-db01': { ...idy('cell_changed'), cols: ['c1', 'c2'], cells: { r1: '甲\u001f待办', r2: '乙\u001f待办', r3: '丙\u001f待办' } } };
    const r = await run(
      t,
      db([{ id: 'r1', cells: { c1: '甲', c2: '完成' } }, { id: 'r2', cells: { c1: '乙改', c2: '待办' } }, { id: 'r3', cells: { c1: '丙', c2: '待办' } }]),
      cur,
    );
    expect(r.outHits.map((h) => h.ctx.row?.id)).toEqual(['r1', 'r2']); // r1 变 c2、r2 变 c1;r3 没变
    expect(r.outContexts['w-db01'].row?.cells).toMatchObject({ 名称: '乙改', 状态: '待办' });
    expect(r.outDbCursors['w-db01']).toEqual({ ...idy('cell_changed'), cols: ['c1', 'c2'], cells: { r1: '甲\u001f完成', r2: '乙改\u001f待办', r3: '丙\u001f待办' } });
    // where 与多列 AND:只留状态=完成的那行
    const tw = rule({ cond: { ...(t.cond as any), where: [{ column: '状态', op: 'eq', value: '完成' }] } });
    const rw = await run(tw, db([{ id: 'r1', cells: { c1: '甲', c2: '完成' } }, { id: 'r2', cells: { c1: '乙改', c2: '待办' } }, { id: 'r3', cells: { c1: '丙', c2: '待办' } }]), cur);
    expect(rw.outHits.map((h) => h.ctx.row?.id)).toEqual(['r1']);
    // 单列规则(无 columnIds)对同一张表:只看 c2 → 只报 r1;游标是裸 key + 单元素 cols(n=1 也带,自证盯的是哪一列)
    const one = rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c2' } });
    const ro = await run(one, db([{ id: 'r1', cells: { c1: '甲', c2: '完成' } }, { id: 'r2', cells: { c1: '乙改', c2: '待办' } }]), { 'w-db01': { ...idy('cell_changed'), cols: ['c2'], cells: { r1: '待办', r2: '待办' } } });
    expect(ro.outHits.map((h) => h.ctx.row?.id)).toEqual(['r1']);
    expect(JSON.stringify(ro.outDbCursors['w-db01']))
      .toBe(`{"v":2,"path":"任务.db","event":"cell_changed","vault":"${VAULT}","cols":["c2"],"cells":{"r1":"完成","r2":"待办"}}`);
  });

  it('E5 where:与 equals AND;列 id 与列名都能写;empty/notempty/ne', async () => {
    const rows = [{ id: 'r1', cells: {} }, { id: 'r8', cells: { c1: '甲', c2: '' } }, { id: 'r9', cells: { c1: '', c2: '完成' } }];
    const cur = { 'w-db01': { ...idy('row_added'), rowIds: ['r1'] } };
    const w = (where: any[]) => rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'row_added', where } });
    expect((await run(w([{ column: '名称', op: 'notempty' }]), db(rows), cur)).outHits.map((h) => h.ctx.row?.id)).toEqual(['r8']);
    expect((await run(w([{ column: 'c1', op: 'empty' }]), db(rows), cur)).outHits.map((h) => h.ctx.row?.id)).toEqual(['r9']);
    expect((await run(w([{ column: 'c2', op: 'eq', value: '完成' }, { column: 'c1', op: 'empty' }]), db(rows), cur)).fired).toEqual(['w-db01']);
    expect((await run(w([{ column: 'c2', op: 'ne', value: '完成' }]), db(rows), cur)).outHits.map((h) => h.ctx.row?.id)).toEqual(['r8']);
    expect((await run(w([{ column: 'c2', op: 'eq', value: '完成' }, { column: 'c1', op: 'notempty' }]), db(rows), cur)).fired).toEqual([]);
    // 没命中也要消费游标(否则下一轮还报)
    const r = await run(w([{ column: 'c1', op: 'eq', value: '不存在' }]), db(rows), cur);
    expect(r.fired).toEqual([]);
    expect(r.outDbCursors['w-db01']).toEqual({ ...idy('row_added'), rowIds: ['r1', 'r8', 'r9'] });
  });

  it('E1 物化:命中行的 lookup(沿关联取值)与 formula 在上下文里可见,typed 图保持数字', async () => {
    const parts: DbLike = {
      columns: [{ id: 'n', name: '名称', type: 'text' }, { id: 'p', name: '单价', type: 'number' }],
      rows: [{ id: 'p1', cells: { n: 'CPU', p: 1200 } }],
    };
    const orders: DbLike = {
      columns: [
        { id: 'c1', name: '客户', type: 'text' },
        { id: 'rel', name: '配件', type: 'rowlink', refDb: '配件.db' },
        { id: 'lk', name: '单价', type: 'lookup', lookupRel: 'rel', lookupCol: 'p' },
        { id: 'f', name: '含税', type: 'formula', formula: '{单价} * 2' },
        { id: 'qty', name: '数量', type: 'number' },
      ],
      rows: [{ id: 'o1', cells: { c1: '张三', rel: 'p1', qty: 2 } }],
    };
    const t = rule({ cond: { type: 'db_changed', path: '订单.db', vault: VAULT, event: 'row_added', where: [{ column: '单价', op: 'eq', value: '1200' }] } });
    const r = await run(t, orders, { 'w-db01': { ...idy('row_added', '订单.db'), rowIds: [] } }, { '配件.db': parts });
    expect(r.fired).toEqual(['w-db01']); // where 比的是物化后的 lookup 值
    const row = r.outHits[0].ctx.row!;
    expect(row.cells).toMatchObject({ 单价: '1200', 含税: '2400', lk: '1200' });
    expect(row.typed).toMatchObject({ 单价: 1200, 数量: 2, qty: 2 });
    expect(typeof row.typed?.含税).toBe('number');
  });

  it('依赖表读失败即关:rejects / 不存在 → 该规则本轮不命中、游标不变、log 含规则 id 与路径', async () => {
    const parts: DbLike = { columns: [{ id: 'p', name: '单价', type: 'number' }], rows: [{ id: 'p1', cells: { p: 1200 } }] };
    const orders: DbLike = {
      columns: [
        { id: 'rel', name: '配件', type: 'rowlink', refDb: '配件.db' },
        { id: 'lk', name: '单价', type: 'lookup', lookupRel: 'rel', lookupCol: 'p' },
      ],
      rows: [{ id: 'o1', cells: { rel: 'p1' } }],
    };
    // where 只有靠 lookup 值才成立:折成 null 的话 lookup='' → where 不成立 → 「没命中」却消费游标 = 事件永久丢
    const mk = () => rule({ cond: { type: 'db_changed', path: '订单.db', vault: VAULT, event: 'row_added', where: [{ column: '单价', op: 'notempty' }] } });
    const cur = { 'w-db01': { ...idy('row_added', '订单.db'), rowIds: [] } };
    const bad = await run(mk(), orders, cur, { '配件.db': new Error('EACCES: bad json') });
    expect(bad.fired).toEqual([]);
    expect(bad.outDbCursors['w-db01']).toBeUndefined(); // 游标冻住:下轮修好还能命中
    expect(bad.logs.some((l) => l.includes('w-db01') && l.includes('配件.db'))).toBe(true);
    const missing = await run(mk(), orders, cur, { '配件.db': null });
    expect(missing.fired).toEqual([]);
    expect(missing.outDbCursors['w-db01']).toBeUndefined();
    // 对照:依赖表读得到 → 命中且游标推进
    const ok = await run(mk(), orders, cur, { '配件.db': parts });
    expect(ok.fired).toEqual(['w-db01']);
    expect(ok.outDbCursors['w-db01']).toEqual({ ...idy('row_added', '订单.db'), rowIds: ['o1'] });
    // 负对照(实跑过):preloadLookupDbs 改回 `readDb(p).catch(() => null)` 且 null 不抛 → bad 用例 fired 仍 []、但游标被推成 ['o1'] → 红
    // 没有候选行时依赖表根本不读(纯基线推进照常)
    const idle = await run(mk(), orders, { 'w-db01': { ...idy('row_added', '订单.db'), rowIds: ['o1'] } }, { '配件.db': new Error('boom') });
    expect(idle.outDbCursors['w-db01']).toEqual({ ...idy('row_added', '订单.db'), rowIds: ['o1'] });
  });

  it('where 引用不存在 / 二义的列 → 规则错误:本轮跳过、不推游标、log;列名大小写/空白宽容', async () => {
    const rows = [{ id: 'r1', cells: {} }, { id: 'r8', cells: { c1: '甲', c2: '' } }];
    const cur = { 'w-db01': { ...idy('row_added'), rowIds: ['r1'] } };
    const w = (where: any[]) => rule({ cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'row_added', where } });
    // 不存在的列:从前折成 '' → empty 恒真(失败开放)、eq 恒假(静默吞事件);现在两种都不评估
    const open = await run(w([{ column: '不存在', op: 'empty' }]), db(rows), cur);
    expect(open.fired).toEqual([]);
    expect(open.outDbCursors['w-db01']).toBeUndefined();
    expect(open.logs.some((l) => l.includes('w-db01') && l.includes('不存在'))).toBe(true);
    const closed = await run(w([{ column: '不存在', op: 'notempty' }]), db(rows), cur);
    expect(closed.outDbCursors['w-db01']).toBeUndefined();
    // 二义:两列同名
    const dup: DbLike = { columns: [{ id: 'c1', name: '名称' }, { id: 'c2', name: '名称' }], rows };
    const amb = await run(w([{ column: '名称', op: 'notempty' }]), dup, cur);
    expect(amb.fired).toEqual([]);
    expect(amb.outDbCursors['w-db01']).toBeUndefined();
    expect(amb.logs.some((l) => l.includes('ambiguous'))).toBe(true);
    // 列名宽容(trim + 大小写),解析成列 id 后比对
    const loose: DbLike = { columns: [{ id: 'c1', name: 'Name' }], rows };
    const ok = await run(w([{ column: ' name ', op: 'notempty' }]), loose, cur);
    expect(ok.outHits.map((h) => h.ctx.row?.id)).toEqual(['r8']);
    expect(ok.outDbCursors['w-db01']).toEqual({ ...idy('row_added'), rowIds: ['r1', 'r8'] });
    // 负对照(实跑过):去掉 resolveLikeColumn 那段(where 原样喂 whereHolds)→ open 命中 r8 且游标推进、amb 命中 → 红
  });

  it('含 LLM 的规则每 tick 只取一行、游标只消费那一行;纯动作链仍排空', async () => {
    const rows = [{ id: 'r1', cells: {} }, { id: 'a', cells: { c2: 'x' } }, { id: 'b', cells: { c2: 'y' } }, { id: 'c', cells: { c2: '' } }];
    const cur = { 'w-db01': { ...idy('row_added'), rowIds: ['r1'] } };
    const llm = rule({ agentSlug: 'worker', cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'row_added', where: [{ column: 'c2', op: 'notempty' }] } });
    const r = await run(llm, db(rows), cur);
    expect(r.outHits.map((h) => h.ctx.row?.id)).toEqual(['a']); // 只取第一行
    expect(r.outDbCursors['w-db01']).toEqual({ ...idy('row_added'), rowIds: ['r1', 'a', 'c'] }); // b 留在游标外(下 tick 再来);c 没命中 where 照常消费
    // 动作链含 agent_run 同款
    const chain = rule({ actions: [{ type: 'agent_run', agentSlug: 'worker', prompt: 'go' }], cond: llm.cond });
    expect((await run(chain, db(rows), cur)).outDbCursors['w-db01']).toEqual({ ...idy('row_added'), rowIds: ['r1', 'a', 'c'] });
    // 纯动作链 / Muse 唤醒类:排空
    const pure = rule({ actions: [{ type: 'notify', title: 'n' }], cond: llm.cond });
    const rp = await run(pure, db(rows), cur);
    expect(rp.outHits.map((h) => h.ctx.row?.id)).toEqual(['a', 'b']);
    expect(rp.outDbCursors['w-db01']).toEqual({ ...idy('row_added'), rowIds: ['r1', 'a', 'b', 'c'] });
    // cell_changed:其它命中行回填旧值,下 tick 仍是候选
    const cc = rule({ agentSlug: 'worker', cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c2' } });
    const rc = await run(cc, db(rows), { 'w-db01': { ...idy('cell_changed'), cols: ['c2'], cells: { r1: '', a: '', b: '', c: '' } } });
    expect(rc.outHits.map((h) => h.ctx.row?.id)).toEqual(['a']);
    expect(rc.outDbCursors['w-db01']).toEqual({ ...idy('cell_changed'), cols: ['c2'], cells: { r1: '', a: 'x', b: '', c: '' } });
    // 负对照(实跑过):`const taken = hasLLM ? hits.slice(0, 1) : hits` 改成 `hits`(旧排空)→ llm 用例 outHits 得 ['a','b']、游标含 b → 红
  });

  it('单列监听换列(A→B):旧列的游标不被当成新列的 —— 只重播种、零触发', async () => {
    // manage_automation 改 columnId 走 upsertTrigger,历史上不丢游标;从前 cursorFits 对单列只判「没有 cols 键」,
    // 于是 c1 的游标对盯 c2 的规则也算「相符」→ c2 的当前值 × c1 的历史值逐行比 → 多数行判「变了」→ 满表误触发。
    const watch = (col: string) => rule({ actions: [{ type: 'notify', title: 'n' }], cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: col } });
    const rows = [{ id: 'r1', cells: { c1: '甲', c2: '待办' } }, { id: 'r2', cells: { c1: '乙', c2: '进行中' } }];
    // 盯 c1(名称)时播下的旧形状游标:存的是名称列的值,而且不带 cols —— 正是老库里的样子
    const seededOnC1 = { 'w-db01': { ...idy('cell_changed'), cells: { r1: '甲', r2: '乙' } } };
    // 规则被改成盯 c2(状态),游标还是 c1 的 → 一行都不许报
    const r = await run(watch('c2'), db(rows), seededOnC1);
    expect(r.fired).toEqual([]); // 负对照(实跑过):cursorFits 还原成 `return !cur.cols?.length` → fired 得 ['w-db01','w-db01'] → 红
    expect(r.outDbCursors['w-db01']).toEqual({ ...idy('cell_changed'), cols: ['c2'], cells: { r1: '待办', r2: '进行中' } }); // 按新列重播种
    // 重播种之后照常工作:c2 真变了才报
    const r2 = await run(watch('c2'), db([{ id: 'r1', cells: { c1: '甲', c2: '完成' } }, { id: 'r2', cells: { c1: '乙', c2: '进行中' } }]), r.outDbCursors as any);
    expect(r2.outHits.map((h) => h.ctx.row?.id)).toEqual(['r1']);
  });

  it('旧的无 cols 单列游标:第一 tick 只重播种(那一 tick 的积压变化被吃掉)+ log;第二 tick 起照常', async () => {
    // 一次性迁移代价的**边界**,写成测试而不是口头承诺:老库里的单列游标没有 cols,判不符 → 重播种。
    // 重播种把「上次评估之后到本 tick」的积压变化一并算进基线 —— 那一批不触发。这是 fail-closed 换来的,
    // 已在 cursorFits 注释与 docs/Log 里写明;误触发会批量写坏业务数据,漏一窗事件用户重碰一下行就补回来。
    const t = rule({ actions: [{ type: 'notify', title: 'n' }], cond: { type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c2' } });
    const legacy = { 'w-db01': { ...idy('cell_changed'), cells: { r1: '待办', r2: '待办' } } }; // 身份对但缺 cols(改列后没重播种;真·v1 老磁盘游标由 cursorMismatch 的版本闸单独兜)
    // tick 1:r1 其实已经从「待办」变成「完成」(升级前那一窗的真实变更)—— 被基线吃掉,零触发
    const t1 = await run(t, db([{ id: 'r1', cells: { c2: '完成' } }, { id: 'r2', cells: { c2: '待办' } }]), legacy);
    expect(t1.fired).toEqual([]);
    expect(t1.outDbCursors['w-db01']).toEqual({ ...idy('cell_changed'), cols: ['c2'], cells: { r1: '完成', r2: '待办' } });
    expect(t1.logs.some((l) => l.includes('w-db01') && l.includes('重播种'))).toBe(true);
    // tick 2:重播种只发生一次 —— 之后的真实变更照常逐行报(pc-erp 那批单列规则从第二 tick 起完好)
    const t2 = await run(t, db([{ id: 'r1', cells: { c2: '完成' } }, { id: 'r2', cells: { c2: '完成' } }]), t1.outDbCursors as any);
    expect(t2.outHits.map((h) => h.ctx.row?.id)).toEqual(['r2']);
    expect(t2.logs.some((l) => l.includes('重播种'))).toBe(false);
  });

  it('笔记视图(source)与表不存在:一律不触发', async () => {
    const noteView: DbLike = { source: { folder: '日记' }, columns: [], rows: [] };
    expect((await run(rule({}), noteView, { 'w-db01': { ...idy('row_added'), rowIds: [] } })).fired).toEqual([]);
    expect((await run(rule({}), null, { 'w-db01': { ...idy('row_added'), rowIds: [] } })).fired).toEqual([]);
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
