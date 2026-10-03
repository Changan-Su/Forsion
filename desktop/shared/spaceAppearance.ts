/** Sparse overrides: an absent field always follows the global preference. */
export interface SpaceAppearance {
  lang?: string
  skin?: string
  bg?: string
  modePref?: 'light' | 'dark' | 'system'
  seed?: string
  bgSeed?: string
}

/** `at` = 发方写入那一刻的毫秒戳(同机各窗口同一个钟)。收方只认不比已知更旧的更新 —— IPC 与 storage 两条通道
 *  到达顺序不定,没有它,晚到的旧消息会把较新的保存盖回去。 */
export interface SpaceAppearanceUpdate { id: string; appearance: SpaceAppearance; at?: number }
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
  const at = typeof v.at === 'number' && Number.isSafeInteger(v.at) && v.at > 0 ? v.at : undefined
  return { id: v.id, appearance: normalizeSpaceAppearance(v.appearance), ...(at ? { at } : {}) }
}
