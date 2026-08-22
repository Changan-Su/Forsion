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

/** pluginStore.enable() 自动给每个启用插件塞的「工作文件夹」设置行的 key。人人都有 → 不算「有设置面板」。 */
export const AUTO_WORK_FOLDER_KEY = 'workFolder'

/** 够格在设置左栏单独占一项的插件:已启用,且除了自动那行 workFolder 之外还有真设置
 *  (声明式 registerSetting 行 或 registerSettingsView 自绘面板)。
 *  不这么滤的话每个启用插件都「有设置」,左栏会被几十个条目冲垮 —— 那比藏起来更糟。 */
export function pluginsWithSettingsPanel<T extends { id: string }>(
  plugins: readonly T[],
  activeIds: readonly string[],
  settings: ReadonlyArray<{ pluginId: string; item: { key: string } }>,
  settingsViews: ReadonlyArray<{ pluginId: string }>,
): T[] {
  return plugins.filter((p) => activeIds.includes(p.id) && (
    settings.some((o) => o.pluginId === p.id && o.item.key !== AUTO_WORK_FOLDER_KEY)
    || settingsViews.some((o) => o.pluginId === p.id)
  ))
}

/** 插件详情面归属:受控 id(左栏 `fplugin:<id>` 深链)**只在解析得到插件时**才压过列表内部选中态。
 *  ⚠️ 无条件优先是个坑:插件被卸载/禁用后受控 id 仍非空,回落的卡片列表里每次点击都会被它盖掉,
 *  成了一张点不开的假列表(codex 评审 2026-08-21)。 */
export function resolvePluginDetail<T extends { id: string }>(
  plugins: readonly T[],
  controlledId: string | undefined,
  localId: string | null,
): { plugin?: T; controlled: boolean } {
  const forced = controlledId ? plugins.find((p) => p.id === controlledId) : undefined
  if (forced) return { plugin: forced, controlled: true }
  return { plugin: localId ? plugins.find((p) => p.id === localId) : undefined, controlled: false }
}
