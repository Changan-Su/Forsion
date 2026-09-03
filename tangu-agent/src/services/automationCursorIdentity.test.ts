/**
 * 仪器:db 游标的**身份自证**(path/event/vault/cols)与「停用→启用」的重播种。
 *
 * 由两名对抗验证者的可执行探针搬进仓(scratchpad/race-probe-FINAL.test.ts、toctou.ts、formula-probe-FINAL.test.ts):
 * 用**真** dbCursors 文件 + **真** upsertTrigger + **真** drainAutomation,不是 mock —— 这几条 bug 的成因正是
 * 「写端删游标」与「drain 的读-改-写窗口」之间的时序,mock 掉任何一端都复现不出来。
 *
 * 跑法:`npx vitest run src/services/automationCursorIdentity.test.ts`。
 * 负对照(改坏了必须红):把 museTriggers.cursorMismatch 里的 path 比较注释掉 → R1/R2 拿到满表命中。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Any = any;
let drainAutomation: Any, loadCursors: Any, setCursors: Any, dropCursors: Any, CURSOR_V: number;
let validateTriggerInput: Any, upsertTrigger: Any, loadTriggers: Any, evaluateTriggers: Any, cursorFor: Any, cursorMismatch: Any;
let disableTriggersWithReasons: Any;

beforeAll(async () => {
  // 真读写盘:游标文件与规则文件都落在一次性家目录里(agentsDir 按 TANGU_HOME 解析)。
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'cursor-identity-'));
  ({ drainAutomation } = await import('./automationDrain.js'));
  ({ loadCursors, setCursors, dropCursors, CURSOR_V } = await import('./dbCursors.js'));
  ({ validateTriggerInput, upsertTrigger, loadTriggers, evaluateTriggers, cursorFor, cursorMismatch, disableTriggersWithReasons } =
    await import('./museTriggers.js'));
});

const VAULT = '/v';
const mkInput = (over: Record<string, unknown> = {}): Any => {
  const r = validateTriggerInput({
    desc: 'erp 规则', cond_type: 'db_changed', path: '订单.db', vault: VAULT, event: 'row_added',
    actions: [{ type: 'notify', title: 'n' }], ...over,
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r.value;
};
const tbl = (ids: string[], cells: Record<string, unknown> = {}): Any => ({
  columns: [{ id: 'c1', name: '名称', type: 'text' }],
  rows: ids.map((id) => ({ id, cells: { ...cells } })),
});
/** 一次纯评估(不起跑),返回命中行 id、新游标与日志。 */
async function evalOnce(t: Any, db: Any, cursors: Record<string, Any>) {
  const outDbCursors: Record<string, Any> = {}; const outHits: Any[] = []; const outIssues: Record<string, string> = {}; const outNotices: Record<string, string> = {}; const logs: string[] = [];
  const fired = await evaluateTriggers([t], {
    now: new Date(), currentVault: VAULT, dbCursors: cursors, outDbCursors, outHits, outIssues, outNotices,
    readDbFile: async () => db, log: (m: string) => logs.push(m),
  });
  return { hits: outHits.map((h) => h.ctx.row?.id).filter(Boolean), fired: fired.length, next: outDbCursors[t.id], outIssues, outNotices, logs };
}

describe('R1 换表恰好落在一次 drain 中间(TOCTOU;探针 race-probe-FINAL)', () => {
  it('drain 的 setCursors 会把 dropCursors 刚删的旧表游标合并写回,但读端身份自证认得出来 → 只重播种不触发', async () => {
    const created = await upsertTrigger(mkInput());
    expect(created.ok).toBe(true);
    const id: string = created.trigger.id;
    // A 表(订单.db)已播种:见过 o1/o2
    await setCursors({ [id]: cursorFor({ type: 'db_changed', path: '订单.db', vault: VAULT, event: 'row_added' }, tbl(['o1', 'o2'])) });

    let swapped = false;
    const drain = await drainAutomation({
      loadTriggers, loadCursors, setCursors,
      // 一次真实的 tick:evaluate 期间(loadCursors 之后、setCursors 之前)用户在面板把表换成了 出库.db
      evaluate: async (_ts: Any, env: Any) => {
        env.outDbCursors[id] = cursorFor({ type: 'db_changed', path: '订单.db', vault: VAULT, event: 'row_added' }, tbl(['o1', 'o2']));
        const r = await upsertTrigger(mkInput({ path: '出库.db' }), id);
        expect(r.ok).toBe(true);
        expect((await loadCursors())[id]).toBeUndefined(); // 写端这一刻确实删干净了
        swapped = true;
        return [];
      },
      launch: async () => ({ launched: [], touched: {} }),
      advanceSelfCursors: async () => {}, markTriggersFired: async () => {},
      activityLines: [], currentVault: VAULT, readDbFile: async () => null, log: () => {},
    });
    expect(swapped).toBe(true);
    expect(drain.rounds).toBe(1);

    // ★ 写端不承重:baseline 的 setCursors(Object.assign 合并)确实把旧表游标又写了回来。
    const after = (await loadCursors())[id];
    expect(after?.path).toBe('订单.db');

    // ★ 读端承重:规则已指向 出库.db,拿 订单.db 的基线比它 → 必须只重播种,绝不把满表现有行当成「刚加的」。
    const t = (await loadTriggers()).find((x: Any) => x.id === id);
    expect(t.cond.path).toBe('出库.db');
    const r = await evalOnce(t, tbl(['x1', 'x2', 'x3']), { [id]: after });
    expect(r.hits).toEqual([]);                       // 负对照:去掉 path 比较 → ['x1','x2','x3']
    expect(r.next.path).toBe('出库.db');              // 重播种成新表的基线
    expect(r.logs.join('\n')).toContain('换表了');    // 留痕说清「因什么重播种」
  });
});

describe('R2 竞态 vs 对照:整条 drain 链路两次 tick(探针 toctou.ts)', () => {
  const tables: Record<string, Any> = { 'A.db': tbl(['a1', 'a2']), 'B.db': tbl(['b1', 'b2', 'b3']) };
  async function scenario(raceInsideWindow: boolean) {
    const created = await upsertTrigger(mkInput({ path: 'A.db', desc: `盯新增行 ${raceInsideWindow}` }));
    const id: string = created.trigger.id;
    await setCursors({ [id]: cursorFor({ type: 'db_changed', path: 'A.db', vault: VAULT, event: 'row_added' }, tables['A.db']) });
    const seen: string[][] = [];
    const swap = async (): Promise<void> => { await upsertTrigger(mkInput({ path: 'B.db', desc: `盯新增行 ${raceInsideWindow}` }), id); };
    const deps = (wrap: Any): Any => ({
      loadTriggers: async () => (await loadTriggers()).filter((t: Any) => t.id === id),
      loadCursors, setCursors, evaluate: wrap,
      launch: async (hits: Any[]) => { seen.push(hits.map((h) => h.ctx?.row?.id ?? '(no-ctx)')); return { launched: [], touched: {} }; },
      advanceSelfCursors: async () => {}, markTriggersFired: async () => {},
      activityLines: [], currentVault: VAULT,
      readDbFile: async (rel: string) => tables[rel] ?? null, log: () => {},
    });
    // tick 1:表 A 无变化;竞态版在 evaluate 返回后、drain 提交 baseline 之前换表
    await drainAutomation(deps(async (ts: Any, env: Any) => {
      const out = await evaluateTriggers(ts, env);
      if (raceInsideWindow) await swap();
      return out;
    }));
    if (!raceInsideWindow) await swap(); // 对照:换表发生在两 tick 之间
    // tick 2:规则已指向表 B(满表 3 行)
    await drainAutomation(deps(evaluateTriggers));
    return { hits: seen, end: (await loadCursors())[id] };
  }

  it('竞态与非竞态必须给出同一个结论:只重播种,零命中', async () => {
    const race = await scenario(true);
    const ctrl = await scenario(false);
    expect(race.hits).toEqual([]);            // 负对照:去掉 path 比较 → [['b1','b2','b3']]
    expect(ctrl.hits).toEqual([]);
    expect(race.end.path).toBe('B.db');
    expect(race.end.rowIds).toEqual(['b1', 'b2', 'b3']);
    expect(ctrl.end).toEqual(race.end);       // 竞态与否结论一致 = 时序无关
  });
});

describe('P0-2 停用 → 再启用:积压不得一次引爆(用户规则,不只插件规则)', () => {
  it('重新启用即清游标 → 下一 tick 只重播种;且 dropCursors 发生在 saveTriggers 之前', async () => {
    const created = await upsertTrigger(mkInput({ path: '积压.db', desc: '停用再启用' }));
    const id: string = created.trigger.id;
    const seed = cursorFor({ type: 'db_changed', path: '积压.db', vault: VAULT, event: 'row_added' }, tbl(['p1']));
    await setCursors({ [id]: seed });
    // 停用(模拟 drain 排空封顶自动停用 / 用户手动关)
    await upsertTrigger(mkInput({ path: '积压.db', desc: '停用再启用', enabled: false }), id);
    expect((await loadCursors())[id]).toEqual(seed); // 停用不清游标(积压在攒)
    // 停用期间加了 20 行
    const backlog = tbl(['p1', ...Array.from({ length: 20 }, (_, i) => `n${i}`)]);
    // 重新启用:桌面列表页就是这样整量 upsert(cond 逐字不变,只翻 enabled)
    await upsertTrigger(mkInput({ path: '积压.db', desc: '停用再启用', enabled: true }), id);
    const t = (await loadTriggers()).find((x: Any) => x.id === id);
    expect(t.enabled).toBe(true);
    // 先断后果、再断机制:负对照(去掉 reEnabled 分支)必须在**这一行**红成 20 行一次引爆,而不是先被机制断言挡住。
    const r = await evalOnce(t, backlog, await loadCursors());
    expect(r.hits).toEqual([]);
    expect(r.next.rowIds).toHaveLength(21);
    expect((await loadCursors())[id]).toBeUndefined(); // 机制:游标已清,且是在规则被存成 enabled 之前清的
  });

  it('新建分支也清游标:同 id 重建(插件 ensure)不许捡到上一条规则的基线', async () => {
    const pid = 'plugin:demo:seed';
    await setCursors({ [pid]: cursorFor({ type: 'db_changed', path: '重建.db', vault: VAULT, event: 'row_added' }, tbl(['old1'])) });
    const r = await upsertTrigger(mkInput({ path: '重建.db', desc: '插件种子' }), pid, { allowPluginCreate: true });
    expect(r.ok && r.created).toBe(true);
    expect((await loadCursors())[pid]).toBeUndefined();
  });
});

describe('P1-3 监听计算列 = 永远不触发(探针 formula-probe-FINAL)', () => {
  const dbOf = (a: string): Any => ({
    columns: [
      { id: 'a', name: 'A', type: 'number' },
      { id: 'f', name: 'F', type: 'formula', formula: '{A}*2' },
      { id: 'lk', name: 'L', type: 'lookup', refDb: '别的.db', lookupBackCol: 'r', lookupKind: 'links' },
    ],
    rows: [{ id: 'r1', cells: { a } }],
  });
  const rule = (columnId: string): Any => ({
    id: `w-${columnId}`, desc: 'watch', cooldownHours: 0, lastFiredAt: null, enabled: true,
    createdAt: '2020-01-01T00:00:00.000Z', actions: [{ type: 'notify', title: 'n' }],
    cond: { type: 'db_changed', path: 't.db', vault: VAULT, event: 'cell_changed', columnId },
  });

  it('公式列/投影列:从前不抛不报零日志、一次都不触发 —— 现在报配置错误并带出 outIssues', async () => {
    for (const col of ['f', 'lk']) {
      const r = await evalOnce(rule(col), dbOf('1'), {});
      expect(r.hits).toEqual([]);                                       // 这一条两种版本都绿 —— 「永远不触发」本来就是症状
      // 负对照(去掉 invalidWatchCols 闸)必须在**这一行**红:从前是零 issue、零日志、游标照常推进 = 用户侧完全无感。
      expect(r.outIssues[`w-${col}`]).toContain('监听列必须是落盘列');
      expect(r.logs.join('\n')).toContain('评估失败');
      expect(r.next).toBeUndefined();                                   // 游标冻住,不假装消费
    }
    // 对照组:同样的改动,盯落盘列 a 正常报(证明台架摆对了)
    const seed = await evalOnce(rule('a'), dbOf('1'), {});
    const t2 = await evalOnce(rule('a'), dbOf('9'), { 'w-a': seed.next });
    expect(t2.hits).toEqual(['r1']);
    expect(t2.outIssues).toEqual({});
  });

  it('precheckWatchCols:建规则时就拒(表读不到 / 非当前库则放行)', async () => {
    const { precheckWatchCols } = await import('./museTriggers.js');
    const cond = rule('f').cond;
    expect(await precheckWatchCols(cond, async () => dbOf('1'), VAULT)).toContain('落盘列');
    expect(await precheckWatchCols(cond, async () => null, VAULT)).toBeNull();          // 表不在 → 放行
    expect(await precheckWatchCols(cond, async () => { throw new Error('boom'); }, VAULT)).toBeNull();
    expect(await precheckWatchCols(cond, async () => dbOf('1'), '/别的库')).toBeNull(); // 非当前库 → 放行
    expect(await precheckWatchCols(rule('a').cond, async () => dbOf('1'), VAULT)).toBeNull();
  });
});

describe('cursorMismatch 逐维', () => {
  const cond = (over: Record<string, unknown> = {}): Any =>
    ({ type: 'db_changed', path: '任务.db', vault: VAULT, event: 'cell_changed', columnId: 'c1', ...over });
  const seedCell = (): Any => cursorFor(cond(), tbl(['r1'], { c1: 'x' }));

  it('相符 → null;每一维单独改坏都能被认出来', () => {
    expect(cursorMismatch(undefined, cond())).toBeNull();               // 无游标 = 首次,由调用方播种
    expect(cursorMismatch(seedCell(), cond())).toBeNull();
    expect(cursorMismatch({ ...seedCell(), v: 1 }, cond())).toContain('旧版本');
    expect(cursorMismatch(seedCell(), cond({ path: '别的.db' }))).toContain('换表了');
    expect(cursorMismatch(seedCell(), cond({ vault: '/w' }))).toContain('换库了');
    expect(cursorMismatch(seedCell(), cond({ columnId: 'c2' }))).toContain('监听列变了');
    // 换事件:row_added 的游标喂给 cell_changed 规则(反之亦然)
    const rowCur = cursorFor(cond({ event: 'row_added' }), tbl(['r1']));
    expect(cursorMismatch(rowCur, cond())).toContain('事件变了');
    expect(cursorMismatch(seedCell(), cond({ event: 'row_added' }))).toContain('事件变了');
    // path 归一:'./任务.db' 与 '任务.db' 是同一张表,不许平白重播种
    expect(cursorMismatch(seedCell(), cond({ path: './任务.db' }))).toBeNull();
    expect(seedCell().v).toBe(CURSOR_V);
  });

  it('dropCursors 仍是快速路径(删规则时清干净)', async () => {
    await setCursors({ 'w-tmp': seedCell() });
    await dropCursors(['w-tmp']);
    expect((await loadCursors())['w-tmp']).toBeUndefined();
  });
});

describe('P1-2 永久冻死的规则必须给用户侧信号(不看引擎日志也能发现)', () => {
  /** 只跑指定规则的一次 drain(真 drain + 真停用函数)。 */
  const drainOne = async (id: string, table: Any, opts: { withSignal?: boolean } = {}) => {
    const logs: string[] = [];
    const r = await drainAutomation({
      loadTriggers: async () => (await loadTriggers()).filter((t: Any) => t.id === id),
      loadCursors, setCursors, evaluate: evaluateTriggers,
      launch: async () => ({ launched: [], touched: {} }),
      advanceSelfCursors: async () => {}, markTriggersFired: async () => {},
      ...(opts.withSignal === false ? {} : { disableTriggersWithReasons }),
      activityLines: [], currentVault: VAULT,
      readDbFile: async (rel: string) => (rel === '信号.db' || rel === '瞬时.db' ? table : null),
      log: (m: string) => logs.push(m),
    });
    return { ...r, logs, rule: (await loadTriggers()).find((t: Any) => t.id === id) };
  };

  it('监听列被删(delCol 连 cell 一起删、addCol 换新 id → 列永远回不来)→ 停用 + disabledReason,面板可见', async () => {
    const created = await upsertTrigger(mkInput({ path: '信号.db', desc: '盯已删的列', event: 'cell_changed', column_id: 'gone' }));
    const id: string = created.trigger.id;
    const table = { columns: [{ id: 'a', name: 'A', type: 'text' }], rows: [{ id: 'r1', cells: { a: '1' } }] };

    // 负对照:drain 不接停用面 → 规则每 tick 抛一次、只进引擎日志,面板上看起来一切正常(这就是从前的样子)
    const silent = await drainOne(id, table, { withSignal: false });
    expect(silent.rule.enabled).toBe(true);
    expect(silent.rule.disabledReason).toBeUndefined();
    expect(silent.logs.join('\n')).toContain('监听列已不存在'); // 只有日志

    const r = await drainOne(id, table);
    expect(r.configIssues[id]).toContain('监听列已不存在:gone');
    expect(r.rule.enabled).toBe(false);                          // ★ 面板上的开关会变灰
    expect(r.rule.disabledReason).toContain('监听列已不存在');   // ★ 详情页把原因显示出来
    expect((await loadCursors())[id]).toBeUndefined();           // 冻住:一格都没假装消费
    // 停用后不再重复报(evaluate 跳过 !enabled)
    expect((await drainOne(id, table)).configIssues).toEqual({});
  });

  it('暂时性错误(lookup 依赖表读不到)绝不停用 —— 下一轮可能自己就好了', async () => {
    const created = await upsertTrigger(mkInput({ path: '瞬时.db', desc: '依赖表暂时缺' }));
    const id: string = created.trigger.id;
    const table = {
      columns: [{ id: 'rel', name: '配件', type: 'rowlink', refDb: '不存在.db' },
                { id: 'lk', name: '单价', type: 'lookup', lookupRel: 'rel', lookupCol: 'p' }],
      rows: [{ id: 'o1', cells: { rel: 'p1' } }],
    };
    await setCursors({ [id]: cursorFor({ type: 'db_changed', path: '瞬时.db', vault: VAULT, event: 'row_added' }, { columns: [], rows: [] }) });
    const r = await drainOne(id, table);
    expect(r.configIssues).toEqual({});     // 负对照:把 preloadLookupDbs 的抛改成 TriggerConfigError → 这条红
    expect(r.rule.enabled).toBe(true);
    expect(r.logs.join('\n')).toContain('不存在.db');
  });
});

describe('P2-2 一次性重播种代价的真实边界(订正「≈ 一个 tick 间隔」)', () => {
  const cond = (over: Record<string, unknown> = {}): Any =>
    ({ type: 'db_changed', path: '冻结.db', vault: VAULT, event: 'row_added', ...over });
  const t = (over: Record<string, unknown> = {}): Any => ({
    id: 'w-frozen', desc: '冻结路径', cooldownHours: 0, lastFiredAt: null, enabled: true,
    createdAt: '2020-01-01T00:00:00.000Z', actions: [{ type: 'notify', title: 'n' }], cond: cond(over),
  });

  it('冻结路径逐条:vault 不一致 / 表读不到 / where 列无效 —— 游标一格不推,积压随时间无上限地攒', async () => {
    const seeded = { 'w-frozen': cursorFor(cond(), tbl(['r1'])) };
    // ① vault 不一致:整条跳过,连游标出参都不写
    const other = await (async () => {
      const outDbCursors: Any = {}; const outHits: Any[] = [];
      await evaluateTriggers([t()], { now: new Date(), currentVault: '/别的库', dbCursors: seeded, outDbCursors, outHits, readDbFile: async () => tbl(['r1', 'n1']) });
      return outDbCursors;
    })();
    expect(other).toEqual({});
    // ② 表暂时读不到(null)
    const gone = await evalOnce(t(), null, seeded);
    expect(gone.next).toBeUndefined();
    // ③ where 引用的列无效(用户把列改名了 —— where 允许写列名,所以改名就冻)
    const bad = await evalOnce(t({ where: [{ column: '早就改名了', op: 'notempty' }] }), tbl(['r1', 'n1']), seeded);
    expect(bad.hits).toEqual([]);
    expect(bad.next).toBeUndefined();                                  // 冻住,不假装消费
    // M7 裁决:where 允许写列名,而列名可能只是**暂时**重名/改名(列迁移中间态) —— 不许自动停用,
    // 只给不停用的可见状态位(notice)。会导致停用的 outIssues 这一档留给「监听列按 id 没了」那种回不来的。
    expect(bad.outIssues['w-frozen']).toBeUndefined();
    expect(bad.outNotices['w-frozen']).toContain('where');
    // ④ 冻了很久之后一旦重播种(换表/改列/重新启用),吃掉的是**从冻结点起的全部积压**,不是「一个 tick」
    const backlog = tbl(['r1', ...Array.from({ length: 50 }, (_, i) => `later${i}`)]);
    const reseed = await evalOnce(t({ path: '换过的.db' }), backlog, seeded);
    expect(reseed.hits).toEqual([]);                                   // 50 行积压一条都不触发
    expect(reseed.next.rowIds).toHaveLength(51);                       // 全部算进基线
    expect(reseed.logs.join('\n')).toContain('换表了');
  });
});
