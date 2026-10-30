/** Agent 的显示名。界面一律走这里,别直接读 def.name:那是引擎写给老版本的,不跟界面语言。 */
import { currentLocale, type Locale } from './i18n'
import type { NormalAgentDef } from './types'

type Named = Pick<NormalAgentDef, 'name' | 'nameZh' | 'nameEn' | 'namePref'> & { slug?: string }

/** 跟随界面时当前语言的名字优先、没有就用另一个;选了固定名字就一直用那个。临时 Agent 没有两个名字,回落 name。 */
export function agentName(a: Named | null | undefined, locale: Locale = currentLocale()): string {
  if (!a) return ''
  const enFirst = a.namePref === 'en' || (a.namePref !== 'zh' && locale === 'en')
  return (enFirst ? a.nameEn || a.nameZh : a.nameZh || a.nameEn) || a.name || a.slug || ''
}

/** 英文名不许有汉字(引擎 buildAgentDef 同规则,这里先拦:输入时就提示)。 */
export const hasHan = (s: string): boolean => /\p{Script=Han}/u.test(s)

/** 这个 Agent 的全部名字(去重):搜索、按名认人时任一个都算。 */
export function agentNames(a: Named): string[] {
  return [...new Set([a.nameZh, a.nameEn, a.name].map((n) => (n || '').trim()).filter(Boolean))]
}
