import type { SpaceAppearance } from '../../../shared/spaceAppearance'
import { forcedSchemeForLanguage, hasLanguage, hasSkin, systemMode } from './registry'

export interface ResolvedAppearance {
  lang: string; skin: string; bg: string; seed: string; bgSeed: string
  modePref: 'light' | 'dark' | 'system'; mode: 'light' | 'dark'; modeLocked: boolean
}

export function resolveSpaceAppearance(global: ResolvedAppearance, local: SpaceAppearance = {}): ResolvedAppearance {
  const lang = local.lang && hasLanguage(local.lang) ? local.lang : global.lang
  const skin = local.skin && hasSkin(local.skin) ? local.skin : global.skin
  const bg = local.bg && hasSkin(local.bg) ? local.bg : global.bg
  const modePref = local.modePref ?? global.modePref
  // 语言沿用全局、且(全局锁了明暗 或 本 Space 没单独设明暗):直接用全局已落地的明暗。全局那份带着首帧的
  // forced_scheme 提示;在这里按 registry 重算的话,磁盘主题清单还没到时会先算成用户偏好,闪一下再变回来。
  const inherit = lang === global.lang && (global.modeLocked || local.modePref === undefined)
  const forced = inherit ? undefined : forcedSchemeForLanguage(lang)
  const pref = forced ?? modePref
  return {
    lang, skin, bg, modePref, modeLocked: inherit ? global.modeLocked : forced !== undefined,
    mode: inherit ? global.mode : pref === 'system' ? systemMode() : pref,
    // A dormant Space seed must not alter an inherited custom global color.
    seed: local.skin === 'custom' ? (local.seed ?? global.seed) : global.seed,
    bgSeed: local.bg === 'custom' ? (local.bgSeed ?? global.bgSeed) : global.bgSeed,
  }
}
