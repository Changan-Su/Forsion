// 插件展示名/描述/引导的**语言解析单点**(2026-08-14 起,codex 评审定的口径)。
//
// 铁律:中文是 canonical,英文只是镜像 —— 任何一处缺失/坏掉都逐字段回退中文,绝不整段消失。
// 更关键的是**只用于展示**:插件 id、localStorage 键、引导完成态、通知静音键,以及由 `plugin.name`
// 派生的默认工作文件夹,一律仍走 canonical 名 —— 否则用户切成英文就像换了个数据目录。
import type { PluginOnboardingSpec } from '@amadeus-shared/ipc'
import type { Locale } from '../../i18n'
import type { AmadeusPlugin } from './types'

type Named = Pick<AmadeusPlugin, 'name' | 'nameEn' | 'description' | 'descriptionEn'>

export function pluginDisplayName(p: Named, locale: Locale): string {
  return locale === 'en' && p.nameEn ? p.nameEn : p.name
}

export function pluginDisplayDescription(p: Named, locale: Locale): string | undefined {
  return locale === 'en' && p.descriptionEn ? p.descriptionEn : p.description
}

/** 把 onboarding 解析成当前语言的一份(结构字段 settings/recommends 原样保留)。 */
export function localizedOnboarding(
  ob: PluginOnboardingSpec | undefined,
  locale: Locale,
): PluginOnboardingSpec | undefined {
  if (!ob || locale !== 'en' || !ob.en) return ob
  const steps = ob.steps?.map((s, i) => {
    const e = ob.en?.steps?.[i]
    if (!e) return s
    // 逐字段回退:英文只翻了标题时,描述继续用中文,而不是把描述吞掉。
    return e.description ? { title: e.title || s.title, description: e.description } : { title: e.title || s.title, ...(s.description ? { description: s.description } : {}) }
  })
  return { ...ob, intro: ob.en.intro || ob.intro, ...(steps ? { steps } : {}) }
}
