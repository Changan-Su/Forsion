/** Serializable, image-only startup contract. No plugin code or CSS runs before bootstrap. */
export const APPEARANCE_KEY = 'forsion_startup_appearance_v1'
export const MAX_IMAGE_LENGTH = 2_000_000
export const MAX_ICON_LENGTH = 800_000
export const ANIMATIONS = ['default', 'pulse', 'spin', 'none'] as const
export type StartupAnimation = typeof ANIMATIONS[number]
export interface AppearanceAsset {
  id: string
  label: string
  labelEn?: string
  pluginId?: string
  image: string
  /** Static first frame for the Still option. */
  poster?: string
}
export interface StartupAppearance {
  version: 1
  showSplash: boolean
  animation: StartupAnimation
  icon: AppearanceAsset | null
  splash: AppearanceAsset | null
  nativeIcon: boolean
}
export type AppearancePatch = Partial<Omit<StartupAppearance, 'version'>>
export const DEFAULT_APPEARANCE: StartupAppearance = {
  version: 1, showSplash: true, animation: 'default', icon: null, splash: null, nativeIcon: true,
}
export interface AppearancePreset {
  id: string
  label: string
  labelEn?: string
  /** Embedded data images; PNG/JPEG/WebP/GIF/SVG. The host rasterizes the icon. */
  icon?: string
  splash?: string
}
export function validAppearanceImage(value: unknown, icon = false): value is string {
  return typeof value === 'string' && value.length <= (icon ? MAX_ICON_LENGTH : MAX_IMAGE_LENGTH)
    && (icon ? /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/ : /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/).test(value)
}
function asset(value: unknown, icon: boolean): AppearanceAsset | null {
  if (value === null) return null
  const v = value as AppearanceAsset
  if (!v || typeof v.id !== 'string' || !v.id || v.id.length > 240
    || typeof v.label !== 'string' || !v.label || v.label.length > 160
    || (v.labelEn !== undefined && (typeof v.labelEn !== 'string' || v.labelEn.length > 160))
    || (v.pluginId !== undefined && (typeof v.pluginId !== 'string' || !/^[\w.-]{1,120}$/.test(v.pluginId)))
    || !validAppearanceImage(v.image, icon)
    || (v.poster !== undefined && !validAppearanceImage(v.poster, true))) throw new Error('Invalid appearance image')
  return { id: v.id, label: v.label, ...(v.labelEn ? { labelEn: v.labelEn } : {}), ...(v.pluginId ? { pluginId: v.pluginId } : {}), image: v.image, ...(v.poster ? { poster: v.poster } : {}) }
}
/** Strict at writes, forgiving at boot (caller catches and uses defaults). */
export function patchAppearance(current: StartupAppearance, input: unknown): StartupAppearance {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid appearance settings')
  const p = input as AppearancePatch
  const next = { ...current }
  if ('showSplash' in p) { if (typeof p.showSplash !== 'boolean') throw new Error('Invalid splash switch'); next.showSplash = p.showSplash }
  if ('nativeIcon' in p) { if (typeof p.nativeIcon !== 'boolean') throw new Error('Invalid icon switch'); next.nativeIcon = p.nativeIcon }
  if ('animation' in p) { if (!ANIMATIONS.includes(p.animation!)) throw new Error('Invalid animation'); next.animation = p.animation! }
  if ('icon' in p) next.icon = asset(p.icon, true)
  if ('splash' in p) next.splash = asset(p.splash, false)
  return next
}
export function readAppearance(value: unknown): StartupAppearance {
  try {
    if ((value as StartupAppearance)?.version !== 1) return { ...DEFAULT_APPEARANCE }
    return patchAppearance(DEFAULT_APPEARANCE, value)
  } catch { return { ...DEFAULT_APPEARANCE } }
}
