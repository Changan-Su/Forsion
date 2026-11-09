/**
 * 引导「关于你」(11-08 方案 A)写进 human/MEMORY.md 的那一节:文件最前面的 `## 关于我` / `## About me` + 几行标签。
 *
 * - 读:引擎播种的英文空模板(任一版本)当空;两种语言的标签都认(含旧快捷句「怎么称呼我：」「How I like answers:」),
 *   只在开头那一块认(见 parseAboutMe;别的标题底下、代码块里不碰),每种只认第一次、值放得进表单的那一行;
 *   认不得的行原样留给自由框,顺序不变。
 * - 写:整节按一种语言写 —— 名字或「自己写」里有汉字就中文,有字但没汉字就英文,只点了胶囊按原来那一节的语言,
 *   都没有就按界面语言(`sectionLang`)。胶囊 / 标签从字典 `ob3.you.file.*` 按那一节的语言取,不按界面。
 * - 自由框 = 文件里除了认得的那几行之外的全部;存回 = 那一节 + 空一行 + 自由框原样。
 * 纯函数,不碰引擎;判「改没改」比两次序列化的结果,不和原文比(原文的空行 / 换行风格不该让老资料被重写一遍)。
 */
import { translateFor, type Locale } from '../../i18n'
import { isUserMdTemplateText } from '../../../../../tangu-agent/src/contracts/userMdTemplate'
import './messages'

export const WORKS = ['code', 'design', 'writing', 'study', 'research', 'lead'] as const
export type Work = typeof WORKS[number]
export const STYLES = ['short', 'why', 'conclusion'] as const
export type Style = typeof STYLES[number]
export type AnswerLang = 'auto' | 'zh' | 'en'
export const NAME_MAX = 40
export const WORK_TEXT_MAX = 60

export interface AboutMe { name: string; works: Work[]; workText: string; style: Style | ''; lang: AnswerLang; more: string }
export interface ParsedAboutMe { form: AboutMe; sectionLang: Locale | null }
export const EMPTY_ABOUT_ME: AboutMe = { name: '', works: [], workText: '', style: '', lang: 'auto', more: '' }

/** 一节里的标点:中文全角、英文半角。 */
const PUNCT = {
  zh: { sep: '：', join: '、', own: '；' },
  en: { sep: ': ', join: ', ', own: '; ' },
} as const
/** 旧快捷句(#494 那版三颗「＋」)插的标签,读的时候也认。 */
const ALIASES = {
  zh: { name: ['怎么称呼我'], style: ['回答方式'] },
  en: { name: [] as string[], style: ['How I like answers'] },
} as const

const LANGS: readonly Locale[] = ['zh', 'en']
const L = (lang: Locale, key: string): string => translateFor(lang, key)
const HAN = /[㐀-鿿豈-﫿]/
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const norm = (s: string): string => s.trim().replace(/[。.]+$/, '').toLowerCase()
/** 去掉首尾的空行和末尾空白,中间一字不动。 */
const trimBlank = (s: string): string => s.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')

/** 这一节用哪种语言写。fallback = 原来那一节的语言,没有就界面语言。 */
export function sectionLangOf(a: AboutMe, fallback: Locale): Locale {
  const typed = `${a.name}${a.workText}`.trim()
  if (HAN.test(typed)) return 'zh'
  if (typed) return 'en'
  return fallback
}

/** 只有那一节(不含自由框);什么都没填给空串。 */
export function serializeSection(a: AboutMe, lang: Locale): string {
  const p = PUNCT[lang]
  const lines: string[] = []
  const name = a.name.trim()
  if (name) lines.push(`- ${L(lang, 'ob3.you.file.name')}${p.sep}${name}`)
  const works = WORKS.filter((w) => a.works.includes(w)).map((w) => L(lang, `ob3.you.file.work.${w}`)).join(p.join)
  const work = [works, a.workText.trim()].filter(Boolean).join(p.own)
  if (work) lines.push(`- ${L(lang, 'ob3.you.file.work')}${p.sep}${work}`)
  if (a.style) lines.push(`- ${L(lang, 'ob3.you.file.style')}${p.sep}${L(lang, `ob3.you.file.style.${a.style}`)}`)
  if (a.lang !== 'auto') lines.push(`- ${L(lang, `ob3.you.file.lang.${a.lang}`)}`)
  return lines.length ? `## ${L(lang, 'ob3.you.file.head')}\n${lines.join('\n')}` : ''
}

/** 整份文件:那一节 + 空一行 + 自由框。两样都空给空串。 */
export function serializeAboutMe(a: AboutMe, lang: Locale): string {
  const body = [serializeSection(a, lang), trimBlank(a.more)].filter(Boolean).join('\n\n')
  return body ? `${body}\n` : ''
}

type Kind = 'name' | 'work' | 'style' | 'lang'
interface Hit { kind: Kind; lang: Locale; apply: (f: AboutMe) => void }

/** 「在做」的值:开头连着的胶囊(两种语言、不分大小写,后面跟分隔符或到头)认成胶囊,剩下的是自己写的。 */
function parseWork(value: string): { works: Work[]; own: string } {
  let rest = value.trim()
  const works: Work[] = []
  for (;;) {
    let hit: { w: Work; len: number } | null = null
    for (const w of WORKS) {
      for (const lang of LANGS) {
        const m = new RegExp(`^${esc(L(lang, `ob3.you.file.work.${w}`))}\\s*(?:[、，,；;]\\s*|$)`, 'i').exec(rest)
        if (m && (!hit || m[0].length > hit.len)) hit = { w, len: m[0].length }
      }
    }
    if (!hit) break
    if (!works.includes(hit.w)) works.push(hit.w)
    rest = rest.slice(hit.len)
  }
  return { works, own: rest.trim() }
}

/** 这一行是不是那一节的标题(两种语言都认),是就给出语言。 */
function matchHead(line: string): Locale | null {
  const s = line.trim()
  return LANGS.find((lang) => new RegExp(`^#{1,6}\\s*${esc(L(lang, 'ob3.you.file.head'))}\\s*$`, 'i').test(s)) ?? null
}

function matchField(line: string): Hit | null {
  const s = line.trim()
  if (!s) return null
  for (const lang of LANGS) {
    for (const answer of ['zh', 'en'] as const) {
      if (new RegExp(`^(?:[-*+]\\s+)?${esc(L(lang, `ob3.you.file.lang.${answer}`))}\\s*[。.]?$`, 'i').test(s)) return { kind: 'lang', lang, apply: (f) => { f.lang = answer } }
    }
    const labeled = (labels: readonly string[]): string | null => {
      const m = new RegExp(`^(?:[-*+]\\s+)?(?:${labels.map(esc).join('|')})\\s*[：:]\\s*(.*)$`, 'i').exec(s)
      return m ? m[1] : null
    }
    const name = labeled([L(lang, 'ob3.you.file.name'), ...ALIASES[lang].name])
    if (name !== null) return name.trim().length <= NAME_MAX ? { kind: 'name', lang, apply: (f) => { f.name = name.trim() } } : null
    const work = labeled([L(lang, 'ob3.you.file.work')])
    if (work !== null) {
      const { works, own } = parseWork(work)
      return own.length <= WORK_TEXT_MAX ? { kind: 'work', lang, apply: (f) => { f.works = works; f.workText = own } } : null
    }
    const style = labeled([L(lang, 'ob3.you.file.style'), ...ALIASES[lang].style])
    if (style !== null) {
      if (!style.trim()) return { kind: 'style', lang, apply: (f) => { f.style = '' } }
      const v = norm(style)
      const pick = STYLES.find((x) => LANGS.some((l) => norm(L(l, `ob3.you.file.style.${x}`)) === v))
      return pick ? { kind: 'style', lang, apply: (f) => { f.style = pick } } : null
    }
  }
  return null
}

const FENCE = /^\s{0,3}(?:```|~~~)/
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/

/** 读回:空 / 空模板 → 全空。认字段只在「开头那一块」:文件以那一节的标题开头 → 标题下面到下一个标题;
 *  否则 → 第一个标题之前(旧快捷句插的就在这里)。别的标题底下、围栏代码块里一律不碰。
 *  每种只认第一次;那一节的标题只在底下认出了字段时才算这一屏的(拿掉、存时重新生成),只有自己写的话就原样留着。
 *  其余行按原顺序进自由框。 */
export function parseAboutMe(content: string): ParsedAboutMe {
  if (!content.trim() || isUserMdTemplateText(content)) return { form: { ...EMPTY_ABOUT_ME, works: [] }, sectionLang: null }
  const form: AboutMe = { ...EMPTY_ABOUT_ME, works: [] }
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const top = lines.findIndex((l) => l.trim())
  const headLang = top >= 0 ? matchHead(lines[top]) : null
  const taken = new Set<number>()
  const seen = new Set<Kind>()
  let firstLang: Locale | null = null, fence = false
  for (let i = headLang ? top + 1 : 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { fence = !fence; continue }
    if (fence) continue
    if (HEADING.test(lines[i])) break
    const hit = matchField(lines[i])
    if (hit && !seen.has(hit.kind)) { seen.add(hit.kind); hit.apply(form); firstLang ??= hit.lang; taken.add(i) }
  }
  const ours = !!headLang && taken.size > 0
  if (ours) taken.add(top)
  form.more = trimBlank(lines.filter((_, i) => !taken.has(i)).join('\n'))
  return { form, sectionLang: ours ? headLang : firstLang }
}
