/**
 * 日期 / 时间显示的**单一来源**(评审 U-29)。
 *
 * 之前有 5 份相对时间实现(收件箱自写 timeAgo、造物、编码工作室版本、Agent 成长、项目详情各一份 Intl),
 * 另有二十多处 `toLocaleString()` / `toLocaleDateString()` 不传 locale —— 跟着**系统区域**走而不是界面语言,
 * 于是中文界面里冒出「17/09/2026」,同一屏还有「4天前」「4 天前」两种写法。
 *
 * 规则:
 * - locale 一律取**当前界面语言**(`currentLocale()`),不另写语言判定;测试可显式传 `locale`。
 * - 相对时间只用于时间轴类(版本历史、成长、项目动态、Orbit 提示);收件箱、造物这类**列表**用
 *   `formatListTime`:7 天内相对时间,更早显示绝对日期(「9月17日」/「Sep 17」)。
 * - zh 输出在数字与汉字之间补一个空格(「3 天前」「3 个月前」),与词条里 `{n} 天前` 的写法一致。
 * - 用户正文里的 calendarDate 字符串(`YYYY-MM-DD[THH:mm][/…]`)走 `amadeus/lib/calDateFmt` 的 `fmtCalDateL`,
 *   那是日历芯片的既有口径;本文件管的是时间戳(毫秒 / ISO / Date)。
 * - 数字千分位(`n.toLocaleString()`)不在本文件范围。
 *
 * 仪器:`i18nCoverage.test.ts` 的 H 断言扫源码,禁止本文件以外出现 `toLocaleDateString` /
 * `toLocaleTimeString` / `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat`。
 */
import { currentLocale, registerMessages, translateFor, type Locale } from '../i18n'

registerMessages({
  'time.justNow': { zh: '刚刚', en: 'just now' },
})

export type TimeInput = number | string | Date | null | undefined

export interface TimeOpts {
  /** 界面语言;缺省 = 当前界面语言。 */
  locale?: Locale
  /** 「现在」的基准(毫秒);缺省 Date.now()。相对时间的列表若常开,基准要由组件自己走(见 ArtificialView)。 */
  now?: number
}

/** 界面语言 → BCP 47 标签。 */
export function intlLocale(locale: Locale = currentLocale()): string {
  return locale === 'zh' ? 'zh-CN' : 'en'
}

/** 毫秒 / ISO 串 / Date → Date;解析不了返回 null(绝不渲出「Invalid Date」)。 */
export function toDate(at: TimeInput): Date | null {
  if (at == null || at === '') return null
  // 纯日期 `YYYY-MM-DD` 按**本地**那一天解读:`new Date('2026-09-17')` 是 UTC 午夜,西半球会串到前一天。
  const ymd = typeof at === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(at) : null
  const d = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : at instanceof Date ? at : new Date(at)
  return Number.isFinite(d.getTime()) ? d : null
}

/** zh:数字与汉字之间补一个空格(Intl 的 zh-CN 输出是「3天前」)。 */
function spaceCjk(s: string, locale: Locale): string {
  if (locale !== 'zh') return s
  return s.replace(/(\d)([一-龥])/g, '$1 $2').replace(/([一-龥])(\d)/g, '$1 $2')
}

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 相对时间的**单位选择**(与 Intl 的措辞分开,好让单测钉住逻辑而不看 ICU 版本的脸色)。
 *  一分钟以内 = 0 秒(显示「刚刚」);一年封顶用 year,不会出现「24 个月前」。 */
export function relativeParts(at: number, now: number): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const diff = at - now // 过去为负,正是 RelativeTimeFormat 的口径
  const abs = Math.abs(diff)
  if (abs < MIN) return { value: 0, unit: 'second' }
  if (abs < HOUR) return { value: Math.round(diff / MIN), unit: 'minute' }
  if (abs < DAY) return { value: Math.round(diff / HOUR), unit: 'hour' }
  if (abs < 30 * DAY) return { value: Math.round(diff / DAY), unit: 'day' }
  if (abs < 365 * DAY) return { value: Math.round(diff / (30 * DAY)), unit: 'month' }
  return { value: Math.round(diff / (365 * DAY)), unit: 'year' }
}

/** 「3 分钟前」/「3 minutes ago」;一分钟内「刚刚」/「just now」。解析不了返回 ''。 */
export function formatRelative(at: TimeInput, opts: TimeOpts = {}): string {
  const d = toDate(at)
  if (!d) return ''
  const locale = opts.locale ?? currentLocale()
  const { value, unit } = relativeParts(d.getTime(), opts.now ?? Date.now())
  if (unit === 'second') return translateFor(locale, 'time.justNow')
  try {
    return spaceCjk(new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' }).format(value, unit), locale)
  } catch {
    return formatDate(d, { locale }) // 极老的运行时:退回日期,不崩
  }
}

export interface DateOpts extends TimeOpts {
  /** 年份:auto = 不是今年才带(缺省);always = 总带;never = 不带。 */
  year?: 'auto' | 'always' | 'never'
}

function withYear(d: Date, opts: DateOpts): boolean {
  const mode = opts.year ?? 'auto'
  if (mode !== 'auto') return mode === 'always'
  return d.getFullYear() !== new Date(opts.now ?? Date.now()).getFullYear()
}

/** 「9月17日」/「Sep 17」(不是今年再带年份)。 */
export function formatDate(at: TimeInput, opts: DateOpts = {}): string {
  const d = toDate(at)
  if (!d) return ''
  const locale = opts.locale ?? currentLocale()
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'short', day: 'numeric', ...(withYear(d, opts) ? { year: 'numeric' } : {}),
  }).format(d)
}

/** 「9月17日 14:05」/「Sep 17, 14:05」(24 小时制)。 */
export function formatDateTime(at: TimeInput, opts: DateOpts = {}): string {
  const d = toDate(at)
  if (!d) return ''
  const locale = opts.locale ?? currentLocale()
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'short', day: 'numeric', ...(withYear(d, opts) ? { year: 'numeric' } : {}),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d)
}

/** 「14:05」(24 小时制,两种语言同形)。 */
export function formatTime(at: TimeInput): string {
  const d = toDate(at)
  if (!d) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 「9/17」:窄位(待办行尾、仪表盘紧凑行)用的数字月日,两种语言同形。 */
export function formatMonthDay(at: TimeInput): string {
  const d = toDate(at)
  return d ? `${d.getMonth() + 1}/${d.getDate()}` : ''
}

/** 列表行尾:7 天内相对时间,更早显示绝对日期。只给收件箱、造物这类**列表**用;时间轴保留相对时间。 */
export function formatListTime(at: TimeInput, opts: TimeOpts = {}): string {
  const d = toDate(at)
  if (!d) return ''
  const now = opts.now ?? Date.now()
  return Math.abs(now - d.getTime()) < 7 * DAY ? formatRelative(d, { ...opts, now }) : formatDate(d, { ...opts, now })
}

/** 月日 + 星期(主页时钟下的日期行):「9月17日 星期三」/「September 17 Wednesday」。 */
export function formatLongDate(at: TimeInput, opts: TimeOpts = {}): string {
  const d = toDate(at)
  if (!d) return ''
  const tag = intlLocale(opts.locale ?? currentLocale())
  return `${new Intl.DateTimeFormat(tag, { month: 'long', day: 'numeric' }).format(d)} ${new Intl.DateTimeFormat(tag, { weekday: 'long' }).format(d)}`
}

/** 仪表盘时钟卡片:指定时区的「14:05:09」与「9月17日周三」。时区写错时 Intl 抛 RangeError,由调用方兜底。 */
export function formatZonedClock(at: Date, opts: { locale?: Locale; timeZone?: string } = {}): { time: string; date: string } {
  const tag = intlLocale(opts.locale ?? currentLocale())
  const tz = opts.timeZone ? { timeZone: opts.timeZone } : {}
  return {
    time: new Intl.DateTimeFormat(tag, { ...tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at),
    date: new Intl.DateTimeFormat(tag, { ...tz, month: 'long', day: 'numeric', weekday: 'short' }).format(at),
  }
}
