/**
 * 环刹车的回归(调试铁律 #5:探针留仓)——**排空封顶 20 轮断环**是 db 动作链唯一承重的那条刹车,
 * 本文件专钉它。台架用**真** `evaluateTriggers` + 真 drain 循环(只有起跑/落盘是内存版),
 * 因为这条刹车的失效方式都在「评估 → 起跑 → 推游标 → 再评估」的接缝上,mock 掉评估就什么都守不住。
 *
 * ⚠️ 2026-09-02 撤销记录:本文件一度还钉着「有上界追赶(每 tick 最多 N 行)+ 跨 tick 积压不收敛就停用」。
 * 那套设计被撤销(它把封顶轮数架空——积压规则被踢出后续轮次,轮数永远攒不满;而补救用的跨 tick 判据
 * 会把正常稳态误判成环)。相关用例随之删除;**留下的这两档正是撤销后重新承重的东西**:
 * 一拍内的环,不论积压多少行,都必须在 DRAIN_MAX_ROUNDS 轮内撞顶并停用最后一轮起跑的规则。
 */
import { describe, it, expect } from 'vitest';
import { drainAutomation, DRAIN_MAX_ROUNDS, type DrainDeps } from './automationDrain.js';
import { evaluateTriggers, type MuseTrigger, type DbLike } from './museTriggers.js';
import type { DbCursor } from './dbCursors.js';
import type { TouchedDbs } from './automation.js';

const VAULT = '/v';
let seq = 0;
const tbl = (n: number): DbLike => ({
  columns: [{ id: 'c1', name: 'A', type: 'text' }],
  rows: Array.from({ length: n }, () => ({ id: `s${++seq}`, cells: { c1: 'x' } })),
});
const push = (db: DbLike): string => { const id = `n${++seq}`; db.rows.push({ id, cells: { c1: 'x' } }); return id; };
const mkRule = (id: string, path: string, over: Partial<MuseTrigger> = {}): MuseTrigger => ({
  id, desc: id, cond: { type: 'db_changed', path, vault: VAULT, event: 'row_added' },
  cooldownHours: 0, lastFiredAt: null, enabled: true, createdAt: '2020-01-01T00:00:00.000Z',
  actions: [{ type: 'notify', title: 'n' }], ...over,
});

/**
 * 「每命中一行就往 `edges[规则]` 那张表写 n 行」的内存世界。目标表若有别的规则盯着,那就是一条跨规则级联;
 * 首尾相接就是环。
 */
function world(opts: {
  tables: Record<string, number>;
  rules: Array<{ id: string; watch: string }>;
  edges: Record<string, [string, number]>;
}) {
  const tables: Record<string, DbLike> = {};
  for (const [name, n] of Object.entries(opts.tables)) tables[name] = tbl(n);
  const triggers = opts.rules.map((r) => mkRule(r.id, r.watch));
  const cursors: Record<string, DbCursor> = {};
  for (const r of opts.rules) cursors[r.id] = { v: 2, path: r.watch, event: 'row_added', vault: VAULT, rowIds: [] };
  const logs: string[] = [];
  const disabled: Array<{ ids: string[]; reason: string }> = [];
  const launches: Array<{ id: string; row?: string }> = [];
  const deps: DrainDeps = {
    loadTriggers: async () => triggers.map((t) => ({ ...t })),
    loadCursors: async () => ({ ...cursors }),
    setCursors: async (p) => { Object.assign(cursors, p); },
    evaluate: evaluateTriggers,
    launch: async (hits) => {
      const touched: Record<string, TouchedDbs> = {};
      for (const h of hits) {
        launches.push({ id: h.t.id, row: h.ctx?.row?.id });
        const edge = opts.edges[h.t.id];
        if (!edge) continue;
        const [dst, n] = edge;
        for (let i = 0; i < n; i++) {
          ((touched[h.t.id] ??= {})[dst] ??= { addedIds: [], edited: [] }).addedIds.push(push(tables[dst]));
        }
      }
      return { launched: [...new Set(hits.map((h) => h.t.id))], touched };
    },
    // 内存版自写不可见:只 append 本规则自己写进**自己盯的那张表**的行。
    advanceSelfCursors: async (touched) => {
      for (const [id, byPath] of Object.entries(touched)) {
        const t = triggers.find((x) => x.id === id);
        const c = t?.cond;
        if (!c || c.type !== 'db_changed') continue;
        const touch = byPath[c.path];
        const cur = cursors[id];
        if (!touch || !cur?.rowIds) continue;
        const add = touch.addedIds.filter((r) => !cur.rowIds!.includes(r));
        if (add.length) cursors[id] = { ...cur, rowIds: [...cur.rowIds, ...add] };
      }
    },
    markTriggersFired: async () => {},
    disableTriggers: async (ids, reason) => {
      disabled.push({ ids, reason });
      for (const t of triggers) if (ids.includes(t.id)) t.enabled = false;
    },
    activityLines: [], currentVault: VAULT,
    readDbFile: async (rel) => tables[rel] ?? null,
    log: (m) => logs.push(m),
  };
  return { deps, tables, cursors, logs, disabled, launches };
}

/** A→B→A 环:A 盯 A.db 每命中往 B.db 写 1 行;B 盯 B.db 每命中往 A.db 写 1 行。 */
const ring = (backlog: number) => world({
  tables: { 'A.db': backlog, 'B.db': 0 },
  rules: [{ id: 'w-a', watch: 'A.db' }, { id: 'w-b', watch: 'B.db' }],
  edges: { 'w-a': ['B.db', 1], 'w-b': ['A.db', 1] },
});

describe('一拍内的环 × 轮数封顶(DRAIN_MAX_ROUNDS)', () => {
  it('积压 1:20 轮撞顶,最后一轮起跑的规则被停用,reason 说的是「自动化环」', async () => {
    const w = ring(1);
    const r = await drainAutomation(w.deps);
    expect(r.capHit).toBe(true);
    expect(r.rounds).toBe(DRAIN_MAX_ROUNDS);
    expect(r.disabled.length).toBeGreaterThan(0);
    expect(w.disabled[0].reason).toContain('自动化环');
    // 停用之后世界静止:第 20 轮起跑的是 w-b(它被停用),它留下的那一行让 w-a 再跑**恰好一次**(往 B.db 写 1 行),
    // w-b 已停不再接 → 从此一行不长。恰好 +1 而不是 ≤+1:只 log 不停用的话这里每拍还会 +20。
    const before = w.tables['A.db'].rows.length + w.tables['B.db'].rows.length;
    for (let i = 0; i < 3; i++) await drainAutomation(w.deps);
    expect(w.tables['A.db'].rows.length + w.tables['B.db'].rows.length).toBe(before + 1);
  });

  it('★ 积压 25(一拍内一次全吃):照样 20 轮撞顶被停用 —— 积压多少行都不该让这条刹车失灵', async () => {
    // 这正是「有上界追赶」当初逃出封顶的那个形状:规则被推迟 → 被踢出后续轮次 → 轮数永远攒不满、
    // capHit 全程 false,环靠跨 tick 续命。撤销之后 25 行在第 1 轮一次跑完,轮数照常累加到 20。
    const w = ring(25);
    const r = await drainAutomation(w.deps);
    expect(r.capHit).toBe(true);
    expect(r.rounds).toBe(DRAIN_MAX_ROUNDS);
    expect(r.disabled.length).toBeGreaterThan(0);
    expect(w.disabled[0].reason).toContain('自动化环');
    expect(w.logs.filter((l) => l.includes('drain cap hit'))).toHaveLength(1);
    // 第 1 轮就把 25 行积压全部起跑(冻结解除 = 一拍内处理完,撤销后回到的就是这个行为)
    expect(w.launches.filter((l) => l.id === 'w-a').length).toBeGreaterThanOrEqual(25);
  });
});
