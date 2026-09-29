/** 模板变量与日记命名(评审 G4-10):此前只认 `{{date}}` `{{time}}` `{{title}}` 三种精确写法,
 *  `{{date:YYYY-MM-DD dddd}}` `{{time:HH:mm}}` `{{Title}}` `{{ date }}` 全部原样留在正文里;日记名写死 `YYYY-MM-DD`、
 *  模板写死 `templates/daily.md`。口径对齐 Obsidian 核心插件「模板」与「日记」:
 *  - 变量:大小写 / 空白容忍,`{{date:fmt}}` / `{{time:fmt}}` 按 moment 常用子集格式化;缺省格式可由
 *    `.obsidian/templates.json` 的 dateFormat / timeFormat 给(从 Obsidian 搬来的库照旧生效)。
 *  - 日记:`.obsidian/daily-notes.json` 的 format / folder / template 作缺省(设置里的日记文件夹非空时优先)。
 *  纯函数,不碰 IO(IO 在 amadeusTemplates.ts)。月 / 星期名字走 format/time.ts 单源(U-29)。 */

import { formatDateName } from '../../format/time'

type Loc = 'zh' | 'en'
const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function isoWeek(d: Date): { week: number; year: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return { week: Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7), year: t.getUTCFullYear() }
}
const dayOfYear = (d: Date): number => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86400000) + 1
const ordinal = (n: number, loc: Loc): string => {
  if (loc === 'zh') return `${n}日`
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

/** moment 格式串的常用子集(Obsidian 日记 / 模板里实际会写到的那些)。`[...]` 里是字面量。
 *  不认识的字母原样输出(同 moment)。 */
const TOKEN_RE = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DDD|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a|Q|WW|W|GGGG|gggg|X|x/g
export function formatMoment(d: Date, fmt: string, loc: Loc = 'en'): string {
  return fmt.replace(TOKEN_RE, (tok, lit: string | undefined) => {
    if (lit !== undefined) return lit
    const h = d.getHours()
    switch (tok) {
      case 'YYYY': return String(d.getFullYear())
      case 'YY': return pad(d.getFullYear() % 100)
      case 'MMMM': return formatDateName(d, 'month', loc)
      case 'MMM': return formatDateName(d, 'monthShort', loc)
      case 'MM': return pad(d.getMonth() + 1)
      case 'M': return String(d.getMonth() + 1)
      case 'DDDD': return pad(dayOfYear(d), 3)
      case 'DDD': return String(dayOfYear(d))
      case 'Do': return ordinal(d.getDate(), loc)
      case 'DD': return pad(d.getDate())
      case 'D': return String(d.getDate())
      case 'dddd': return formatDateName(d, 'weekday', loc)
      case 'ddd': return formatDateName(d, 'weekdayShort', loc)
      case 'dd': return loc === 'zh' ? formatDateName(d, 'weekdayNarrow', loc) : formatDateName(d, 'weekdayShort', loc).slice(0, 2)
      case 'd': return String(d.getDay())
      case 'HH': return pad(h)
      case 'H': return String(h)
      case 'hh': return pad(h % 12 || 12)
      case 'h': return String(h % 12 || 12)
      case 'mm': return pad(d.getMinutes())
      case 'm': return String(d.getMinutes())
      case 'ss': return pad(d.getSeconds())
      case 's': return String(d.getSeconds())
      case 'A': return loc === 'zh' ? (h < 12 ? '上午' : '下午') : h < 12 ? 'AM' : 'PM'
      case 'a': return loc === 'zh' ? (h < 12 ? '上午' : '下午') : h < 12 ? 'am' : 'pm'
      case 'Q': return String(Math.floor(d.getMonth() / 3) + 1)
      case 'WW': return pad(isoWeek(d).week)
      case 'W': return String(isoWeek(d).week)
      case 'GGGG':
      case 'gggg': return String(isoWeek(d).year)
      case 'X': return String(Math.floor(d.getTime() / 1000))
      case 'x': return String(d.getTime())
      default: return tok
    }
  })
}

export interface TemplateVarOpts {
  title: string
  now?: Date
  /** `{{date}}` 的缺省格式(Obsidian templates.json 的 dateFormat);缺省 YYYY-MM-DD。 */
  dateFormat?: string
  /** `{{time}}` 的缺省格式(templates.json 的 timeFormat);缺省 HH:mm。 */
  timeFormat?: string
  locale?: Loc
}

/** `{{date}}` / `{{date:fmt}}` / `{{time}}` / `{{time:fmt}}` / `{{title}}`,大小写与花括号内空白都容忍。 */
const VAR_RE = /\{\{\s*(date|time|title)\s*(?::([^{}]*))?\}\}/gi
export function substituteTemplateVars(content: string, o: TemplateVarOpts): string {
  const now = o.now ?? new Date()
  const loc = o.locale ?? 'en'
  return content.replace(VAR_RE, (_m, name: string, fmt: string | undefined) => {
    const key = name.toLowerCase()
    if (key === 'title') return o.title
    const f = fmt?.trim() || (key === 'date' ? o.dateFormat || 'YYYY-MM-DD' : o.timeFormat || 'HH:mm')
    return formatMoment(now, f, loc)
  })
}

/** Obsidian 核心插件的配置(读不懂 = 空对象,一律回落缺省)。 */
export interface ObsidianDailyCfg { format?: string; folder?: string; template?: string }
export interface ObsidianTemplatesCfg { folder?: string; dateFormat?: string; timeFormat?: string }
export function parseObsidianCfg<T extends object>(raw: string | null | undefined): Partial<T> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string' && val.trim()) out[k] = val.trim()
    return out as Partial<T>
  } catch {
    return {}
  }
}

const trimSlashes = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

/** 今天那篇日记的库内路径。folder:设置里的日记文件夹非空时优先,否则 daily-notes.json 的 folder;
 *  名字按 format(缺省 YYYY-MM-DD,可含 `/` 分层,同 Obsidian)。 */
export function dailyNotePath(now: Date, settingsFolder: string | undefined, cfg: ObsidianDailyCfg, loc: Loc = 'en'): string {
  const folder = trimSlashes((settingsFolder ?? '').trim() || cfg.folder || '')
  const name = trimSlashes(formatMoment(now, cfg.format || 'YYYY-MM-DD', loc)) || formatMoment(now, 'YYYY-MM-DD')
  const file = /\.md$/i.test(name) ? name : `${name}.md`
  return folder ? `${folder}/${file}` : file
}

/** 日记模板的库内路径:daily-notes.json 的 template(不带 .md,同 Obsidian)命中库里的笔记优先,
 *  否则老约定 `templates/daily.md`(大小写不敏感);都没有 → null。 */
export function dailyTemplatePath(pages: string[], cfg: ObsidianDailyCfg): string | null {
  if (cfg.template) {
    const want = trimSlashes(cfg.template).replace(/\.md$/i, '').toLowerCase() + '.md'
    const hit = pages.find((p) => p.toLowerCase() === want)
    if (hit) return hit
  }
  return pages.find((p) => /^templates\/daily\.md$/i.test(p)) ?? null
}
