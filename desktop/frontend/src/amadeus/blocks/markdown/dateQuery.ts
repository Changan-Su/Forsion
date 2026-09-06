/** `@` 补全面板里的日期候选 —— 把用户随手打的松散写法翻成**规范落盘串**。
 *
 *  分工:松散输入(`@2200` / `@9-1` / `@明天`)只活在这里,正文里落下去的一律是
 *  `@YYYY-MM-DD[THH:mm]`(@amadeus-shared/mdMarks 只认这一种,那边刻意不做自然语言)。
 *  Notion 的 `@` 菜单就是这个分工:输入宽松,落盘规范。
 *
 *  刻意不做:chrono 那种自然语言库(「下周三下午三点」)。要那种表达力再说,先把 5 条数字写法做对。
 */
import { isRealDate, parseCalDate } from '@amadeus-shared/db/calDate'
import { fmtCalDateL } from '@amadeus/lib/calDateFmt'
import { registerMessages, translate } from '../../../i18n'

registerMessages({
  'dateq.schedule': { zh: '日程', en: 'Schedule' },
  'dateq.remind': { zh: '提醒', en: 'Remind me' },
  'dateq.today': { zh: '今天', en: 'Today' },
  'dateq.tomorrow': { zh: '明天', en: 'Tomorrow' },
})

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

/** 关键词行(Notion 的 `@tod` → Today / `@r` → Remind me 同款):查询串是词的前缀就给,空查询(刚打完 `@`)全给。
 *  label 存 key、渲染期再 translate —— 模块级定格会让切语言纹丝不动。 */
const KEYWORDS: Array<{ key: string; words: string[]; days: number }> = [
  { key: 'dateq.today', words: ['today', '今天'], days: 0 },
  { key: 'dateq.tomorrow', words: ['tomorrow', '明天'], days: 1 },
]
const REMIND_WORDS = ['remind', '提醒']

/** `@` 面板顶部的日期候选。三档,先命中先返回:
 *  1. `remind:` 打头 = 用户已写明要提醒,只给提醒那一条(没写时刻 → 明天 09:00);
 *  2. 关键词前缀(`@t`/`@明` → 今天/明天,`@r`/`@提` → 提醒);空查询三条全给;
 *  3. 数字写法(`@2200` / `@9-1`)→「日程 + 提醒」两行。 */
export function dateCandidates(query: string, now = new Date()): DateCand[] {
  const q = query.trim()
  const hint = (v: string): string => fmtCalDateL(parseCalDate(v))
  // 全天日期配提醒:午夜响没意义,按 09:00 给(Notion 的 "Tomorrow 9am" 同款)。
  const remindOf = (side: string): DateCand => {
    const s = side.includes('T') ? side : `${side}T09:00`
    return { insert: `@remind:${s}`, label: translate('dateq.remind'), hint: hint(s) }
  }
  const tomorrow = ymd(plusDays(now, 1))
  if (/^remind:/i.test(q)) {
    const side = q.length === 7 ? tomorrow : parseDateQuery(q.slice(7), now)
    return side ? [remindOf(side)] : []
  }
  const s = q.toLowerCase()
  const hit = (words: string[]): boolean => !s || words.some((w) => w.startsWith(s))
  const out: DateCand[] = []
  for (const k of KEYWORDS) {
    if (!hit(k.words)) continue
    const d = ymd(plusDays(now, k.days))
    out.push({ insert: `@${d}`, label: translate(k.key), hint: hint(d) })
  }
  if (hit(REMIND_WORDS)) out.push(remindOf(tomorrow))
  if (out.length) return out
  const side = parseDateQuery(q, now)
  if (!side) return []
  return [{ insert: `@${side}`, label: translate('dateq.schedule'), hint: hint(side) }, remindOf(side)]
}
