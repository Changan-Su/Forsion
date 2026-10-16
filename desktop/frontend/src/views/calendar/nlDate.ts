/** 待办快速添加的自然语言日期:从一句话里认出日期 / 时刻,剩下的当标题。纯函数,无 DOM / store。
 *  认得:今天 / 明天 / 后天 / 大后天、周X / 星期X / 下周X、10/20、10月20日、2026-10-20、
 *  上午 / 下午 / 晚上 N 点(半)、15:30、3pm;英文 today / tomorrow / monday / next friday。
 *  只有时刻没有日期 = 今天;什么都没认出 = value null(调用方决定落哪天)。 */
import { addDays, fmtStamp, startOfDay } from './dateUtils'

export interface QuickAdd {
  title: string
  /** 日历列的值:'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:mm';没认出 = null。 */
  value: string | null
}

const ZH_DOW: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const EN_DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const EN_DOW_RE = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat'
const ZH_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** '3' / '十一' / '两' → 数。 */
function num(s: string): number {
  if (/^\d+$/.test(s)) return Number(s)
  if (s.startsWith('十')) return 10 + (ZH_NUM[s.slice(1)] ?? 0)
  if (s.endsWith('十')) return (ZH_NUM[s[0]] ?? 0) * 10
  return ZH_NUM[s] ?? NaN
}
/** 本周起(含今天)的下一个星期 dow;strict = 今天不算。 */
function upcoming(today: Date, dow: number, strict = false): Date {
  const d = (dow - today.getDay() + 7) % 7
  return addDays(today, d === 0 && strict ? 7 : d)
}
/** 中文「下周X」= 下一个自然周(周一起)里的那天。 */
function nextWeek(today: Date, dow: number): Date {
  const monday = addDays(today, -((today.getDay() + 6) % 7))
  return addDays(monday, 7 + ((dow + 6) % 7))
}

export function parseQuickAdd(input: string, now = new Date()): QuickAdd {
  const today = startOfDay(now)
  let text = ` ${input} `
  let date: Date | null = null
  let time: number | null = null
  /** 命中就把那段从标题里挖掉;fn 返回 false = 不算命中(留着原文)。 */
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => boolean): void => {
    const m = text.match(re)
    if (!m || m.index === undefined || !fn(m)) return
    text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`
  }
  const ymd = (y: number, mo: number, d: number): boolean => {
    const v = new Date(y, mo - 1, d)
    if (v.getMonth() !== mo - 1 || v.getDate() !== d) return false
    date = v
    return true
  }
  /** 没写年份的月日:已经过去了就是明年那天。 */
  const md = (mo: number, d: number): boolean => {
    if (!ymd(today.getFullYear(), mo, d)) return false
    if (date! < today) ymd(today.getFullYear() + 1, mo, d)
    return true
  }

  // 日期(先长后短:「大后天」里有「后天」,「下周一」里有「周一」)
  take(/(\d{4})-(\d{1,2})-(\d{1,2})/, (m) => ymd(+m[1], +m[2], +m[3]))
  if (!date) take(/(\d{1,2})月(\d{1,2})[日号]?/, (m) => md(+m[1], +m[2]))
  if (!date) take(/(?<![\d/:])(\d{1,2})\/(\d{1,2})(?![\d/:])/, (m) => md(+m[1], +m[2]))
  if (!date) take(/大后天/, () => !!(date = addDays(today, 3)))
  if (!date) take(/后天/, () => !!(date = addDays(today, 2)))
  if (!date) take(/明天|明日|\btomorrow\b/i, () => !!(date = addDays(today, 1)))
  if (!date) take(/今天|今日|\btoday\b/i, () => !!(date = today))
  if (!date) take(/下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/, (m) => !!(date = nextWeek(today, ZH_DOW[m[1]])))
  if (!date) take(/(?:周|星期|礼拜)([一二三四五六日天])/, (m) => !!(date = upcoming(today, ZH_DOW[m[1]])))
  if (!date) take(new RegExp(`\\bnext\\s+(${EN_DOW_RE})\\b`, 'i'), (m) => !!(date = upcoming(today, EN_DOW[m[1].slice(0, 3).toLowerCase()], true)))
  if (!date) take(new RegExp(`\\b(?:on\\s+)?(${EN_DOW_RE})\\b`, 'i'), (m) => !!(date = upcoming(today, EN_DOW[m[1].slice(0, 3).toLowerCase()])))

  // 时刻
  const zhPeriod = (p: string | undefined, h: number): number =>
    p && /下午|晚上|傍晚|今晚/.test(p) && h < 12 ? h + 12 : p === '中午' && h < 11 ? h + 12 : h
  take(/(上午|早上|早晨|中午|下午|傍晚|晚上|今晚)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})[点點](半|(\d{1,2})分?)?/, (m) => {
    const h = zhPeriod(m[1], num(m[2]))
    const mi = m[3] === '半' ? 30 : m[4] ? +m[4] : 0
    if (!(h >= 0 && h < 24 && mi < 60)) return false
    time = h * 60 + mi
    if (m[1] === '今晚' && !date) date = today
    return true
  })
  if (time === null) take(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (m) => {
    let h = +m[1] % 12
    if (m[3].toLowerCase() === 'pm') h += 12
    const mi = m[2] ? +m[2] : 0
    if (+m[1] > 12 || mi >= 60) return false
    time = h * 60 + mi
    return true
  })
  if (time === null) take(/(上午|下午|晚上)?\s*(?:\bat\s+)?(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/, (m) => {
    const h = zhPeriod(m[1], +m[2])
    if (h >= 24 || +m[3] >= 60) return false
    time = h * 60 + +m[3]
    return true
  })

  const title = text.replace(/\s+/g, ' ').trim().replace(/^(?:at|on|by)\s+|\s+(?:at|on|by)$/i, '').trim()
  if (!date && time === null) return { title, value: null }
  const day = fmtStamp(date ?? today, true)
  if (time === null) return { title, value: day }
  const t = time as number
  return { title, value: `${day}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
}
