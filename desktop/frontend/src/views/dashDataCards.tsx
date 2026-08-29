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
 *  · **不引图表库**。三种图形手写 SVG 一共百来行,加一个依赖换不来任何东西。
 */
import { useEffect, useMemo } from 'react'
import { useDbStore } from '@amadeus/store/dbStore'
import { resolveBaseType } from '@amadeus/blocks/database/propertyTypes'
import type { ColumnType } from '@amadeus-shared/db/schema'
import {
  computeChartCard, computeStatCard, parseChartSpec, parseStatSpec,
  type ChartSpec, type DashFilter, type Slice, type StatSpec,
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

/** 数字标签:整数不带小数,小数留两位(与 viewQuery 的 trimNum 观感一致)。 */
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))
/** 同一支 --primary 按透明度分档:明暗两档自动跟随,不会在暗色里烧穿。 */
const tone = (i: number, n: number): string =>
  `color-mix(in srgb, var(--primary) ${Math.round(100 - (i / Math.max(1, n - 1)) * 62)}%, transparent)`

/** 横向条:中文标签横着放才不打架(竖条得转 45° 或截断)。 */
function Bars({ slices }: { slices: Slice[] }) {
  const max = Math.max(...slices.map((s) => s.value), 1)
  return (
    <div className="dash-bars">
      {slices.map((s, i) => (
        <div className="dash-bar-row" key={s.key} title={`${s.key}:${fmt(s.value)}`}>
          <span className="dash-bar-key">{s.key}</span>
          <span className="dash-bar-track">
            <span className="dash-bar-fill" style={{ width: `${(s.value / max) * 100}%`, background: tone(i, slices.length) }} />
          </span>
          <span className="dash-bar-val">{fmt(s.value)}</span>
        </div>
      ))}
    </div>
  )
}

/** 折线:x 轴是分组。**按 key 排序** —— 折线读的是「沿着某个次序的走势」,拿按值降序的顺序画折线
 *  是在骗人(那条线永远单调下降)。 */
function Line({ slices }: { slices: Slice[] }) {
  const pts = [...slices].sort((a, b) => a.key.localeCompare(b.key))
  const max = Math.max(...pts.map((p) => p.value), 1)
  const min = Math.min(...pts.map((p) => p.value), 0)
  const span = max - min || 1
  const W = 100
  const H = 46
  const xy = pts.map((p, i) => [pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W, H - ((p.value - min) / span) * H] as const)
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  return (
    <div className="dash-line">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="dash-line-svg" aria-hidden="true">
        <path d={`${d} L${W},${H} L0,${H} Z`} fill="color-mix(in srgb, var(--primary) 14%, transparent)" />
        <path d={d} fill="none" stroke="var(--primary)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="dash-line-axis">
        {pts.map((p) => <span key={p.key} title={`${p.key}:${fmt(p.value)}`}>{p.key}</span>)}
      </div>
    </div>
  )
}

/** 环图。总和为 0 时不画(除零会得到 NaN 的 path,SVG 直接吞掉 = 一片空白且无从排查)。 */
function Donut({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((a, s) => a + s.value, 0)
  if (total <= 0) return <Note>合计为 0,画不出环图</Note>
  const R = 16
  const C = 2 * Math.PI * R
  let acc = 0
  return (
    <div className="dash-donut">
      <svg viewBox="0 0 48 48" className="dash-donut-svg" aria-hidden="true">
        <g transform="rotate(-90 24 24)">
          {slices.map((s, i) => {
            const len = (s.value / total) * C
            const el = (
              <circle
                key={s.key}
                cx="24" cy="24" r={R}
                fill="none"
                stroke={tone(i, slices.length)}
                strokeWidth="9"
                strokeDasharray={`${len.toFixed(3)} ${(C - len).toFixed(3)}`}
                strokeDashoffset={(-acc).toFixed(3)}
              />
            )
            acc += len
            return el
          })}
        </g>
      </svg>
      <div className="dash-donut-legend">
        {slices.map((s, i) => (
          <span className="dash-donut-item" key={s.key} title={`${s.key}:${fmt(s.value)}`}>
            <i style={{ background: tone(i, slices.length) }} />
            <b>{s.key}</b>
            <em>{fmt(s.value)}</em>
          </span>
        ))}
      </div>
    </div>
  )
}
