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
  const forced = forcedSchemeForLanguage(lang)
  const pref = forced ?? modePref
  return {
    lang, skin, bg, modePref, modeLocked: forced !== undefined,
    mode: pref === 'system' ? systemMode() : pref,
    // A dormant Space seed must not alter an inherited custom global color.
    seed: local.skin === 'custom' ? (local.seed ?? global.seed) : global.seed,
    bgSeed: local.bg === 'custom' ? (local.bgSeed ?? global.bgSeed) : global.bgSeed,
  }
}
