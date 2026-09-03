// 引用列物化纯逻辑:正向单值/多值、反向 rollup、一跳截断、目标列公式先物化、目标表缺失。
import { describe, expect, it } from 'vitest'
import { computeRowLookups, isBackLookup } from './lookup'
import type { DbFile, DbRow } from './schema'

/** 目标表「配件」:单价数字列 + 小计公式列 + 一个 lookup 列(用来验一跳截断)+ 指回订单表的 rowlink 列。
 *  ⚠️ 夹具故意在 cells 里给公式列/lookup 列塞了「陈旧值」:磁盘上本不该有它们的值,塞进来是为了让
 *  「直读 cell」与「先物化 / 截断」两种实现产生不同结果 —— 否则去掉那两个分支测试照样绿(假绿)。 */
const PARTS: DbFile = {
  version: 1,
  name: '配件',
  columns: [
    { id: 'n', name: '名称', type: 'text' },
    { id: 'p', name: '单价', type: 'number' },
    { id: 'q', name: '数量', type: 'number' },
    { id: 'f', name: '小计', type: 'formula', formula: '{单价}*{数量}' },
    { id: 'lk', name: '别的引用', type: 'lookup', lookupRel: 'ord', lookupCol: 'title' },
    { id: 'ord', name: '订单', type: 'rowlink', refDb: '订单.db' },
    { id: 'tf', name: '今天', type: 'formula', formula: 'today()' },
  ],
  rows: [
    { id: 'p1', cells: { n: 'CPU', p: 100, q: 2, f: -1, lk: '陈旧', ord: 'o1' } },
    { id: 'p2', cells: { n: '显卡', p: 300, q: 1, f: -1, lk: '陈旧', ord: ['o1', 'o2'] } },
    { id: 'p3', cells: { n: '内存', p: 50, q: 4, f: -1, ord: 'o2' } },
  ],
}

/** 本表「订单」:正向 lookup(沿 rowlink 列 rel)+ 反向 lookup(扫 PARTS 的 ord 列)。 */
const ORDERS: DbFile = {
  version: 1,
  name: '订单',
  columns: [
    { id: 'title', name: '标题', type: 'text' },
    { id: 'rel', name: '配件', type: 'rowlink', refDb: '配件.db' },
    { id: 'price', name: '单价', type: 'lookup', lookupRel: 'rel', lookupCol: 'p' },
    { id: 'sum', name: '合计', type: 'lookup', lookupRel: 'rel', lookupCol: 'p', lookupAgg: 'sum' },
    { id: 'names', name: '配件名', type: 'lookup', lookupRel: 'rel', lookupCol: 'n', lookupAgg: 'join' },
    { id: 'sub', name: '小计', type: 'lookup', lookupRel: 'rel', lookupCol: 'f' },
    { id: 'chain', name: '链', type: 'lookup', lookupRel: 'rel', lookupCol: 'lk' },
    { id: 'today', name: '目标今天', type: 'lookup', lookupRel: 'rel', lookupCol: 'tf' },
    { id: 'back', name: '出库行', type: 'lookup', refDb: '配件.db', lookupBackCol: 'ord', lookupCol: 'n', lookupAgg: 'join' },
    { id: 'backCount', name: '出库数', type: 'lookup', refDb: '配件.db', lookupBackCol: 'ord', lookupCol: 'n', lookupAgg: 'count' },
  ],
  rows: [],
}

const getDb = (path: string): DbFile | null => (path === '配件.db' ? PARTS : null)
const row = (id: string, cells: DbRow['cells']): DbRow => ({ id, cells })

describe('computeRowLookups', () => {
  it('无 lookup 列 → 空对象(不碰任何目标表)', () => {
    const db: DbFile = { ...ORDERS, columns: ORDERS.columns.filter((c) => c.type !== 'lookup') }
    expect(computeRowLookups(db, row('o1', { rel: 'p1' }), () => { throw new Error('不该被调') })).toEqual({})
  })

  it('正向单值:cell 为 string → 取目标行一列;目标行不存在 → first=null/count=0', () => {
    const out = computeRowLookups(ORDERS, row('o1', { rel: 'p1' }), getDb)
    expect(out.price).toBe(100)
    expect(out.sum).toBe(100)
    expect(out.names).toBe('CPU')
    const gone = computeRowLookups(ORDERS, row('o1', { rel: 'nope' }), getDb)
    expect(gone.price).toBeNull()
    expect(gone.sum).toBe(0)
  })

  it('正向多值:cell 为 string[] → 逐目标行取值再聚合(缺失 id 跳过,不当成空值)', () => {
    const out = computeRowLookups(ORDERS, row('o1', { rel: ['p1', 'p2', 'nope', 'p3'] }), getDb)
    expect(out.price).toBe(100) // first
    expect(out.sum).toBe(450)
    expect(out.names).toBe('CPU、显卡、内存')
  })

  it('目标列是公式 → 先物化目标行公式再读(不读磁盘上的陈旧值)', () => {
    const out = computeRowLookups(ORDERS, row('o1', { rel: ['p1', 'p2'] }), getDb)
    expect(out.sub).toBe(200) // 100*2,不是夹具里塞的 -1
  })

  it('目标列是 lookup → null(一跳截断,不读目标 cell 里的陈旧值)', () => {
    const out = computeRowLookups(ORDERS, row('o1', { rel: 'p1' }), getDb)
    expect(out.chain).toBeNull()
  })

  it('opts.today 透传给目标行公式的 today()', () => {
    const out = computeRowLookups(ORDERS, row('o1', { rel: 'p1' }), getDb, { today: '2000-01-01' })
    expect(out.today).toBe('2000-01-01')
  })

  it('反向 rollup:扫目标表 lookupBackCol 含本行 id 的行(string 与 string[] 两种形态都认)', () => {
    const o1 = computeRowLookups(ORDERS, row('o1', {}), getDb)
    expect(o1.back).toBe('CPU、显卡') // p1(string)+ p2(数组含 o1)
    expect(o1.backCount).toBe(2)
    const o2 = computeRowLookups(ORDERS, row('o2', {}), getDb)
    expect(o2.back).toBe('显卡、内存')
    const o3 = computeRowLookups(ORDERS, row('o3', {}), getDb)
    expect(o3.back).toBe('')
    expect(o3.backCount).toBe(0)
  })

  it('反向模式判据 = refDb 且 lookupBackCol;只有 refDb 仍按正向走', () => {
    expect(isBackLookup(ORDERS.columns.find((c) => c.id === 'back')!)).toBe(true)
    expect(isBackLookup(ORDERS.columns.find((c) => c.id === 'price')!)).toBe(false)
    expect(isBackLookup({ id: 'x', name: 'x', type: 'lookup', refDb: '配件.db' })).toBe(false)
  })

  it('目标表缺失(未加载/已删)→ first=null、count=0、join=空串,不抛', () => {
    const out = computeRowLookups(ORDERS, row('o1', { rel: ['p1'] }), () => null)
    expect(out.price).toBeNull()
    expect(out.sum).toBe(0)
    expect(out.back).toBe('')
    expect(out.backCount).toBe(0)
  })

  it('lookupRel 指向的不是 rowlink 列、或 lookupCol 在目标表不存在 → 空聚合', () => {
    const db: DbFile = {
      ...ORDERS,
      columns: [
        ...ORDERS.columns,
        { id: 'badRel', name: 'x', type: 'lookup', lookupRel: 'title', lookupCol: 'p' },
        { id: 'badCol', name: 'y', type: 'lookup', lookupRel: 'rel', lookupCol: 'zzz', lookupAgg: 'count' },
      ],
    }
    const out = computeRowLookups(db, row('o1', { rel: 'p1' }), getDb)
    expect(out.badRel).toBeNull()
    expect(out.badCol).toBe(0)
  })
})
