/** 仪表盘数据层:规格解析 / 属性名解析 / 页面级筛选真的生效 / 图表分组与「其他」/ frontmatter 三态。 */
import { describe, expect, it } from 'vitest'
import type { ColumnType, DbColumn, DbRow } from './db/schema'
import {
  CHART_MAX_GROUPS, DASH_FILTER_FM_KEY, STAT_ROWS, columnByName, computeChartCard, computeStatCard,
  filtersUnderstoodBy, groupLabel, parseChartSpec, parseStatSpec, readDashFilters, resolveDashFilters,
  setDashFiltersInFm, type DashFilter,
} from './dashboardData'

const cols: DbColumn[] = [
  { id: 'c1', name: '状态', type: 'select', options: ['进行中', '已完成'] },
  { id: 'c2', name: '金额', type: 'number' },
  { id: 'c3', name: '负责人', type: 'text' },
]
const kindOf = (id: string): ColumnType | null =>
  id === 'c1' ? 'select' : id === 'c2' ? 'number' : id === 'c3' ? 'text' : null

const rows: DbRow[] = [
  { id: 'r1', cells: { c1: '进行中', c2: 100, c3: '甲' } },
  { id: 'r2', cells: { c1: '进行中', c2: 200, c3: '乙' } },
  { id: 'r3', cells: { c1: '已完成', c2: 50, c3: '甲' } },
  { id: 'r4', cells: { c1: '已完成', c2: null, c3: '' } },
]

describe('规格解析', () => {
  it('数字卡:缺 source 拒;非 rows 统计必须给 col;缺省 stat = rows', () => {
    expect(parseStatSpec({}).ok).toBe(false)
    expect(parseStatSpec({ source: 'a.db', stat: 'sum' }).ok).toBe(false)
    const r = parseStatSpec({ source: 'a.db' })
    expect(r.ok && r.spec.stat).toBe(STAT_ROWS)
  })

  it('图表卡:缺 group 拒;非 count 聚合必须给 value;不认识的 kind/agg 拒', () => {
    expect(parseChartSpec({ source: 'a.db' }).ok).toBe(false)
    expect(parseChartSpec({ source: 'a.db', group: '状态', agg: 'sum' }).ok).toBe(false)
    expect(parseChartSpec({ source: 'a.db', group: '状态', kind: '饼' }).ok).toBe(false)
    expect(parseChartSpec({ source: 'a.db', group: '状态', agg: '中位数' }).ok).toBe(false)
    const r = parseChartSpec({ source: 'a.db', group: '状态' })
    expect(r.ok && [r.spec.agg, r.spec.kind]).toEqual(['count', 'bar'])
  })
})

describe('属性名 → 列', () => {
  it('精确优先,其次忽略大小写与空白;找不到给 null', () => {
    expect(columnByName(cols, '状态')?.id).toBe('c1')
    expect(columnByName(cols, ' 状态 ')?.id).toBe('c1')
    expect(columnByName([{ id: 'x', name: 'Status', type: 'text' }], 'status')?.id).toBe('x')
    expect(columnByName(cols, '不存在')).toBe(null)
  })

  it('⚠️这张 db 里没有的属性 → 这一条筛选被丢掉(而不是把整张卡过滤空)', () => {
    const f: DashFilter[] = [{ prop: '状态', op: 'eq', value: '进行中' }, { prop: '不存在', op: 'eq', value: 'x' }]
    expect(resolveDashFilters(f, cols)).toEqual([{ colId: 'c1', op: 'eq', value: '进行中' }])
    expect(filtersUnderstoodBy(f, cols)).toEqual(['状态'])
  })
})

describe('数字卡:先筛选再统计', () => {
  const noFilter: DashFilter[] = []
  const onlyRunning: DashFilter[] = [{ prop: '状态', op: 'eq', value: '进行中' }]

  it('rows = 行数本身(不看列)', () => {
    const parsed = parseStatSpec({ source: 'a.db' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(computeStatCard(rows, cols, parsed.spec, noFilter, kindOf).text).toBe('4')
  })

  it('页面级筛选真的收窄了统计范围(负对照:不加筛选是 4/350)', () => {
    const spec = { source: 'a.db', col: '金额', stat: 'sum', label: '', unit: '', literal: null }
    expect(computeStatCard(rows, cols, spec, noFilter, kindOf).text).toBe('350')
    expect(computeStatCard(rows, cols, spec, onlyRunning, kindOf).text).toBe('300')
    const rowSpec = { source: 'a.db', col: null, stat: STAT_ROWS, label: '', unit: '', literal: null }
    expect(computeStatCard(rows, cols, rowSpec, noFilter, kindOf).text).toBe('4')
    expect(computeStatCard(rows, cols, rowSpec, onlyRunning, kindOf).text).toBe('2')
  })

  it('列名找不到 → 显示 –,不抛', () => {
    const spec = { source: 'a.db', col: '不存在', stat: 'sum', label: '', unit: '', literal: null }
    expect(computeStatCard(rows, cols, spec, noFilter, kindOf).text).toBe('–')
  })

  it('统计与多维表的统计行同源(computeStat),不另算一份', () => {
    const spec = { source: 'a.db', col: '金额', stat: 'avg', label: '', unit: '', literal: null }
    // 三个非空数值 100/200/50 → 平均 116.67(trimNum 两位)
    expect(computeStatCard(rows, cols, spec, noFilter, kindOf).text).toBe('116.67')
  })
})

describe('图表卡', () => {
  const spec = { source: 'a.db', group: '状态', value: null, agg: 'count' as const, kind: 'bar' as const, label: '' }

  it('按分组计数,降序;同值时按 key 排(顺序必须**确定**,不能每次渲染换位置)', () => {
    const got = computeChartCard(rows, cols, spec, [], kindOf)
    expect(got.slices.map((s) => s.value)).toEqual([2, 2])
    expect(new Set(got.slices.map((s) => s.key))).toEqual(new Set(['进行中', '已完成']))
    // 确定性:同样输入跑两次,顺序逐字相同
    expect(computeChartCard(rows, cols, spec, [], kindOf).slices).toEqual(got.slices)
    // 值不同的时候真的降序
    const skew = [...rows, { id: 'r5', cells: { c1: '进行中' } }]
    expect(computeChartCard(skew, cols, spec, [], kindOf).slices[0]).toEqual({ key: '进行中', value: 3 })
  })

  it('求和跳过非数值;平均按参与行数算', () => {
    const sum = computeChartCard(rows, cols, { ...spec, value: '金额', agg: 'sum' }, [], kindOf)
    expect(sum.slices).toEqual([{ key: '进行中', value: 300 }, { key: '已完成', value: 50 }])
    const avg = computeChartCard(rows, cols, { ...spec, value: '金额', agg: 'avg' }, [], kindOf)
    expect(avg.slices.find((s) => s.key === '已完成')?.value).toBe(50) // r4 的 null 不拉低平均
  })

  it('页面级筛选同样先生效', () => {
    const got = computeChartCard(rows, cols, spec, [{ prop: '状态', op: 'eq', value: '进行中' }], kindOf)
    expect(got.slices).toEqual([{ key: '进行中', value: 2 }])
  })

  it('空值有统一标签,不出现 undefined', () => {
    expect(groupLabel(undefined)).toBe('(空)')
    expect(groupLabel([])).toBe('(空)')
    expect(groupLabel(true)).toBe('是')
  })

  it('分组过多 → 并成「其他」而不是悄悄截断(总量守恒)', () => {
    const many: DbRow[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, cells: { c1: `分组${i}` } }))
    const got = computeChartCard(many, cols, spec, [], kindOf)
    expect(got.slices.length).toBe(CHART_MAX_GROUPS)
    expect(got.slices[got.slices.length - 1].key).toMatch(/^其他\(/)
    expect(got.slices.reduce((a, s) => a + s.value, 0)).toBe(40) // 一行都没丢
  })

  it('找不到分组列 → 给出错误而不是空图', () => {
    expect(computeChartCard(rows, cols, { ...spec, group: '不存在' }, [], kindOf).error).toContain('不存在')
  })
})

describe('页面级筛选的 frontmatter 三态', () => {
  it('往返;别的键原样保留', () => {
    const text = setDashFiltersInFm('dashboard3:\n  "1": [0, 6, 3]\nx: 1', [{ prop: '状态', op: 'eq', value: '进行中' }])
    expect(readDashFilters(text!)).toEqual({ ok: true, filters: [{ prop: '状态', op: 'eq', value: '进行中' }] })
    expect(text).toContain('dashboard3:')
    expect(text).toContain('x: 1')
  })

  it('空列表 → 删键', () => {
    const text = setDashFiltersInFm(`${DASH_FILTER_FM_KEY}:\n  - { prop: 状态, op: eq }\nx: 1`, [])
    expect(text).not.toContain(DASH_FILTER_FM_KEY)
    expect(text).toContain('x: 1')
  })

  it('键不存在 = 没有筛选;坏 YAML / 不是列表 / 条目缺字段 / value 非标量 → 一律冻结', () => {
    expect(readDashFilters('x: 1')).toEqual({ ok: true, filters: [] })
    expect(readDashFilters(`${DASH_FILTER_FM_KEY}: [unclosed`).ok).toBe(false)
    expect(readDashFilters(`${DASH_FILTER_FM_KEY}: 3`).ok).toBe(false)
    expect(readDashFilters(`${DASH_FILTER_FM_KEY}:\n  - op: eq`).ok).toBe(false)
    expect(readDashFilters(`${DASH_FILTER_FM_KEY}:\n  - { prop: 状态 }`).ok).toBe(false)
    expect(readDashFilters(`${DASH_FILTER_FM_KEY}:\n  - { prop: 状态, op: eq, value: [1, 2] }`).ok).toBe(false)
    expect(setDashFiltersInFm(`${DASH_FILTER_FM_KEY}: [unclosed`, [])).toBe(null)
  })
})
