// Dashboard 的数据层(2026-08-27 拍板的「功能」缺口):数字卡 / 图表卡 / **页面级筛选**。
//
// 定位:这一层把 Dashboard 从「一屏里挤了几个面板」变成**一个复合 view**。分界线就是页面级筛选 ——
// 一处改、全页跟随(Notion Dashboards 的 global filter 同款)。没有它,卡片之间没有任何关系。
//
// 三条刻意的取舍:
//  ① **不自造查询引擎**。过滤走 `db/viewQuery` 的 `applyFilters`,统计走它的 `computeStat` ——
//     多维表视图用的就是这两个,数字卡和表格里的统计行必须逐字同源,否则同一份数据两个数。
//  ② **页面级筛选按「属性名」而不是 colId 匹配**。一张仪表盘上的卡片来自不同的 .db,colId 各是各的;
//     按名字找、找不到就**这张卡不受该条筛选影响**(Notion 的规则:widget 里有这个属性才跟着变)。
//  ③ 数据源只认 `.db` 文件。笔记 YAML 属性的查询是 Obsidian Bases 那个体量,不在本轮。

import { Document, parseDocument } from 'yaml'
import type { CellValue, ColumnType, DbColumn, DbRow, DbViewFilter } from './db/schema'
import { applyFilters, computeStat } from './db/viewQuery'

/** frontmatter 里的页面级筛选键(外来键,与 dashboard3: 同族)。 */
export const DASH_FILTER_FM_KEY = 'dashFilter'

/** 页面级筛选的一条。`prop` 是**属性名**(不是 colId),`op`/`value` 与 DbViewFilter 同义。 */
export interface DashFilter {
  prop: string
  op: string
  value?: string
}

// ───────────────────────────── 数字卡 ─────────────────────────────

/** `rows` = 行数本身(不看任何列)。这是仪表盘上最常见的那个数字 —— 「今天几件待办」。
 *  viewQuery 的 `count` 是「某列非空的行数」,语义不同,不能拿来顶。 */
export const STAT_ROWS = 'rows'

export interface StatSpec {
  source: string
  /** `rows` 统计不需要列;其余必须有。 */
  col: string | null
  stat: string
  label: string
  /** 单位后缀(纯装饰,如「件」「元」)。 */
  unit: string
}

export type SpecResult<T> = { ok: true; spec: T } | { ok: false; error: string }

export function parseStatSpec(opts: Record<string, string>): SpecResult<StatSpec> {
  const source = (opts.source || '').trim()
  if (!source) return { ok: false, error: '缺 source:(.db 文件路径)' }
  const stat = (opts.stat || STAT_ROWS).trim()
  const col = (opts.col || '').trim() || null
  if (stat !== STAT_ROWS && !col) return { ok: false, error: `统计「${stat}」需要 col:(列名)` }
  return { ok: true, spec: { source, col, stat, label: (opts.label || '').trim(), unit: (opts.unit || '').trim() } }
}

// ───────────────────────────── 图表卡 ─────────────────────────────

export const CHART_KINDS = ['bar', 'line', 'donut'] as const
export type ChartKind = (typeof CHART_KINDS)[number]
export const CHART_AGGS = ['count', 'sum', 'avg'] as const
export type ChartAgg = (typeof CHART_AGGS)[number]
/** 分组上限。再多就不是图了,是一堵墙;超出的并进「其他」。 */
export const CHART_MAX_GROUPS = 12

export interface ChartSpec {
  source: string
  /** 按哪一列分组(列名)。 */
  group: string
  /** 聚合哪一列;`count` 时可以没有。 */
  value: string | null
  agg: ChartAgg
  kind: ChartKind
  label: string
}

export function parseChartSpec(opts: Record<string, string>): SpecResult<ChartSpec> {
  const source = (opts.source || '').trim()
  if (!source) return { ok: false, error: '缺 source:(.db 文件路径)' }
  const group = (opts.group || '').trim()
  if (!group) return { ok: false, error: '缺 group:(按哪一列分组)' }
  const agg = (opts.agg || 'count').trim() as ChartAgg
  if (!CHART_AGGS.includes(agg)) return { ok: false, error: `不认识的聚合「${agg}」(count/sum/avg)` }
  const value = (opts.value || '').trim() || null
  if (agg !== 'count' && !value) return { ok: false, error: `聚合「${agg}」需要 value:(列名)` }
  const kind = (opts.kind || 'bar').trim() as ChartKind
  if (!CHART_KINDS.includes(kind)) return { ok: false, error: `不认识的图形「${kind}」(bar/line/donut)` }
  return { ok: true, spec: { source, group, value, agg, kind, label: (opts.label || '').trim() } }
}

// ───────────────────── 属性名 → 列(页面级筛选的落地点) ─────────────────────

/** 按名字找列。先精确、再忽略大小写与首尾空白 —— 用户在筛选栏里敲的是他在表头看到的那几个字。 */
export function columnByName(columns: DbColumn[], name: string): DbColumn | null {
  const want = name.trim()
  if (!want) return null
  return (
    columns.find((c) => c.name === want) ??
    columns.find((c) => c.name.trim().toLowerCase() === want.toLowerCase()) ??
    null
  )
}

/** 页面级筛选 → 这张卡自己那份 db 的 DbViewFilter[]。
 *  **这张 db 里没有这个属性 → 这一条被丢掉**(而不是把整张卡过滤空):卡片只响应它认识的维度。 */
export function resolveDashFilters(filters: DashFilter[], columns: DbColumn[]): DbViewFilter[] {
  const out: DbViewFilter[] = []
  for (const f of filters) {
    const col = columnByName(columns, f.prop)
    if (!col) continue
    out.push({ colId: col.id, op: f.op, value: f.value ?? '' })
  }
  return out
}

/** 这张 db 认得页面级筛选里的哪几条(筛选栏据此显示「N 张卡片受影响」)。 */
export function filtersUnderstoodBy(filters: DashFilter[], columns: DbColumn[]): string[] {
  return filters.filter((f) => columnByName(columns, f.prop)).map((f) => f.prop)
}

// ───────────────────────────── 取数 ─────────────────────────────

export interface StatValue {
  text: string
  /** 参与统计的行数(卡片副标题用:「共 N 行」)。 */
  rows: number
}

/** 数字卡的值。**先过页面级筛选,再统计** —— 顺序反了,筛选就等于没有。 */
export function computeStatCard(
  rows: DbRow[],
  columns: DbColumn[],
  spec: StatSpec,
  dashFilters: DashFilter[],
  kindOf: (colId: string) => ColumnType | null,
): StatValue {
  const scoped = applyFilters(rows, resolveDashFilters(dashFilters, columns), kindOf)
  if (spec.stat === STAT_ROWS) return { text: String(scoped.length), rows: scoped.length }
  const col = spec.col ? columnByName(columns, spec.col) : null
  if (!col) return { text: '–', rows: scoped.length }
  return { text: computeStat(scoped, col.id, kindOf(col.id) ?? 'text', spec.stat), rows: scoped.length }
}

export interface Slice {
  key: string
  value: number
}

const numOf = (v: CellValue | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 分组标签。多选取第一项、勾选转是/否、空值统一成「(空)」—— 图上不能出现 undefined。 */
export const groupLabel = (v: CellValue | undefined): string => {
  if (v === null || v === undefined || v === '') return '(空)'
  if (Array.isArray(v)) return v.length ? String(v[0]) : '(空)'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}

/**
 * 图表卡的数据。同样**先过页面级筛选**。
 * 分组按值降序;超过 CHART_MAX_GROUPS 的尾巴并成「其他」(不是截断丢掉 —— 悄悄丢数据比难看更糟)。
 */
export function computeChartCard(
  rows: DbRow[],
  columns: DbColumn[],
  spec: ChartSpec,
  dashFilters: DashFilter[],
  kindOf: (colId: string) => ColumnType | null,
): { slices: Slice[]; error?: string } {
  const groupCol = columnByName(columns, spec.group)
  if (!groupCol) return { slices: [], error: `找不到列「${spec.group}」` }
  const valueCol = spec.value ? columnByName(columns, spec.value) : null
  if (spec.agg !== 'count' && !valueCol) return { slices: [], error: `找不到列「${spec.value}」` }

  const scoped = applyFilters(rows, resolveDashFilters(dashFilters, columns), kindOf)
  const buckets = new Map<string, { sum: number; n: number }>()
  for (const r of scoped) {
    const key = groupLabel(r.cells[groupCol.id])
    const b = buckets.get(key) ?? { sum: 0, n: 0 }
    if (spec.agg === 'count') b.n += 1
    else {
      const n = numOf(r.cells[valueCol!.id])
      if (n === null) continue // 非数值不参与求和/平均(计数已在上面算过)
      b.sum += n
      b.n += 1
    }
    buckets.set(key, b)
  }

  const all: Slice[] = [...buckets].map(([key, b]) => ({
    key,
    value: spec.agg === 'count' ? b.n : spec.agg === 'sum' ? b.sum : b.n ? b.sum / b.n : 0,
  }))
  all.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
  if (all.length <= CHART_MAX_GROUPS) return { slices: all }
  const head = all.slice(0, CHART_MAX_GROUPS - 1)
  const tail = all.slice(CHART_MAX_GROUPS - 1)
  head.push({ key: `其他(${tail.length})`, value: tail.reduce((a, s) => a + s.value, 0) })
  return { slices: head }
}

// ─────────────────── 页面级筛选的 frontmatter 读写 ───────────────────

export type FilterRead = { ok: true; filters: DashFilter[] } | { ok: false; error: string }

/** 读页面级筛选。三态与 dashboard3 同构:键不存在 = 没有筛选;有内容但读不懂 = 冻结。 */
export function readDashFilters(fmExtra: string): FilterRead {
  if (!fmExtra.trim()) return { ok: true, filters: [] }
  const doc = parseDocument(fmExtra)
  if (doc.errors.length) return { ok: false, error: doc.errors[0].message.split('\n')[0] }
  const obj = doc.toJS() as unknown
  if (obj === null || obj === undefined) return { ok: true, filters: [] }
  if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'frontmatter 根节点不是映射' }
  const raw = (obj as Record<string, unknown>)[DASH_FILTER_FM_KEY]
  if (raw === undefined || raw === null) return { ok: true, filters: [] }
  if (!Array.isArray(raw)) return { ok: false, error: `${DASH_FILTER_FM_KEY} 不是列表` }
  const out: DashFilter[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: `${DASH_FILTER_FM_KEY} 的条目不是映射` }
    const o = item as Record<string, unknown>
    if (typeof o.prop !== 'string' || !o.prop.trim()) return { ok: false, error: `${DASH_FILTER_FM_KEY} 的条目缺 prop` }
    if (typeof o.op !== 'string' || !o.op.trim()) return { ok: false, error: `${DASH_FILTER_FM_KEY} 的条目缺 op` }
    if (o.value !== undefined && typeof o.value !== 'string' && typeof o.value !== 'number' && typeof o.value !== 'boolean') {
      return { ok: false, error: `${DASH_FILTER_FM_KEY} 的 value 只能是标量` }
    }
    out.push({ prop: o.prop, op: o.op, ...(o.value === undefined ? {} : { value: String(o.value) }) })
  }
  return { ok: true, filters: out }
}

/** 写页面级筛选(只动这一个键;走 yaml Document 保注释与键序,同 setDash3InFm 的教训)。 */
export function setDashFiltersInFm(fmExtra: string, filters: DashFilter[]): string | null {
  const doc = fmExtra.trim() ? parseDocument(fmExtra) : new Document({})
  if (doc.errors.length) return null
  if (!filters.length) doc.delete(DASH_FILTER_FM_KEY)
  else {
    const node = doc.createNode(filters.map((f) => ({ prop: f.prop, op: f.op, ...(f.value === undefined ? {} : { value: f.value }) })))
    if ('items' in node) for (const it of (node as { items: Array<{ flow?: boolean }> }).items) {
      if (it && typeof it === 'object') it.flow = true // 一行一条,md 里读得下去
    }
    doc.set(DASH_FILTER_FM_KEY, node)
  }
  return String(doc).replace(/\n+$/, '')
}
