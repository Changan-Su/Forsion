/** Calendar View 的纯日期数学(原生 Date,本地时区)。'YYYY-MM-DD' 刻意用本地构造避 UTC 午夜坑。 */

export const WEEK_START = 0 // 0=周日
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
export const HOURS = Array.from({ length: 24 }, (_, i) => i)

/** 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:mm' → 本地 Date。 */
export function toLocalDate(side: string): Date {
  const [datePart, timePart] = side.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  if (timePart) {
    const [hh, mm] = timePart.split(':').map(Number)
    return new Date(y, m - 1, d, hh, mm)
  }
  return new Date(y, m - 1, d)
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d)
  return addDays(s, -((s.getDay() - WEEK_START + 7) % 7))
}
/** 月视图 6×7 = 42 格,从含 1 号那周的周首开始。 */
export function monthGridDays(anchor: Date): Date[] {
  const start = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}
export function daysRange(start: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i))
}
/** 事件是否覆盖某天(含起止;无 end 视为当天)。用于月视图 + 全天条跨天铺陈。 */
export function coversDay(start: Date, end: Date | null, day: Date): boolean {
  const s = startOfDay(start).getTime()
  const e = startOfDay(end ?? start).getTime()
  const d = startOfDay(day).getTime()
  return d >= s && d <= e
}
/** 定时事件在时间网格里的 top/height(px);至少 20 分钟高度可点;跨到次日则夹到当天底。 */
export function eventBox(start: Date, end: Date | null, hourPx: number): { top: number; height: number } {
  const mins = start.getHours() * 60 + start.getMinutes()
  const endSameDay = end && sameDay(start, end) ? end.getHours() * 60 + end.getMinutes() : end ? 24 * 60 : mins + 60
  const dur = Math.max(20, endSameDay - mins)
  return { top: (mins / 60) * hourPx, height: (dur / 60) * hourPx }
}
/** Date → 存储字符串 'YYYY-MM-DD'(全天)或 'YYYY-MM-DDTHH:mm'(带时刻)。 */
export function fmtStamp(d: Date, allDay: boolean): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return allDay ? date : `${date}T${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 分钟数吸附到 15 分钟栅格。 */
export function snap15(min: number): number {
  return Math.round(min / 15) * 15
}
/** Date 加分钟(返回新 Date)。 */
export function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60000)
}
/** 平移 n 天,保留时分(月视图拖拽改日期用)。 */
export function shiftDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())
}
/** a、b 相差的天数(按当地日界)。 */
export function diffDays(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000)
}

export function monthLabel(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}
/** 一段连续日期范围的标题(周/3日视图页眉)。 */
export function rangeLabel(days: Date[]): string {
  if (!days.length) return ''
  const a = days[0]
  const b = days[days.length - 1]
  if (days.length === 1) return `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日`
  const bm = a.getMonth() === b.getMonth() ? `${b.getDate()}日` : `${b.getMonth() + 1}月${b.getDate()}日`
  return `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日 – ${bm}`
}
