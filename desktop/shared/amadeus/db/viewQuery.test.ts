import { describe, expect, it } from 'vitest'
import type { DbRow } from './schema'
import { FILTER_OPS, OP_LABEL, applyFilters, applySorts, computeStat, localDayKey, matchFilter, resolveDateBound, resolveDateValue } from './viewQuery'

const rows: DbRow[] = [
  { id: 'r1', cells: { name: '写文档', n: 3, done: true, tag: ['红'], d: '2026-07-10' } },
  { id: 'r2', cells: { name: '开会', n: 10, done: false, tag: ['蓝', '红'], d: '2026-07-08T14:00/2026-07-09T10:00' } },
  { id: 'r3', cells: {} },
]

describe('viewQuery 筛选求值', () => {
  it('text contains / empty / notempty', () => {
    expect(matchFilter('写文档', { colId: 'name', op: 'contains', value: '文档' }, 'text')).toBe(true)
    expect(matchFilter('写文档', { colId: 'name', op: 'notcontains', value: '会' }, 'text')).toBe(true)
    expect(matchFilter(undefined, { colId: 'name', op: 'empty' }, 'text')).toBe(true)
    expect(matchFilter('x', { colId: 'name', op: 'notempty' }, 'text')).toBe(true)
  })

  it('number 比较缺值不命中;checkbox 一元', () => {
    expect(matchFilter(3, { colId: 'n', op: 'gt', value: 2 }, 'number')).toBe(true)
    expect(matchFilter(undefined, { colId: 'n', op: 'gt', value: 2 }, 'number')).toBe(false)
    expect(matchFilter(true, { colId: 'done', op: 'checked' }, 'checkbox')).toBe(true)
    expect(matchFilter(undefined, { colId: 'done', op: 'unchecked' }, 'checkbox')).toBe(true)
  })

  it('date:单日与 calendarDate 区间统一取开始日', () => {
    expect(matchFilter('2026-07-10', { colId: 'd', op: 'on', value: '2026-07-10' }, 'date')).toBe(true)
    expect(matchFilter('2026-07-08T14:00/2026-07-09T10:00', { colId: 'd', op: 'before', value: '2026-07-09' }, 'date')).toBe(true)
    expect(matchFilter('2026-07-08T14:00/2026-07-09T10:00', { colId: 'd', op: 'after', value: '2026-07-07' }, 'date')).toBe(true)
  })

  it('multiselect has;未知 op 恒真;未知列跳过条件', () => {
    expect(matchFilter(['红', '蓝'], { colId: 'tag', op: 'has', value: '红' }, 'multiselect')).toBe(true)
    expect(matchFilter('x', { colId: 'name', op: '2030年的新op', value: 'y' }, 'text')).toBe(true)
    const out = applyFilters(rows, [{ colId: '不存在', op: 'eq', value: 'x' }], () => null)
    expect(out).toHaveLength(3)
  })

  it('applyFilters AND 组合', () => {
    const out = applyFilters(
      rows,
      [
        { colId: 'n', op: 'gt', value: 1 },
        { colId: 'tag', op: 'has', value: '红' },
      ],
      (colId) => (colId === 'n' ? 'number' : colId === 'tag' ? 'multiselect' : 'text'),
    )
    expect(out.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it("applyFilters mode='or':任一满足;未知列条件先剔除不放行全部", () => {
    const kindOf = (colId: string): 'number' | 'multiselect' | null =>
      colId === 'n' ? 'number' : colId === 'tag' ? 'multiselect' : null
    const out = applyFilters(
      rows,
      [
        { colId: 'n', op: 'gt', value: 5 }, // 只有 r2
        { colId: 'tag', op: 'has', value: '红' }, // r1 r2
      ],
      kindOf,
      'or',
    )
    expect(out.map((r) => r.id)).toEqual(['r1', 'r2'])
    // 同条件 AND 只剩 r2 —— or/and 语义确实分岔
    expect(applyFilters(rows, [{ colId: 'n', op: 'gt', value: 5 }, { colId: 'tag', op: 'has', value: '红' }], kindOf).map((r) => r.id)).toEqual(['r2'])
    // OR 下未知列条件若不剔除会放行全部行(matchFilter 未知恒真)——必须仍只按活条件求值
    expect(applyFilters(rows, [{ colId: '不存在', op: 'eq', value: 'x' }, { colId: 'n', op: 'gt', value: 5 }], kindOf, 'or').map((r) => r.id)).toEqual(['r2'])
    // 陈旧 op(改列类型留下的,如 number 列带着 text 的 contains):同样先剔除,OR 不被一条废条件放行全表
    expect(applyFilters(rows, [{ colId: 'n', op: 'contains', value: 'x' }, { colId: 'n', op: 'gt', value: 5 }], kindOf, 'or').map((r) => r.id)).toEqual(['r2'])
  })

  it('applySorts:多列逐层、稳定、方向各自生效', () => {
    const rs: DbRow[] = [
      { id: 'a', cells: { g: '甲', n: 2 } },
      { id: 'b', cells: { g: '乙', n: 1 } },
      { id: 'c', cells: { g: '甲', n: 1 } },
    ]
    const keyOf = (r: DbRow, colId: string): string | number =>
      colId === 'n' ? ((r.cells.n as number) ?? -Infinity) : String(r.cells[colId] ?? '')
    expect(applySorts(rs, [{ colId: 'g', dir: 'asc' }, { colId: 'n', dir: 'asc' }], keyOf).map((r) => r.id)).toEqual(['c', 'a', 'b'])
    expect(applySorts(rs, [{ colId: 'g', dir: 'asc' }, { colId: 'n', dir: 'desc' }], keyOf).map((r) => r.id)).toEqual(['a', 'c', 'b'])
    expect(applySorts(rs, [], keyOf)).toBe(rs)
  })

  it('统计:count/sum/avg/checked', () => {
    expect(computeStat(rows, 'name', 'text', 'count')).toBe('2')
    expect(computeStat(rows, 'name', 'text', 'empty')).toBe('1')
    expect(computeStat(rows, 'n', 'number', 'sum')).toBe('13')
    expect(computeStat(rows, 'n', 'number', 'avg')).toBe('6.5')
    expect(computeStat(rows, 'done', 'checkbox', 'checked')).toBe('1')
    expect(computeStat(rows, 'done', 'checkbox', 'unchecked')).toBe('2')
  })
})

// ── gte / lte / between + 相对日期(2026-09-02)。
// 负对照(已实跑红):between 闭区间改成开区间 → 「边界命中」红;resolveDateValue 把记号原样透传 → 「today」红;
// lo>hi 改成交换两端 → 「lo>hi 不命中」红。
describe('viewQuery gte/lte/between 与相对日期', () => {
  const NOW = new Date(2026, 8, 2, 9, 5) // 2026-09-02 本地
  const f = (op: string, value?: unknown): { colId: string; op: string; value?: never } =>
    ({ colId: 'x', op, ...(value === undefined ? {} : { value }) }) as never

  it('op 表与标签同步:number/date 都多出 gte/lte/between,标签齐全', () => {
    for (const op of ['gte', 'lte', 'between']) {
      expect(FILTER_OPS.number).toContain(op)
      expect(FILTER_OPS.date).toContain(op)
      expect(OP_LABEL[op]).toBeTruthy()
    }
    expect(FILTER_OPS.text).not.toContain('between')
  })

  it('number:gte/lte 含等号;between 闭区间,[lo,hi] 与 "lo..hi" 两种写法;形态坏 / 缺值 / lo>hi 不命中', () => {
    expect(matchFilter(5, f('gte', 5), 'number')).toBe(true)
    expect(matchFilter(4, f('gte', 5), 'number')).toBe(false)
    expect(matchFilter(5, f('lte', 5), 'number')).toBe(true)
    expect(matchFilter(6, f('lte', 5), 'number')).toBe(false)
    expect(matchFilter(1, f('between', ['1', '3']), 'number')).toBe(true) // 边界命中
    expect(matchFilter(3, f('between', '1..3'), 'number')).toBe(true)
    expect(matchFilter(4, f('between', ['1', '3']), 'number')).toBe(false)
    expect(matchFilter(2, f('between', ['3', '1']), 'number')).toBe(false) // lo>hi 不命中(不交换)
    expect(matchFilter(2, f('between', ['1']), 'number')).toBe(false)
    expect(matchFilter(2, f('between', '1-3'), 'number')).toBe(false)
    expect(matchFilter(2, f('between', ['a', '3']), 'number')).toBe(false)
    expect(matchFilter(undefined, f('between', ['1', '3']), 'number')).toBe(false)
  })

  it('date:gte/lte/between 按开始日比;calendarDate 区间串同样取开始日', () => {
    expect(matchFilter('2026-07-10', f('gte', '2026-07-10'), 'date')).toBe(true)
    expect(matchFilter('2026-07-09', f('gte', '2026-07-10'), 'date')).toBe(false)
    expect(matchFilter('2026-07-10', f('lte', '2026-07-10'), 'date')).toBe(true)
    expect(matchFilter('2026-07-08T14:00/2026-07-09T10:00', f('between', ['2026-07-08', '2026-07-08']), 'date')).toBe(true)
    expect(matchFilter('2026-07-10', f('between', '2026-07-01..2026-07-09'), 'date')).toBe(false)
    expect(matchFilter('2026-07-10', f('between', ['2026-07-01']), 'date')).toBe(false)
  })

  it('相对日期:today / yesterday / tomorrow / ±Nd / ±Nw 按 now 折算;绝对日期与空串原样', () => {
    expect(resolveDateValue('today', NOW)).toBe('2026-09-02')
    expect(resolveDateValue('Today ', NOW)).toBe('2026-09-02')
    expect(resolveDateValue('yesterday', NOW)).toBe('2026-09-01')
    expect(resolveDateValue('tomorrow', NOW)).toBe('2026-09-03')
    expect(resolveDateValue('-7d', NOW)).toBe('2026-08-26')
    expect(resolveDateValue('+30d', NOW)).toBe('2026-10-02')
    expect(resolveDateValue('-1w', NOW)).toBe('2026-08-26')
    expect(resolveDateValue('2026-01-01', NOW)).toBe('2026-01-01')
    expect(resolveDateValue(undefined, NOW)).toBe('')
    expect(resolveDateValue('7d', NOW)).toBe('7d') // 没有正负号不是记号 → 原样(当天比不中,不抛)
  })

  it('相对日期对所有 date op 生效:on today / after -7d / between [-7d, today];now 可注入', () => {
    expect(matchFilter('2026-09-02T09:00', f('on', 'today'), 'date', NOW)).toBe(true)
    expect(matchFilter('2026-09-01', f('on', 'today'), 'date', NOW)).toBe(false)
    expect(matchFilter('2026-08-27', f('after', '-7d'), 'date', NOW)).toBe(true)
    expect(matchFilter('2026-08-26', f('after', '-7d'), 'date', NOW)).toBe(false)
    expect(matchFilter('2026-08-26', f('between', ['-7d', 'today']), 'date', NOW)).toBe(true)
    expect(matchFilter('2026-09-03', f('between', ['-7d', 'today']), 'date', NOW)).toBe(false)
    expect(matchFilter('2026-08-25', f('between', '-7d..today'), 'date', NOW)).toBe(false)
    // applyFilters 透传 now
    const rs: DbRow[] = [{ id: 'a', cells: { x: '2026-09-02' } }, { id: 'b', cells: { x: '2026-08-01' } }]
    expect(applyFilters(rs, [f('gte', '-7d')], () => 'date', undefined, NOW).map((r) => r.id)).toEqual(['a'])
    expect(applyFilters(rs, [f('between', '-7d..today')], () => 'date', undefined, NOW).map((r) => r.id)).toEqual(['a'])
  })
})

// ── 日期边界 fail-closed(2026-09-02,Codex 第二波评审 [medium])。
// 负对照(已实跑红):把 want 那路换回 resolveDateValue → 「before 非法串零命中」红。
describe('viewQuery 日期边界 fail-closed', () => {
  const NOW = new Date(2026, 8, 2, 9, 5)
  const ds: DbRow[] = [
    { id: 'a', cells: { x: '2026-01-01' } },
    { id: 'b', cells: { x: '2026-07-10' } },
    { id: 'c', cells: { x: '2026-09-10T14:00/2026-09-11T09:00' } },
  ]
  const run = (op: string, value: unknown): string[] =>
    applyFilters(ds, [{ colId: 'x', op, value } as never], () => 'date', undefined, NOW).map((r) => r.id)

  it('resolveDateBound:合法 → 本地日;非法 / 溢出 / 空 → ""', () => {
    expect(resolveDateBound('2026-07-10', NOW)).toBe('2026-07-10')
    expect(resolveDateBound('today', NOW)).toBe('2026-09-02')
    expect(resolveDateBound('-7d', NOW)).toBe('2026-08-26')
    expect(resolveDateBound('2026-09-10T14:00', NOW)).toBe('2026-09-10') // 日历列落盘形态 → 开始日
    expect(resolveDateBound('2026-09-10T14:00/2026-09-11T09:00', NOW)).toBe('2026-09-10')
    expect(resolveDateBound('zzzz', NOW)).toBe('')
    expect(resolveDateBound('0000', NOW)).toBe('')
    expect(resolveDateBound('7d', NOW)).toBe('') // 没正负号不是记号,也不是日期
    expect(resolveDateBound('2026/07/10', NOW)).toBe('')
    expect(resolveDateBound('2026-02-30', NOW)).toBe('') // 形状对但那天不存在
    expect(resolveDateBound('2026-13-01', NOW)).toBe('')
    expect(resolveDateBound(undefined, NOW)).toBe('')
  })

  it('非法边界 → 该条件零命中(此前 before/gte 按字符串比大小会放行全表)', () => {
    expect(run('before', '2027-01-01')).toEqual(['a', 'b', 'c']) // 合法的对照面:确实能全中
    for (const op of ['before', 'after', 'on', 'gte', 'lte']) {
      expect([op, run(op, 'zzzz')]).toEqual([op, []])
      expect([op, run(op, '0000')]).toEqual([op, []])
      expect([op, run(op, '2026-02-30')]).toEqual([op, []])
    }
  })

  it('between:任一边非法 / lo>hi → 零命中;两边合法照常', () => {
    expect(run('between', ['2026-01-01', '2026-12-31'])).toEqual(['a', 'b', 'c'])
    expect(run('between', '0000..zzzz')).toEqual([])
    expect(run('between', ['2026-01-01', 'zzzz'])).toEqual([])
    expect(run('between', ['zzzz', '2026-12-31'])).toEqual([])
    expect(run('between', ['2026-02-30', '2026-12-31'])).toEqual([])
    expect(run('between', ['2026-12-31', '2026-01-01'])).toEqual([]) // lo>hi 不交换
  })

  it('合法相对日期 / 带时刻 ISO 仍照常(边界与单元格同按「天」比)', () => {
    expect(run('gte', 'today')).toEqual(['c'])
    expect(run('between', ['-7d', '+30d'])).toEqual(['c'])
    expect(run('on', '2026-09-10T14:00')).toEqual(['c']) // 边界归一到天 → 同日命中
    expect(run('lte', '2026-09-10T23:59')).toEqual(['a', 'b', 'c'])
    expect(run('before', '2026-09-10T14:00')).toEqual(['a', 'b']) // c 是当天,不算「早于」
  })

  it('localDayKey:本地日期串,跨午夜换天(相对日期与渲染层缓存共用这一把键)', () => {
    expect(localDayKey(new Date(2026, 8, 2, 23, 59, 59))).toBe('2026-09-02')
    expect(localDayKey(new Date(2026, 8, 3, 0, 0, 1))).toBe('2026-09-03')
    expect(localDayKey(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05') // 月/日补零
    expect(localDayKey(new Date(2026, 11, 31, 12, 0))).toBe('2026-12-31')
  })
})
