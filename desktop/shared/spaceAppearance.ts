/** Sparse overrides: an absent field always follows the global preference. */
export interface SpaceAppearance {
  lang?: string
  skin?: string
  bg?: string
  modePref?: 'light' | 'dark' | 'system'
  seed?: string
  bgSeed?: string
}

export interface SpaceAppearanceUpdate { id: string; appearance: SpaceAppearance }
export const SPACE_APPEARANCE_PREFIX = 'forsion_space_appearance.'
const ID = /^[A-Za-z0-9._-]{1,128}$/
const AXIS = /^[A-Za-z0-9._-]{1,64}$/
const HEX = /^#[0-9a-f]{6}$/i

export function normalizeSpaceAppearance(raw: unknown): SpaceAppearance {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const input = raw as Record<string, unknown>
  const out: SpaceAppearance = {}
  for (const key of ['lang', 'skin', 'bg'] as const) {
    if (typeof input[key] === 'string' && AXIS.test(input[key])) out[key] = input[key]
  }
  if (input.modePref === 'light' || input.modePref === 'dark' || input.modePref === 'system') out.modePref = input.modePref
  for (const key of ['seed', 'bgSeed'] as const) {
    if (typeof input[key] === 'string' && HEX.test(input[key])) out[key] = input[key]
  }
  // Empty background seed explicitly means "tint from the accent".
  if (input.bgSeed === '') out.bgSeed = ''
  return out
}

export function normalizeSpaceAppearanceUpdate(raw: unknown): SpaceAppearanceUpdate | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const v = raw as Record<string, unknown>
  if (typeof v.id !== 'string' || !ID.test(v.id) || !v.appearance || typeof v.appearance !== 'object' || Array.isArray(v.appearance)) return undefined
  return { id: v.id, appearance: normalizeSpaceAppearance(v.appearance) }
}
