/** `@` 补全面板里的日期候选 —— 把用户随手打的松散写法翻成**规范落盘串**。
 *
 *  分工:松散输入(`@2200` / `@9-1` / `@明天`)只活在这里,正文里落下去的一律是
 *  `@YYYY-MM-DD[THH:mm]`(@amadeus-shared/mdMarks 只认这一种,那边刻意不做自然语言)。
 *  Notion 的 `@` 菜单就是这个分工:输入宽松,落盘规范。
 *
 *  刻意不做:chrono 那种自然语言库(「下周三下午三点」)。要那种表达力再说,先把 5 条数字写法做对。
 */
import { fmtCalDate, isRealDate, parseCalDate } from '@amadeus-shared/db/calDate'

export interface DateCand {
  /** 插入正文的字面文本(含前导 `@`,不含尾随空格) */
  insert: string
  /** 左侧标签 */
  label: string
  /** 右侧灰字:人类可读的日期 */
  hint: string
}

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const plusDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

const FULL_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ](\d{1,2}):?(\d{2}))?$/i
const MD_RE = /^(\d{1,2})-(\d{1,2})(?:[t ](\d{1,2}):?(\d{2}))?$/i
const HM_RE = /^(\d{1,2}):(\d{2})$/
const HHMM_RE = /^(\d{3,4})$/
const WORDS: Record<string, number> = { 今天: 0, today: 0, 明天: 1, tomorrow: 1, 后天: 2 }

/** 松散查询串 → calDate 单侧编码(`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`);认不出 = null。 */
export function parseDateQuery(q: string, now = new Date()): string | null {
  const s = q.trim().toLowerCase()
  if (!s) return null
  const day = WORDS[s]
  if (day !== undefined) return ymd(plusDays(now, day))

  const at = (d: string, h?: string, m?: string): string | null => {
    // ⚠️ 不能只查 1–12 / 1–31:`@2-29` 在平年、`@4-31` 都会造出**不存在**的日期,
    //    落盘后 Date 把它归一化到下个月 → 候选提示、日历落点、提醒时刻三处对不上(Codex 评审)。
    if (!isRealDate(d)) return null
    if (h === undefined || m === undefined) return d
    const hh = Number(h)
    const mm = Number(m)
    if (hh > 23 || mm > 59) return null
    return `${d}T${pad(hh)}:${pad(mm)}`
  }

  const full = FULL_RE.exec(s)
  if (full) return at(`${full[1]}-${pad(Number(full[2]))}-${pad(Number(full[3]))}`, full[4], full[5])

  const md = MD_RE.exec(s)
  if (md) return at(`${now.getFullYear()}-${pad(Number(md[1]))}-${pad(Number(md[2]))}`, md[3], md[4])

  const hm = HM_RE.exec(s)
  if (hm) return at(ymd(now), hm[1], hm[2])

  const raw = HHMM_RE.exec(s)
  if (raw) {
    const v = raw[1].padStart(4, '0')
    return at(ymd(now), v.slice(0, 2), v.slice(2))
  }
  return null
}

/** `@` 面板顶部的日期候选。查询以 `remind:` 打头 = 用户已经写明要提醒,只给提醒那一条。 */
export function dateCandidates(query: string, now = new Date()): DateCand[] {
  const forced = /^remind:/i.test(query.trim())
  const side = parseDateQuery(forced ? query.trim().slice(7) : query, now)
  if (!side) return []
  // 全天日期配提醒:午夜响没意义,按 09:00 给(Notion 的 "Tomorrow 9am" 同款)。
  const remindSide = side.includes('T') ? side : `${side}T09:00`
  const hint = (v: string): string => fmtCalDate(parseCalDate(v))
  const remind: DateCand = { insert: `@remind:${remindSide}`, label: '提醒', hint: hint(remindSide) }
  return forced ? [remind] : [{ insert: `@${side}`, label: '日程', hint: hint(side) }, remind]
}
