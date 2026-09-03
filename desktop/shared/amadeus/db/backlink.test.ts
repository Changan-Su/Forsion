// 可编辑投影列纯逻辑:反向 join 原始 id / 幂等集合运算(单值覆盖 · 多值增删 · 新对象不共享)/ 整格赋值 / 配置体检。
import { describe, expect, it } from 'vitest'
import { backLinkEdit, backLinkIds, backLinkRows, backLinkSet, isLinksProjection, pairIssues, projectionIssue } from './backlink'
import { computeRowLookups } from './lookup'
import type { DbColumn, DbFile } from './schema'

const STOCK = '库存.db'
const OUT = '出库.db'

/** 出库表:配件 = 单值 rowlink → 库存;标签 = 多值 rowlink → 库存;备注 = 普通文本(用来验「不是 rowlink 拒写」)。 */
const outbound = (): DbFile => ({
  version: 1, name: '出库',
  columns: [
    { id: 't', name: '备注', type: 'text' },
    { id: 'part', name: '配件', type: 'rowlink', refDb: STOCK },
    { id: 'tags', name: '标签', type: 'rowlink', refDb: STOCK, multiple: true },
  ],
  rows: [
    { id: 'x1', cells: { t: '张三-CPU', part: 's1', tags: ['s1', 's2'] } },
    { id: 'x2', cells: { t: '张三-显卡', part: 's2' } },
    { id: 'x3', cells: { t: '李四-内存', part: 's3', tags: 's1' } }, // 多值列里的旧单值形态也要认
  ],
})
const stock = (): DbFile => ({
  version: 1, name: '库存',
  columns: [
    { id: 'n', name: '名称', type: 'text' },
    { id: 'links', name: '出库(投影)', type: 'lookup', refDb: OUT, lookupBackCol: 'part', lookupKind: 'links' },
    { id: 'tagged', name: '标签(投影)', type: 'lookup', refDb: OUT, lookupBackCol: 'tags', lookupKind: 'links' },
    { id: 'join', name: '出库行', type: 'lookup', refDb: OUT, lookupBackCol: 'part', lookupCol: 't', lookupAgg: 'join' },
  ],
  rows: [{ id: 's1', cells: { n: 'CPU' } }, { id: 's2', cells: { n: '显卡' } }, { id: 's3', cells: { n: '内存' } }, { id: 's4', cells: { n: 'SSD' } }],
})

describe('backLinkIds / backLinkRows', () => {
  it('单值与多值 rowlink 都认;按目标表行序;没人指回 → 空', () => {
    const o = outbound()
    expect(backLinkIds(o, 'part', 's1')).toEqual(['x1'])
    expect(backLinkIds(o, 'tags', 's1')).toEqual(['x1', 'x3'])
    expect(backLinkIds(o, 'tags', 's2')).toEqual(['x1'])
    expect(backLinkIds(o, 'part', 's4')).toEqual([])
    expect(backLinkRows(o, 'part', 's2').map((r) => r.cells.t)).toEqual(['张三-显卡'])
  })

  it('computeRowLookups 对投影列返回原始 id 数组(不聚合、不 join 文案);同表普通反向 lookup 仍聚合', () => {
    const out = computeRowLookups(stock(), { id: 's1', cells: { n: 'CPU' } }, (p) => (p === OUT ? outbound() : null))
    expect(out.links).toEqual(['x1'])
    expect(out.tagged).toEqual(['x1', 'x3'])
    expect(out.join).toBe('张三-CPU')
    // 目标表没到:空数组(与「没人指回」同形),普通 lookup 得 null/空串
    const none = computeRowLookups(stock(), { id: 's1', cells: {} }, () => null)
    expect(none.links).toEqual([])
    expect(none.join).toBe('')
  })
})

describe('backLinkEdit(幂等集合运算)', () => {
  it('单值列 add = 覆盖为本行 id;已指向本行再 add → null;remove 只在恰好指向本行时清空(删键)', () => {
    const o = outbound()
    const rows = backLinkEdit(o, 'part', 's4', 'x2', true)!
    expect(rows).not.toBeNull()
    expect(rows[1].cells.part).toBe('s4') // 覆盖掉 s2
    expect(o.rows[1].cells.part).toBe('s2') // 原表没被原地改
    expect(rows[1]).not.toBe(o.rows[1])
    expect(rows[0]).toBe(o.rows[0]) // 没动的行引用原样
    expect(backLinkEdit({ ...o, rows }, 'part', 's4', 'x2', true)).toBeNull() // 幂等
    expect(backLinkEdit(o, 'part', 's4', 'x2', false)).toBeNull() // 本就不指向 s4
    const cleared = backLinkEdit(o, 'part', 's2', 'x2', false)!
    expect('part' in cleared[1].cells).toBe(false)
  })

  it('多值列 add = 追加(新数组);remove = 摘掉;摘空删键;旧单值形态摘掉后仍按多值列写数组', () => {
    const o = outbound()
    const added = backLinkEdit(o, 'tags', 's3', 'x1', true)!
    expect(added[0].cells.tags).toEqual(['s1', 's2', 's3'])
    expect(o.rows[0].cells.tags).toEqual(['s1', 's2']) // 原数组没被 push
    expect(backLinkEdit({ ...o, rows: added }, 'tags', 's3', 'x1', true)).toBeNull()
    const removed = backLinkEdit(o, 'tags', 's1', 'x1', false)!
    expect(removed[0].cells.tags).toEqual(['s2'])
    const emptied = backLinkEdit(o, 'tags', 's1', 'x3', false)!
    expect('tags' in emptied[2].cells).toBe(false)
    // 旧单值形态 'x3'.tags='s1' → add s2:按列的 multiple 写数组,不是覆盖
    const up = backLinkEdit(o, 'tags', 's2', 'x3', true)!
    expect(up[2].cells.tags).toEqual(['s1', 's2'])
  })

  it('拒写:目标行不存在 / backCol 不存在 / backCol 不是 rowlink 列 → null(不造悬空、不造行)', () => {
    const o = outbound()
    expect(backLinkEdit(o, 'part', 's1', 'x9', true)).toBeNull()
    expect(backLinkEdit(o, 'nope', 's1', 'x1', true)).toBeNull()
    expect(backLinkEdit(o, 't', 's1', 'x1', true)).toBeNull()
  })
})

describe('backLinkSet(整格赋值)', () => {
  it('让指回本行的集合恰好 = targetIds:少的加、多的摘;同集 → null;空数组 = 全摘', () => {
    const o = outbound()
    // s1 现在:part 指回 x1。目标 = [x2, x3] → x1 摘掉、x2/x3 覆盖为 s1
    const rows = backLinkSet(o, 'part', 's1', ['x2', 'x3'])!
    expect(rows.map((r) => r.cells.part ?? null)).toEqual([null, 's1', 's1'])
    expect(backLinkSet({ ...o, rows }, 'part', 's1', ['x3', 'x2'])).toBeNull() // 同集(顺序无关)
    expect(backLinkSet(o, 'part', 's1', ['x1'])).toBeNull() // 已是目标态
    const none = backLinkSet(o, 'tags', 's1', [])!
    expect(none[0].cells.tags).toEqual(['s2'])
    expect('tags' in none[2].cells).toBe(false)
    // 目标行不存在的 id 被 backLinkEdit 拒掉,其余照写
    const part = backLinkSet(o, 'part', 's4', ['x9', 'x2'])!
    expect(part[1].cells.part).toBe('s4')
  })
})

describe('isLinksProjection / pairIssues', () => {
  const col = (over: Partial<DbColumn>): DbColumn => ({ id: 'c', name: 'c', type: 'lookup', refDb: OUT, lookupBackCol: 'part', lookupKind: 'links', ...over })
  const getDb = (p: string): DbFile | null => (p === OUT ? outbound() : null)

  it('判据:type=lookup + lookupKind=links + refDb + lookupBackCol 四者齐全;半配置 / 普通 lookup / rowlink 都不算', () => {
    expect(isLinksProjection(col({}))).toBe(true)
    expect(isLinksProjection(col({ lookupKind: undefined }))).toBe(false)
    expect(isLinksProjection(col({ lookupBackCol: undefined }))).toBe(false)
    expect(isLinksProjection(col({ refDb: undefined }))).toBe(false)
    expect(isLinksProjection(col({ type: 'rowlink' }))).toBe(false)
  })

  it('体检五类各恰好命中;干净配置零条;路径口径 ./ 与反斜杠不误报;非投影列不进报告', () => {
    const base = stock()
    expect(pairIssues(base, getDb, [STOCK])).toEqual([])
    expect(pairIssues(base, getDb, ['./库存.db'])).toEqual([]) // 口径归一
    const kinds = (c: DbColumn, self = [STOCK]): string | null => projectionIssue(c, getDb, self)?.kind ?? null
    expect(kinds(col({ lookupBackCol: undefined }))).toBe('half')
    expect(kinds(col({ refDb: undefined }))).toBe('half')
    expect(kinds(col({ refDb: 'gone.db' }))).toBe('target-missing')
    expect(kinds(col({ lookupBackCol: 'nope' }))).toBe('backcol-missing')
    expect(kinds(col({ lookupBackCol: 't' }))).toBe('backcol-not-rowlink')
    expect(kinds(col({}), ['别的.db'])).toBe('backcol-not-self')
    expect(kinds(col({ lookupKind: undefined }))).toBeNull() // 普通反向 lookup 不归这里管(check:rowlink 的 backcol-bad 管)
    expect(pairIssues({ ...base, columns: [...base.columns, col({ id: 'bad', lookupBackCol: 't' })] }, getDb, [STOCK]).map((i) => i.colId)).toEqual(['bad'])
  })
})
