/** `@` 补全面板里的日期候选 —— 把用户随手打的松散写法翻成**规范落盘串**。
 *
 *  分工:松散输入(`@2200` / `@9-1` / `@明天`)只活在这里,正文里落下去的一律是
 *  `@YYYY-MM-DD[THH:mm]`(@amadeus-shared/mdMarks 只认这一种,那边刻意不做自然语言)。
 *  Notion 的 `@` 菜单就是这个分工:输入宽松,落盘规范。
 *
 *  刻意不做:chrono 那种整句自然语言理解(「下周三下午三点」)。这里覆盖日期输入框里最常见的
 *  数字 / 分隔符 / 中文年月日 / 12 小时时刻写法，并把单独的日号解释为最近一次该日。
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

const FULL_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/
const FULL_ZH_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})(?:日|号)?$/
const MD_RE = /^(\d{1,2})[-/.](\d{1,2})$/
const MD_ZH_RE = /^(\d{1,2})月(\d{1,2})(?:日|号)?$/
const COMPACT_FULL_RE = /^(\d{4})(\d{2})(\d{2})$/
const DAY_RE = /^(\d{1,2})(?:日|号)?$/
const WORDS: Record<string, number> = { 昨天: -1, yesterday: -1, 今天: 0, today: 0, 明天: 1, tomorrow: 1, 后天: 2 }

interface Clock {
  hour: number
  minute: number
}

/** 时刻输入 → 24 小时制；没有显式时刻形状的 1–2 位数字留给「几号」。 */
function parseClock(input: string): Clock | null {
  const s = input.trim().toLowerCase()
  let h: number
  let m: number
  let hit = /^(\d{1,2}):(\d{2})(am|pm)?$/.exec(s)
  if (hit) {
    h = Number(hit[1])
    m = Number(hit[2])
    const ap = hit[3]
    if (ap) {
      if (h < 1 || h > 12) return null
      h = h % 12 + (ap === 'pm' ? 12 : 0)
    }
  } else if ((hit = /^(\d{1,2})(am|pm)$/.exec(s))) {
    h = Number(hit[1])
    m = 0
    if (h < 1 || h > 12) return null
    h = h % 12 + (hit[2] === 'pm' ? 12 : 0)
  } else if ((hit = /^(\d{1,2})(?:点|时)(?:(\d{1,2})分?)?$/.exec(s))) {
    h = Number(hit[1])
    m = hit[2] === undefined ? 0 : Number(hit[2])
  } else if ((hit = /^(\d{3,4})$/.exec(s))) {
    const v = hit[1].padStart(4, '0')
    h = Number(v.slice(0, 2))
    m = Number(v.slice(2))
  } else {
    return null
  }
  return h <= 23 && m <= 59 ? { hour: h, minute: m } : null
}

/** 只给「几号」时按排期输入框的习惯取最近一次该日；本月已过则向后找，自动跳过没有该日的月份。 */
function nextDayOfMonth(day: number, now: Date): string | null {
  if (day < 1 || day > 31) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (let offset = 0; offset <= 12; offset += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, day)
    if (d.getDate() === day && d >= today) return ymd(d)
  }
  return null
}

function parseDateOnly(input: string, now: Date): string | null {
  const s = input.trim().toLowerCase()
  const relative = WORDS[s]
  if (relative !== undefined) return ymd(plusDays(now, relative))

  const valid = (y: string | number, m: string | number, d: string | number): string | null => {
    const value = `${Number(y)}-${pad(Number(m))}-${pad(Number(d))}`
    return isRealDate(value) ? value : null
  }
  let hit = FULL_RE.exec(s)
  if (hit) return valid(hit[1], hit[2], hit[3])
  hit = FULL_ZH_RE.exec(s)
  if (hit) return valid(hit[1], hit[2], hit[3])
  hit = COMPACT_FULL_RE.exec(s)
  if (hit) return valid(hit[1], hit[2], hit[3])
  hit = MD_RE.exec(s)
  if (hit) return valid(now.getFullYear(), hit[1], hit[2])
  hit = MD_ZH_RE.exec(s)
  if (hit) return valid(now.getFullYear(), hit[1], hit[2])
  hit = DAY_RE.exec(s)
  return hit ? nextDayOfMonth(Number(hit[1]), now) : null
}

/** 松散查询串 → calDate 单侧编码(`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`);认不出 = null。 */
export function parseDateQuery(q: string, now = new Date()): string | null {
  // NFKC 让中文输入法产出的全角数字 / 斜杠 / 冒号与半角输入走同一条解析路径。
  const s = q.normalize('NFKC').trim()
  if (!s) return null
  const date = parseDateOnly(s, now)
  if (date) return date

  const clock = parseClock(s)
  if (clock) return `${ymd(now)}T${pad(clock.hour)}:${pad(clock.minute)}`

  // 日期 + 时刻：支持 ISO T / 空格，以及中文「日/号」后直接接「14点30分」。
  const joined = /^(.+?)(?:[tT]|\s+)(\S.+)$/.exec(s)
    ?? /^(.+?(?:日|号))\s*(\d{1,2}(?:点|时).*)$/.exec(s)
  if (joined) {
    const d = parseDateOnly(joined[1], now)
    const t = parseClock(joined[2])
    if (d && t) return `${d}T${pad(t.hour)}:${pad(t.minute)}`
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
 *  3. 数字 / 日期写法(`@9` / `@2200` / `@9/10` / `@9月10日`)→「日程 + 提醒」两行。 */
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
