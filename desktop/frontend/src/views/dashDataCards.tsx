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
import { useEffect, useMemo, useState } from 'react'
import { useDbStore } from '@amadeus/store/dbStore'
import { resolveBaseType } from '@amadeus/blocks/database/propertyTypes'
import { Bars, Donut, Line } from '@amadeus/blocks/database/ChartBody'
import { localDayKey } from '@amadeus-shared/db/viewQuery'
import type { ColumnType } from '@amadeus-shared/db/schema'
import {
  computeChartCard, computeStatCard, parseChartSpec, parseStatSpec,
  type ChartSpec, type DashFilter, type StatSpec,
} from '@amadeus-shared/dashboardData'
import { registerMessages, useI18n } from '../i18n'
import './dashData.css'

registerMessages({
  'dashcards.statError': { zh: '数字卡:{err}', en: 'Stat card: {err}' },
  'dashcards.chartError': { zh: '图表卡:{err}', en: 'Chart card: {err}' },
  'dashcards.loading': { zh: '加载中…', en: 'Loading…' },
  'dashcards.missing': { zh: '找不到「{source}」', en: 'Can’t find “{source}”' },
  'dashcards.corrupt': { zh: '「{source}」读不出来:{err}', en: 'Can’t read “{source}”: {err}' },
  'dashcards.noData': { zh: '无数据', en: 'No data' },
  'dashcards.noMatch': { zh: '没有符合条件的数据', en: 'No data matches the filters' },
  'dashcards.rowCount': { zh: '行数', en: 'Row count' },
  'dashcards.filteredRows': { zh: '共 {n} 行(已按页面筛选)', en: '{n} rows (page filters applied)' },
  'dashcards.aggCount': { zh: '计数', en: 'Count' },
  'dashcards.aggSum': { zh: '{col} 求和', en: 'Sum of {col}' },
  'dashcards.aggAvg': { zh: '{col} 平均', en: 'Average of {col}' },
})

const Note = ({ children }: { children: React.ReactNode }) => (
  <div className="dash-widget"><div className="dash-widget-note">{children}</div></div>
)

/** 把一个 `.db` 拉进共享 store。ref 用完整 vault 相对路径 —— 与 AmadeusDbView / 嵌入块同一约定,
 *  同一份 db 的多处引用命中同一 entry(数据共享、写穿互见)。 */
function useDb(path: string) {
  const gen = useDbStore((s) => s.gen) // 缓存整片作废后重读(见 dbStore 的 gen)
  useEffect(() => { if (path) void useDbStore.getState().load(path, path) }, [path, gen])
  return useDbStore((s) => (path ? s.entries[path] : undefined))
}

/** 本地日键 hook:跨过本地午夜就换值。绑定视图里的相对日期(`today` / `-7d`)是每次求值按当前时刻折算的,
 *  卡片的 useMemo 若不把「今天是哪天」纳入依赖,页面开着过午夜就一直显示昨天的数(Codex 第二波评审 [medium])。
 *  ponytail: 就一支 setTimeout 睡到下一个本地午夜,不建全局订阅中心也不做每分钟轮询 —— 一屏卡片是个位数;
 *  卸载 clear。effect 依赖 `[key, tick]`:换天了靠 key 变化重排下一班(正路);tick 保证 key **没**变时
 *  (定时器早到、系统时钟被拨回 → setKey 是 no-op)也重排,否则那一支之后就再也没有定时器了。 */
export function useDayKey(): string {
  const [key, setKey] = useState(localDayKey)
  const [tick, setTick] = useState(0) // 定时器到点但日子没换(时钟被拨回)时,靠它把下一班排出去
  useEffect(() => {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    const t = setTimeout(() => {
      setKey(localDayKey())
      setTick((n) => n + 1)
    }, Math.max(next - now.getTime() + 1000, 1000)) // +1s 缓冲:定时器早到一丁点还停在当天
    return () => clearTimeout(t)
  }, [key, tick])
  return key
}

/** 列 id → 语义类型。筛选与统计都要它;判定单源走 propertyTypes,别在这里另立一张表。 */
function kindOfFactory(columns: { id: string; type: string }[]): (id: string) => ColumnType | null {
  const map = new Map(columns.map((c) => [c.id, resolveBaseType(c.type)]))
  return (id) => map.get(id) ?? null
}

// ───────────────────────────── 数字卡 ─────────────────────────────

export function StatCard({ opts, filters }: { opts: Record<string, string>; filters: DashFilter[] }) {
  const { t } = useI18n()
  const parsed = useMemo(() => parseStatSpec(opts), [JSON.stringify(opts)]) // eslint-disable-line react-hooks/exhaustive-deps
  const path = parsed.ok ? parsed.spec.source : '' // literal 档 source 恒空 → useDb 不拉任何 .db
  const entry = useDb(path)
  if (!parsed.ok) return <Note>{t('dashcards.statError', { err: parsed.error })}</Note>
  // literal 档:值即所见,不碰 entry、不渲「已按页面筛选」副行(没有行可筛)。
  if (parsed.spec.literal !== null) {
    const s = parsed.spec
    return (
      <div className="dash-widget dash-stat">
        <div className="dash-stat-value">
          {s.literal}
          {s.unit && <span className="dash-stat-unit">{s.unit}</span>}
        </div>
        <div className="dash-stat-label">{s.label || '—'}</div>
      </div>
    )
  }
  return <StatBody spec={parsed.spec} entry={entry} filters={filters} />
}

function StatBody({ spec, entry, filters }: { spec: StatSpec; entry: ReturnType<typeof useDb>; filters: DashFilter[] }) {
  const { t } = useI18n()
  const dayKey = useDayKey()
  const value = useMemo(() => {
    if (!entry?.data) return null
    void dayKey // 依赖用途:相对日期筛选按「今天」折算,跨午夜必须重算(值本身不进计算)
    const kindOf = kindOfFactory(entry.data.columns)
    return computeStatCard(entry.data.rows, entry.data.columns, spec, filters, kindOf, entry.data.views)
  }, [entry?.data, spec, filters, dayKey])

  if (!entry || entry.status === 'loading') return <Note>{t('dashcards.loading')}</Note>
  if (entry.status === 'missing') return <Note>{t('dashcards.missing', { source: spec.source })}</Note>
  if (entry.status === 'corrupt') return <Note>{t('dashcards.corrupt', { source: spec.source, err: entry.message })}</Note>
  if (!value) return <Note>{t('dashcards.noData')}</Note>
  if (value.error) return <Note>{t('dashcards.statError', { err: value.error })}</Note>

  const label = spec.label || (spec.col ? `${spec.col} · ${spec.stat}` : entry.data?.name || t('dashcards.rowCount'))
  return (
    <div className="dash-widget dash-stat">
      <div className="dash-stat-value">
        {value.text}
        {spec.unit && <span className="dash-stat-unit">{spec.unit}</span>}
      </div>
      <div className="dash-stat-label">{label}</div>
      {!!filters.length && <div className="dash-stat-sub">{t('dashcards.filteredRows', { n: value.rows })}</div>}
    </div>
  )
}

// ───────────────────────────── 图表卡 ─────────────────────────────

export function ChartCard({ opts, filters }: { opts: Record<string, string>; filters: DashFilter[] }) {
  const { t } = useI18n()
  const parsed = useMemo(() => parseChartSpec(opts), [JSON.stringify(opts)]) // eslint-disable-line react-hooks/exhaustive-deps
  const path = parsed.ok ? parsed.spec.source : ''
  const entry = useDb(path)
  if (!parsed.ok) return <Note>{t('dashcards.chartError', { err: parsed.error })}</Note>
  return <ChartBody spec={parsed.spec} entry={entry} filters={filters} />
}

function ChartBody({ spec, entry, filters }: { spec: ChartSpec; entry: ReturnType<typeof useDb>; filters: DashFilter[] }) {
  const { t } = useI18n()
  const dayKey = useDayKey()
  const res = useMemo(() => {
    if (!entry?.data) return null
    void dayKey // 同 StatBody:跨午夜重算相对日期筛选
    const kindOf = kindOfFactory(entry.data.columns)
    return computeChartCard(entry.data.rows, entry.data.columns, spec, filters, kindOf, entry.data.views)
  }, [entry?.data, spec, filters, dayKey])

  if (!entry || entry.status === 'loading') return <Note>{t('dashcards.loading')}</Note>
  if (entry.status === 'missing') return <Note>{t('dashcards.missing', { source: spec.source })}</Note>
  if (entry.status === 'corrupt') return <Note>{t('dashcards.corrupt', { source: spec.source, err: entry.message })}</Note>
  if (!res) return <Note>{t('dashcards.noData')}</Note>
  if (res.error) return <Note>{t('dashcards.chartError', { err: res.error })}</Note>
  if (!res.slices.length) return <Note>{t('dashcards.noMatch')}</Note>

  const agg = spec.agg === 'count'
    ? t('dashcards.aggCount')
    : t(spec.agg === 'sum' ? 'dashcards.aggSum' : 'dashcards.aggAvg', { col: spec.value })
  const title = spec.label || `${spec.group} · ${agg}`
  return (
    <div className="dash-chart">
      <div className="dash-chart-title">{title}</div>
      <div className="dash-chart-body">
        {spec.kind === 'donut' ? <Donut slices={res.slices} /> : spec.kind === 'line' ? <Line slices={res.slices} /> : <Bars slices={res.slices} />}
      </div>
    </div>
  )
}
