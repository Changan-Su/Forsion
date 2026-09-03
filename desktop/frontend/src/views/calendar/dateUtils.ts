/** Calendar View 的纯日期数学(原生 Date,本地时区)。'YYYY-MM-DD' 刻意用本地构造避 UTC 午夜坑。 */
import { parseCalDate, splitSide } from '@amadeus-shared/db/calDate'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  // 星期:zh 是单字(配「周」前缀),en 是三字母缩写(本身就完整)。两套语序不同 ——
  // 所以除了单字表,另给一个 dowLabel() 出成品标签,调用点不要再自己拼「周」+ 单字。
  'caldate.dow0': { zh: '日', en: 'Sun' },
  'caldate.dow1': { zh: '一', en: 'Mon' },
  'caldate.dow2': { zh: '二', en: 'Tue' },
  'caldate.dow3': { zh: '三', en: 'Wed' },
  'caldate.dow4': { zh: '四', en: 'Thu' },
  'caldate.dow5': { zh: '五', en: 'Fri' },
  'caldate.dow6': { zh: '六', en: 'Sat' },
  'caldate.dowLabel': { zh: '周{d}', en: '{d}' },
  'caldate.durMin': { zh: '{n}分钟', en: '{n} min' },
  'caldate.durHour': { zh: '{n}小时', en: '{n} h' },
  'caldate.durHourMin': { zh: '{h}小时{m}分钟', en: '{h} h {m} min' },
  'caldate.durDay': { zh: '{n}天', en: '{n} d' },
  // 月名:中文是「7月」,英文是「July」—— 中英语序不同,所以把整个月名当一个占位量传给标题模板。
  'caldate.month1': { zh: '1月', en: 'January' },
  'caldate.month2': { zh: '2月', en: 'February' },
  'caldate.month3': { zh: '3月', en: 'March' },
  'caldate.month4': { zh: '4月', en: 'April' },
  'caldate.month5': { zh: '5月', en: 'May' },
  'caldate.month6': { zh: '6月', en: 'June' },
  'caldate.month7': { zh: '7月', en: 'July' },
  'caldate.month8': { zh: '8月', en: 'August' },
  'caldate.month9': { zh: '9月', en: 'September' },
  'caldate.month10': { zh: '10月', en: 'October' },
  'caldate.month11': { zh: '11月', en: 'November' },
  'caldate.month12': { zh: '12月', en: 'December' },
  'caldate.monthLabel': { zh: '{y}年{m}', en: '{m} {y}' },
  'caldate.dayLabel': { zh: '{y}年{m}{d}日', en: '{m} {d}, {y}' },
  'caldate.rangeSameMonth': { zh: '{y}年{m1}{d1}日 – {d2}日', en: '{m1} {d1} – {d2}, {y}' },
  'caldate.rangeCrossMonth': { zh: '{y}年{m1}{d1}日 – {m2}{d2}日', en: '{m1} {d1} – {m2} {d2}, {y}' },
})

/**
 * 月名字典键(0=一月)。⚠️ 这里存的是**键**不是文案:模块级常量数组里放字面量会在模块
 * 加载那一刻冻住,之后切语言不会更新。文案一律在调用时用 translate() 取。
 */
const MONTH_KEYS = [
  'caldate.month1', 'caldate.month2', 'caldate.month3', 'caldate.month4',
  'caldate.month5', 'caldate.month6', 'caldate.month7', 'caldate.month8',
  'caldate.month9', 'caldate.month10', 'caldate.month11', 'caldate.month12',
]
const monthName = (d: Date): string => translate(MONTH_KEYS[d.getMonth()])

export const WEEK_START = 0 // 0=周日
/** 星期表头用的短名(0=周日)。**函数不是常量** —— 模块级数组会定格在加载那一刻的语言。
 *  值同时被调用方当 React key 用,七个值互不相同,可以。 */
export const weekdays = (): string[] => Array.from({ length: 7 }, (_, i) => translate(`caldate.dow${i}`))
/** 单个星期的成品标签:zh=「周三」,en=「Wed」。别在调用点拼前缀。 */
export const dowLabel = (dow: number): string => translate('caldate.dowLabel', { d: translate(`caldate.dow${dow}`) })
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
  return translate('caldate.monthLabel', { y: d.getFullYear(), m: monthName(d) })
}
/** 一段连续日期范围的标题(周/3日视图页眉)。 */
export function rangeLabel(days: Date[]): string {
  if (!days.length) return ''
  const a = days[0]
  const b = days[days.length - 1]
  if (days.length === 1) return translate('caldate.dayLabel', { y: a.getFullYear(), m: monthName(a), d: a.getDate() })
  const vars = { y: a.getFullYear(), m1: monthName(a), d1: a.getDate(), m2: monthName(b), d2: b.getDate() }
  return translate(a.getMonth() === b.getMonth() ? 'caldate.rangeSameMonth' : 'caldate.rangeCrossMonth', vars)
}

// ── 事件详情卡的时间摘要(Notion 式:主时段 + 副日期 + 时长徽章)──────────────────
/** 时长(分)→ 简写,跟随语言:30分钟 / 1小时30分钟 / 2天 ｜ 30 min / 1 h 30 min / 2 d。 */
export function fmtDur(min: number): string {
  if (min <= 0) return ''
  if (min < 60) return translate('caldate.durMin', { n: min })
  if (min % 1440 === 0) return translate('caldate.durDay', { n: min / 1440 })
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? translate('caldate.durHourMin', { h, m }) : translate('caldate.durHour', { n: h })
}

/** side('YYYY-MM-DD[THH:mm]')→ 绝对分钟(纯算术、TZ 无关;仅用于求两侧差)。 */
function sideMinutes(side: string): number {
  const { date, time } = splitSide(side)
  const [y, m, d] = date.split('-').map(Number)
  const day = Date.UTC(y, m - 1, d) / 86_400_000
  const [hh, mm] = time ? time.split(':').map(Number) : [0, 0]
  return day * 1440 + hh * 60 + mm
}

/** 事件时间摘要(展示用):head=主行(时段/日期)、date=副行(日期+星期,定时才有)、
 *  badge=时长或「全天」。纯字符串分段算,不经 Date 显示(避开 'YYYY-MM-DD' 被当 UTC 午夜的坑)。 */
export function eventTimeSummary(raw: string): { head: string; date: string; badge: string } | null {
  const cd = parseCalDate(raw)
  if (!cd) return null
  const md = (s: string): string => { const [, m, d] = s.split('-'); return `${Number(m)}月${Number(d)}日` }
  const dow = (s: string): string => { const [y, m, d] = s.split('-').map(Number); return dowLabel(new Date(Date.UTC(y, m - 1, d)).getUTCDay()) }
  const a = splitSide(cd.start)
  const b = cd.end ? splitSide(cd.end) : null
  if (cd.allDay) {
    const head = b && b.date !== a.date ? `${md(a.date)} → ${md(b.date)}` : `${md(a.date)} ${dow(a.date)}`
    return { head, date: '', badge: '全天' }
  }
  if (!b) return { head: a.time, date: `${md(a.date)} ${dow(a.date)}`, badge: '' }
  const badge = fmtDur(sideMinutes(cd.end!) - sideMinutes(cd.start))
  if (a.date === b.date) return { head: `${a.time} → ${b.time}`, date: `${md(a.date)} ${dow(a.date)}`, badge }
  return { head: `${md(a.date)} ${a.time} → ${md(b.date)} ${b.time}`, date: '', badge }
}
