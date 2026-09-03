/** 甘特视图(view.type='gantt')纯逻辑:起止列解析 / 行的日期区间 / 时间轴范围 / 刻度 / 条与今日线的几何。
 *  无 React、无 store —— GanttBody 只是它的壳,规则改这里并过 ganttLogic.test.ts。
 *  日期全程是 'YYYY-MM-DD' 字符串,天数差走 Date.UTC:避开 'YYYY-MM-DD' 被当 UTC 午夜 / DST 的时区坑
 *  (calDate.ts 头注同一条纪律;test:ics-tz 那五个时区下本文件的单测也必须绿)。 */
import { parseCalDate, splitSide } from '@amadeus-shared/db/calDate'
import type { DbColumn, DbRow, DbView } from '@amadeus-shared/db/schema'

export type GanttScale = 'day' | 'week'
/** 每天像素宽:日档 28 / 周档 8(一周 56)。条与刻度都按它乘。 */
export const PX_PER_DAY: Record<GanttScale, number> = { day: 28, week: 8 }
/** 未知 scale 回退 day(不丢配置,与 chartKindOf 同态度)。 */
export const ganttScaleOf = (s: string | undefined): GanttScale => (s === 'week' ? 'week' : 'day')

/** 可作起止列的列:只认 calendarDate(spec 如此;ponytail: primitive date 不进,生产库日期列都是 calendarDate)。 */
export const ganttDateCols = (columns: DbColumn[]): DbColumn[] => columns.filter((c) => c.type === 'calendarDate')

/** 起止列解析:记的列还在且是 calendarDate 则用之,否则回落 —— start → 第一个 calendarDate 列;end → start。
 *  没有任何 calendarDate 列 → null(视图体给引导态)。视图菜单的选中态也用这一个函数,别各解各的。 */
export function resolveGanttCols(columns: DbColumn[], view: Pick<DbView, 'gantt'>): { start: DbColumn; end: DbColumn } | null {
  const cands = ganttDateCols(columns)
  const pick = (id: string | undefined): DbColumn | undefined => (id ? cands.find((c) => c.id === id) : undefined)
  const start = pick(view.gantt?.startCol) ?? cands[0]
  if (!start) return null
  return { start, end: pick(view.gantt?.endCol) ?? start }
}

/** 行的区间,闭区间,两端 'YYYY-MM-DD'。 */
export interface GanttSpan { s: string; e: string }

/** 行的区间。开始 = 开始列的起侧;结束 = 独立结束列有值 → 其末侧(它自己是区间就取 end),
 *  否则开始列自身是区间(`a/b`)→ b,否则 = 开始(一天宽)。只有结束没有开始 → 该日单日;
 *  两侧皆无 / 串不合法 → null(= 无日期行,排底灰显);e < s → 夹成一天(与 CalendarBody.spanOf 同款,不交换)。
 *  时刻分量(`T10:00`)只影响显示不影响天数。 */
export function ganttSpanOf(row: DbRow, start: DbColumn, end: DbColumn): GanttSpan | null {
  const a = parseCalDate(row.cells[start.id])
  const b = end.id === start.id ? null : parseCalDate(row.cells[end.id])
  const sDate = a ? splitSide(a.start).date : null
  const eDate = b ? splitSide(b.end ?? b.start).date : a?.end ? splitSide(a.end).date : null
  if (!sDate && !eDate) return null
  const s = sDate ?? (eDate as string)
  const e = eDate ?? s
  return { s, e: e >= s ? e : s }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** 'YYYY-MM-DD' → 自 1970-01-01 起的天数(UTC 整数,不受本地时区 / DST 影响)。 */
const dayNum = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86400000)
}
const fromDayNum = (n: number): string => {
  const t = new Date(n * 86400000)
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}
/** b − a 的天数(同日 0)。 */
export const daysBetween = (a: string, b: string): number => dayNum(b) - dayNum(a)
export const addDays = (ymd: string, n: number): string => fromDayNum(dayNum(ymd) + n)
/** 0 = 周日(与日历视图的周日起始一致)。 */
export const weekdayOf = (ymd: string): number => new Date(dayNum(ymd) * 86400000).getUTCDay()
/** 本地日历日(今天):取本地 y/m/d 拼串,之后与别的日期一样按字符串处理。 */
export const todayYmd = (d = new Date()): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 时间轴范围:覆盖全部条 + 今天,两端各留白(日档 3 天 / 周档 1 周);周档再对齐到周日起 / 周六止。
 *  没有任何条 → 今天前后各 14 天(空表也有轴可看)。 */
export function ganttRange(spans: GanttSpan[], today: string, scale: GanttScale): { from: string; to: string } {
  let lo = today
  let hi = today
  for (const sp of spans) {
    if (sp.s < lo) lo = sp.s
    if (sp.e > hi) hi = sp.e
  }
  if (!spans.length) {
    lo = addDays(today, -14)
    hi = addDays(today, 14)
  }
  const pad = scale === 'week' ? 7 : 3
  let from = addDays(lo, -pad)
  let to = addDays(hi, pad)
  if (scale === 'week') {
    from = addDays(from, -weekdayOf(from))
    to = addDays(to, 6 - weekdayOf(to))
  }
  return { from, to }
}

export interface GanttTick {
  /** 格首日。 */
  date: string
  /** 格宽(天):日档恒 1;周档 7,末格可能不足 7。 */
  days: number
  label: string
  /** 日档:首格与每月 1 号;周档:首格与含每月 1-7 号的那周。 */
  major: boolean
  /** 日档周六/周日。 */
  weekend?: boolean
}

/** 刻度:日档每天一格(major 标「M/D」,其余标日号 —— 「M月D日」在 28px 格里放不下,截图实证被截成「8月2」);周档每周一格(周日起,标「M/D」)。 */
export function ganttTicks(from: string, to: string, scale: GanttScale): GanttTick[] {
  const total = daysBetween(from, to) + 1
  const out: GanttTick[] = []
  if (scale === 'day') {
    for (let i = 0; i < total; i++) {
      const d = addDays(from, i)
      const [, m, day] = d.split('-')
      const wd = weekdayOf(d)
      const major = i === 0 || day === '01'
      out.push({ date: d, days: 1, label: major ? `${Number(m)}/${Number(day)}` : String(Number(day)), major, weekend: wd === 0 || wd === 6 })
    }
  } else {
    for (let i = 0; i < total; i += 7) {
      const d = addDays(from, i)
      const [, m, day] = d.split('-')
      out.push({ date: d, days: Math.min(7, total - i), label: `${Number(m)}/${Number(day)}`, major: i === 0 || Number(day) <= 7 })
    }
  }
  return out
}

/** 条的几何(px):left = 距轴首日的天数 × 单位,width = 闭区间天数 × 单位(单日 = 一个单位宽)。 */
export const ganttBar = (sp: GanttSpan, from: string, scale: GanttScale): { left: number; width: number } => {
  const u = PX_PER_DAY[scale]
  return { left: daysBetween(from, sp.s) * u, width: (daysBetween(sp.s, sp.e) + 1) * u }
}

export interface GanttLayout {
  scale: GanttScale
  from: string
  to: string
  /** 轴总天数 / 总宽(px)。 */
  days: number
  width: number
  ticks: GanttTick[]
  /** 有日期的行,**保持传入顺序**(视图的筛选/排序已在上游做完)。 */
  dated: Array<{ row: DbRow; span: GanttSpan; left: number; width: number }>
  /** 无日期的行(排底灰显),同样保持传入顺序。 */
  undated: DbRow[]
  /** 今日线的 left(px);今天不在轴上 → null(按 ganttRange 的构造永远在,留这个分支给自定义范围)。 */
  todayLeft: number | null
}

/** 一次算完视图体要摆的一切。 */
export function ganttLayout(rows: DbRow[], start: DbColumn, end: DbColumn, scale: GanttScale, today = todayYmd()): GanttLayout {
  const dated: GanttLayout['dated'] = []
  const undated: DbRow[] = []
  const spans: GanttSpan[] = []
  for (const row of rows) {
    const span = ganttSpanOf(row, start, end)
    if (span) {
      spans.push(span)
      dated.push({ row, span, left: 0, width: 0 })
    } else undated.push(row)
  }
  const { from, to } = ganttRange(spans, today, scale)
  for (const d of dated) Object.assign(d, ganttBar(d.span, from, scale))
  const days = daysBetween(from, to) + 1
  const u = PX_PER_DAY[scale]
  const todayLeft = today >= from && today <= to ? daysBetween(from, today) * u : null
  return { scale, from, to, days, width: days * u, ticks: ganttTicks(from, to, scale), dated, undated, todayLeft }
}
