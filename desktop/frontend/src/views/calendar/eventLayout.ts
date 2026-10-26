/**
 * 周/日时间网格里的重叠事件排法 + 月视图一周一行的排法。
 *
 * 时间网格(走查续七 7.10 A,阶梯):按开始时间排,每条压在仍在进行的前一条上面,往右错 14px、宽度只少 14px;
 * 第 5 层起不再错开,跟第 4 层叠着。开始时间相同的几条没法错开露出标题,这一组在本层里等宽分栏。
 */
import { startOfDay } from './dateUtils'

export interface TimedLayoutInput {
  key: string
  start: Date
  end: Date | null
}

export interface TimedLayout {
  /** 在重叠链里的第几层(0 = 最底下) */
  depth: number
  /** 往右错开的 px(14 × 层,封顶 3 层) */
  indentPx: number
  /** 同一开始时刻的分栏:第几栏 / 共几栏 */
  col: number
  cols: number
}

export const CASCADE_PX = 14
const MAX_INDENT_DEPTH = 3

const endMs = (ev: TimedLayoutInput): number =>
  ev.end?.getTime() ?? ev.start.getTime() + 60 * 60 * 1000

/** 渲染顺序:先开始的在下;同一时刻开始的,长的在下。 */
export const byStart = (a: TimedLayoutInput, b: TimedLayoutInput): number =>
  a.start.getTime() - b.start.getTime() || endMs(b) - endMs(a)

export function layoutTimedEvents(events: TimedLayoutInput[]): Map<string, TimedLayout> {
  const sorted = [...events].sort(byStart)
  const out = new Map<string, TimedLayout>()
  let active: Array<{ end: number; depth: number }> = []

  for (let begin = 0; begin < sorted.length;) {
    const t = sorted[begin].start.getTime()
    let end = begin + 1
    while (end < sorted.length && sorted[end].start.getTime() === t) end += 1

    active = active.filter((a) => a.end > t)
    const depth = active.length ? Math.max(...active.map((a) => a.depth)) + 1 : 0
    const indentPx = CASCADE_PX * Math.min(depth, MAX_INDENT_DEPTH)
    const cols = end - begin
    for (let i = begin; i < end; i++) {
      out.set(sorted[i].key, { depth, indentPx, col: i - begin, cols })
      active.push({ end: endMs(sorted[i]), depth })
    }
    begin = end
  }

  return out
}

export interface MonthLayoutInput extends TimedLayoutInput {
  allDay: boolean
}

/**
 * 月视图的一周一行(7.12):跨天条先分行(同一条在这一行里占同一行),再排单日全天,最后是当天开始的定时事件。
 * 返回每天一列槽位;某天这一行上没有条时是 null(画等高空位,跨天条才对得齐),末尾不留空位。
 */
export function layoutMonthWeek<T extends MonthLayoutInput>(events: T[], days: Date[]): Array<Array<T | null>> {
  const dayMs = days.map((d) => startOfDay(d).getTime())
  const span = (e: T): [number, number] => [startOfDay(e.start).getTime(), startOfDay(e.end ?? e.start).getTime()]
  const multi = (e: T): boolean => span(e)[1] > span(e)[0]
  const inRow = events.filter((e) => { const [s, t] = span(e); return t >= dayMs[0] && s <= dayMs[dayMs.length - 1] })
  const bars = inRow.filter(multi).sort((a, b) => span(a)[0] - span(b)[0] || span(b)[1] - span(a)[1] || byStart(a, b))

  const lanes: Array<Array<T | undefined>> = days.map(() => [])
  for (const e of bars) {
    const [s, t] = span(e)
    const cols = dayMs.flatMap((d, i) => (d >= s && d <= t ? [i] : []))
    let lane = 0
    while (cols.some((i) => lanes[i][lane])) lane += 1
    for (const i of cols) lanes[i][lane] = e
  }

  return dayMs.map((d, i) => [
    ...Array.from(lanes[i], (e) => e ?? null),
    // 单日的不分行、不补跨天条留下的空位:补进去就排到了跨天条上面
    ...inRow.filter((e) => e.allDay && !multi(e) && span(e)[0] === d).sort(byStart),
    ...inRow.filter((e) => !e.allDay && !multi(e) && span(e)[0] === d).sort(byStart),
  ])
}

/** 「还有 N 项」浮层:全天 / 跨天在前,再按开始时间。 */
export function agendaOrder<T extends MonthLayoutInput>(events: T[]): T[] {
  const bar = (e: T): boolean => e.allDay || startOfDay(e.end ?? e.start).getTime() > startOfDay(e.start).getTime()
  return [...events].sort((a, b) => Number(bar(b)) - Number(bar(a)) || byStart(a, b))
}
