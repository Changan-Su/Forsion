/** calendarDate 属性的存储编码(纯字符串,baseType=text):`start[/end]`,
 *  每侧为 `YYYY-MM-DD`(全天)或 `YYYY-MM-DDTHH:mm`(带时刻)。
 *  刻意用字符串而非结构化对象:天然落进现有 CellValue(string),不改 schema/不升 DB_VERSION。
 *  显示格式化按字符串分段做,不经 Date —— 避开 'YYYY-MM-DD' 被当 UTC 午夜的时区坑。 */

export interface CalDate {
  /** 开始,`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`。 */
  start: string
  /** 可选结束,同格式。 */
  end?: string
  /** 两侧都无时刻分量。 */
  allDay: boolean
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/

export function parseCalDate(s: CellStr): CalDate | null {
  if (typeof s !== 'string' || !s) return null
  const [start, end] = s.split('/')
  if (!DATE_RE.test(start)) return null
  const cleanEnd = end && DATE_RE.test(end) ? end : undefined
  return { start, end: cleanEnd, allDay: !start.includes('T') && !(cleanEnd ?? '').includes('T') }
}

/** 形状之外再问一句:这一天在该年该月**真的存在**吗(`2026-02-29` / `2026-04-31` = 假)。
 *  DATE_RE 只管形状 —— 形状对但不存在的日期会被 `new Date` 悄悄归一化到下个月,于是
 *  按字符串排版的提示文案(`fmtCalDate`)与按 Date 计算的日历落点/提醒时刻**对不上**。
 *  ⚠️ 刻意不塞进 `parseCalDate`:那是全体 calendarDate 单元格的读端,收紧它会让存量脏数据当场消失。
 *  新写入的路径(编辑器候选、正文标记)自己调它把关。 */
export function isRealDate(side: string): boolean {
  const [y, m, d] = side.split('T')[0].split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

export function calDateToValue(c: CalDate): string {
  return c.end ? `${c.start}/${c.end}` : c.start
}

/** 一侧 → {date:'YYYY-MM-DD', time:'HH:mm'|''}。 */
export function splitSide(side: string): { date: string; time: string } {
  const [date, time] = side.split('T')
  return { date, time: time ?? '' }
}

/** 人类可读(zh):`7月6日 10:00–11:00` / 全天 `7月6日` / 跨天 `7月6日 → 7月8日`。 */
export function fmtCalDate(c: CalDate | null): string {
  if (!c) return ''
  const a = splitSide(c.start)
  const md = (d: string): string => {
    const [, m, day] = d.split('-')
    return `${Number(m)}月${Number(day)}日`
  }
  if (!c.end) return a.time ? `${md(a.date)} ${a.time}` : md(a.date)
  const b = splitSide(c.end)
  if (a.date === b.date) return a.time || b.time ? `${md(a.date)} ${a.time}–${b.time}` : md(a.date)
  const left = a.time ? `${md(a.date)} ${a.time}` : md(a.date)
  const right = b.time ? `${md(b.date)} ${b.time}` : md(b.date)
  return `${left} → ${right}`
}

type CellStr = string | number | boolean | string[] | null | undefined
