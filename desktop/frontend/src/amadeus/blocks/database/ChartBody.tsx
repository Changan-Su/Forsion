/**
 * 图表渲染(三种图形手写 SVG)+ 多维表 `chart` 视图体。
 *
 * 原住 views/dashDataCards.tsx(仪表盘围栏图表卡);图表升格为多维表的视图类型后下沉到
 * 渲染层 —— 笔记嵌入 / 独立 tab / 仪表盘卡 / web / mobile 同一份实现。三条纪律照旧:
 *  · **聚合与数字卡/统计行同源**(shared/amadeus/dashboardData 的 computeChartSlices)。
 *  · **颜色只吃 token**:同一支 `--primary` 按透明度分档,明暗两档自动跟随。
 *  · **不引图表库**。
 */
import { useContext, useMemo } from 'react'
import type { ColumnType, DbColumn, DbFile, DbRow, DbView } from '@amadeus-shared/db/schema'
import { applyFilters } from '@amadeus-shared/db/viewQuery'
import {
  chartAggOf, chartKindOf, computeChartSlices, resolveDashFilters, type Slice,
} from '@amadeus-shared/dashboardData'
import { resolveBaseType } from './propertyTypes'
import { DashFiltersCtx } from '../../dashboard/dashFiltersCtx'
import './chartBody.css'

/** chart 视图的分组列解析:记的列还在则用之;缺/失效 → 首个单选列 → 首个非身份列 → 首列。
 *  与 kanban 的「缺 = 渲染端自动挑」同一态度;视图菜单的选中态也用这一个函数,别各解各的。 */
export function resolveChartGroupCol(db: DbFile, view: DbView): DbColumn | null {
  const want = view.groupBy ? db.columns.find((c) => c.id === view.groupBy) : undefined
  if (want) return want
  return (
    db.columns.find((c) => resolveBaseType(c.type) === 'select') ??
    db.columns.find((_, i) => i > 0) ??
    db.columns[0] ??
    null
  )
}

/** 多维表 chart 视图体。`rows` 已过视图管线(每视图筛选/搜索/排序);这里再吃仪表盘的
 *  页面级筛选(DashFiltersCtx,非仪表盘宿主恒空),然后交给同源聚合。 */
export function ChartViewBody({ db, rows, view, kindOf }: {
  db: DbFile
  rows: DbRow[]
  view: DbView
  kindOf: (colId: string) => ColumnType | null
}) {
  const dashFilters = useContext(DashFiltersCtx)
  const groupCol = resolveChartGroupCol(db, view)
  const valueCol = view.valueCol ? db.columns.find((c) => c.id === view.valueCol) ?? null : null
  const agg = chartAggOf(view.agg)
  const kind = chartKindOf(view.chartKind)

  const slices = useMemo(() => {
    if (!groupCol) return []
    const scoped = dashFilters.length ? applyFilters(rows, resolveDashFilters(dashFilters, db.columns), kindOf) : rows
    return computeChartSlices(scoped, groupCol.id, valueCol?.id ?? null, agg)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kindOf 只依赖 db.columns(已在列)
  }, [rows, dashFilters, db.columns, groupCol?.id, valueCol?.id, agg])

  if (!groupCol) return <div className="amx-db-state">没有可分组的列 —— 先添加一列。</div>
  if (!slices.length) return <div className="amx-db-state">没有符合条件的数据。</div>
  return (
    <div className="amx-db-chartbody">
      {kind === 'donut' ? <Donut slices={slices} /> : kind === 'line' ? <Line slices={slices} /> : <Bars slices={slices} />}
    </div>
  )
}

/** 数字标签:整数不带小数,小数留两位(与 viewQuery 的 trimNum 观感一致)。 */
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))
/** 同一支 --primary 按透明度分档:明暗两档自动跟随,不会在暗色里烧穿。 */
const tone = (i: number, n: number): string =>
  `color-mix(in srgb, var(--primary) ${Math.round(100 - (i / Math.max(1, n - 1)) * 62)}%, transparent)`

/** 横向条:中文标签横着放才不打架(竖条得转 45° 或截断)。 */
export function Bars({ slices }: { slices: Slice[] }) {
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
export function Line({ slices }: { slices: Slice[] }) {
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
export function Donut({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((a, s) => a + s.value, 0)
  // 中性类不吃 .amx-db 上下文:Donut 同时活在多维表视图与仪表盘围栏卡里。
  if (total <= 0) return <div className="dash-chart-empty">合计为 0,画不出环图。</div>
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
