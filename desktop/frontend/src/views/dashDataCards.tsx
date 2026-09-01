/**
 * 数据卡:数字卡(stat)与图表卡(chart)。
 *
 * 这两张卡 + 页面级筛选,是把 Dashboard 从「一屏里挤了几个面板」变成**一个复合 view** 的那一步。
 * 纯逻辑(规格解析 / 属性名解析 / 聚合 / 筛选落地)全在 `@amadeus-shared/dashboardData`,
 * 本文件只负责:把 `.db` 拉进来、把算好的数画出来。
 *
 * 三条纪律:
 *  · **统计与多维表的统计行同源**(shared 层调 viewQuery 的 computeStat)—— 同一份数据不能有两个数。
 *  · **颜色只吃 token**。图表不引色板:同一支 `--primary` 按透明度分档,与桌面端的克制观感一致,
 *    而且明暗两档自动跟随(自造 hex 会在暗色里烧穿)。
 *  · **不引图表库**。三种图形手写 SVG 住渲染层 ChartBody(多维表 chart 视图同一份实现)。
 */
import { useEffect, useMemo } from 'react'
import { useDbStore } from '@amadeus/store/dbStore'
import { resolveBaseType } from '@amadeus/blocks/database/propertyTypes'
import { Bars, Donut, Line } from '@amadeus/blocks/database/ChartBody'
import type { ColumnType } from '@amadeus-shared/db/schema'
import {
  computeChartCard, computeStatCard, parseChartSpec, parseStatSpec,
  type ChartSpec, type DashFilter, type StatSpec,
} from '@amadeus-shared/dashboardData'
import './dashData.css'

const Note = ({ children }: { children: React.ReactNode }) => (
  <div className="dash-widget"><div className="dash-widget-note">{children}</div></div>
)

/** 把一个 `.db` 拉进共享 store。ref 用完整 vault 相对路径 —— 与 AmadeusDbView / 嵌入块同一约定,
 *  同一份 db 的多处引用命中同一 entry(数据共享、写穿互见)。 */
function useDb(path: string) {
  useEffect(() => { if (path) void useDbStore.getState().load(path, path) }, [path])
  return useDbStore((s) => (path ? s.entries[path] : undefined))
}

/** 列 id → 语义类型。筛选与统计都要它;判定单源走 propertyTypes,别在这里另立一张表。 */
function kindOfFactory(columns: { id: string; type: string }[]): (id: string) => ColumnType | null {
  const map = new Map(columns.map((c) => [c.id, resolveBaseType(c.type)]))
  return (id) => map.get(id) ?? null
}

// ───────────────────────────── 数字卡 ─────────────────────────────

export function StatCard({ opts, filters }: { opts: Record<string, string>; filters: DashFilter[] }) {
  const parsed = useMemo(() => parseStatSpec(opts), [JSON.stringify(opts)]) // eslint-disable-line react-hooks/exhaustive-deps
  const path = parsed.ok ? parsed.spec.source : ''
  const entry = useDb(path)
  if (!parsed.ok) return <Note>数字卡:{parsed.error}</Note>
  return <StatBody spec={parsed.spec} entry={entry} filters={filters} />
}

function StatBody({ spec, entry, filters }: { spec: StatSpec; entry: ReturnType<typeof useDb>; filters: DashFilter[] }) {
  const value = useMemo(() => {
    if (!entry?.data) return null
    const kindOf = kindOfFactory(entry.data.columns)
    return computeStatCard(entry.data.rows, entry.data.columns, spec, filters, kindOf)
  }, [entry?.data, spec, filters])

  if (!entry || entry.status === 'loading') return <Note>加载中…</Note>
  if (entry.status === 'missing') return <Note>找不到「{spec.source}」</Note>
  if (entry.status === 'corrupt') return <Note>「{spec.source}」读不出来:{entry.message}</Note>
  if (!value) return <Note>无数据</Note>

  const label = spec.label || (spec.col ? `${spec.col} · ${spec.stat}` : entry.data?.name || '行数')
  return (
    <div className="dash-widget dash-stat">
      <div className="dash-stat-value">
        {value.text}
        {spec.unit && <span className="dash-stat-unit">{spec.unit}</span>}
      </div>
      <div className="dash-stat-label">{label}</div>
      {!!filters.length && <div className="dash-stat-sub">共 {value.rows} 行(已按页面筛选)</div>}
    </div>
  )
}

// ───────────────────────────── 图表卡 ─────────────────────────────

export function ChartCard({ opts, filters }: { opts: Record<string, string>; filters: DashFilter[] }) {
  const parsed = useMemo(() => parseChartSpec(opts), [JSON.stringify(opts)]) // eslint-disable-line react-hooks/exhaustive-deps
  const path = parsed.ok ? parsed.spec.source : ''
  const entry = useDb(path)
  if (!parsed.ok) return <Note>图表卡:{parsed.error}</Note>
  return <ChartBody spec={parsed.spec} entry={entry} filters={filters} />
}

function ChartBody({ spec, entry, filters }: { spec: ChartSpec; entry: ReturnType<typeof useDb>; filters: DashFilter[] }) {
  const res = useMemo(() => {
    if (!entry?.data) return null
    const kindOf = kindOfFactory(entry.data.columns)
    return computeChartCard(entry.data.rows, entry.data.columns, spec, filters, kindOf)
  }, [entry?.data, spec, filters])

  if (!entry || entry.status === 'loading') return <Note>加载中…</Note>
  if (entry.status === 'missing') return <Note>找不到「{spec.source}」</Note>
  if (entry.status === 'corrupt') return <Note>「{spec.source}」读不出来:{entry.message}</Note>
  if (!res) return <Note>无数据</Note>
  if (res.error) return <Note>图表卡:{res.error}</Note>
  if (!res.slices.length) return <Note>没有符合条件的数据</Note>

  const title = spec.label || `${spec.group} · ${spec.agg === 'count' ? '计数' : `${spec.value} ${spec.agg === 'sum' ? '求和' : '平均'}`}`
  return (
    <div className="dash-chart">
      <div className="dash-chart-title">{title}</div>
      <div className="dash-chart-body">
        {spec.kind === 'donut' ? <Donut slices={res.slices} /> : spec.kind === 'line' ? <Line slices={res.slices} /> : <Bars slices={res.slices} />}
      </div>
    </div>
  )
}
