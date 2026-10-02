import { create } from 'zustand'
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, patchAppearance, readAppearance, validAppearanceImage, type AppearancePatch, type AppearancePreset, type StartupAppearance } from '../../../shared/startupAppearance'

const host = () => typeof window === 'undefined' ? undefined : window.tangu?.startupAppearance
function initial(): StartupAppearance {
  if (host()) return readAppearance(host()!.initial)
  try { return readAppearance(JSON.parse(localStorage.getItem(APPEARANCE_KEY) || 'null')) } catch { return { ...DEFAULT_APPEARANCE } }
}
export interface RegisteredAppearance extends AppearancePreset { pluginId: string; key: string; token: object }
export const useAppearance = create<{ value: StartupAppearance; presets: RegisteredAppearance[] }>(() => ({ value: initial(), presets: [] }))

function receive(value: StartupAppearance): void { useAppearance.setState({ value: readAppearance(value) }) }
host()?.subscribe(receive)
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (!host() && event.key === APPEARANCE_KEY) {
    receive(initial())
  }
})
export async function updateAppearance(patch: AppearancePatch, clearPlugin?: string): Promise<void> {
  if (host()) { receive(await host()!.update(patch, clearPlugin)); return }
  const write = (): void => {
    // Other tabs may have saved since this tab last rendered. Merge against storage.
    const current = initial()
    const next = clearPlugin ? {
      ...current,
      icon: current.icon?.pluginId === clearPlugin ? null : current.icon,
      splash: current.splash?.pluginId === clearPlugin ? null : current.splash,
    } : patchAppearance(current, patch)
    // Commit the preference only after storage succeeds; quota errors stay visible to the user.
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next))
    receive(next)
  }
  if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(APPEARANCE_KEY, write)
  else write()
}
export function clearPluginAppearance(pluginId: string): void {
  // Another window may have a pending selection unknown to this renderer. Always queue cleanup.
  void updateAppearance({}, pluginId).catch((error) => console.error('[appearance] Plugin cleanup failed', error))
}
export function registerAppearance(pluginId: string, preset: AppearancePreset): () => void {
  if (!preset || typeof preset.id !== 'string' || !/^[\w.-]{1,80}$/.test(preset.id)
    || typeof preset.label !== 'string' || !preset.label || preset.label.length > 160
    || (preset.labelEn !== undefined && (typeof preset.labelEn !== 'string' || preset.labelEn.length > 160))
    || (!preset.icon && !preset.splash)
    || (preset.icon !== undefined && !validAppearanceImage(preset.icon))
    || (preset.splash !== undefined && !validAppearanceImage(preset.splash))) throw new Error('Invalid appearance preset')
  const token = {}
  const key = `plugin:${pluginId}:${preset.id}`
  useAppearance.setState((s) => ({ presets: [...s.presets.filter((p) => p.key !== key), { ...preset, pluginId, key, token }] }))
  return () => useAppearance.setState((s) => ({ presets: s.presets.filter((p) => p.token !== token) }))
}

/** Decode once before saving; icons become bounded static PNGs for Electron and every renderer. */
export async function prepareAppearanceImage(data: string, icon: boolean): Promise<string> {
  if (!validAppearanceImage(data)) throw new Error('Unsupported or oversized image')
  const image = new Image()
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { image.src = ''; reject(new Error('Image load timed out')) }, 5000)
    image.onload = () => { clearTimeout(timer); resolve() }
    image.onerror = () => { clearTimeout(timer); reject(new Error('Cannot read image')) }
  })
  image.src = data
  await loaded
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 4096 || image.naturalHeight > 4096) throw new Error('Image dimensions exceed 4096 pixels')
  if (!icon) return data
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const context = canvas.getContext('2d')!
  const scale = Math.min(256 / image.naturalWidth, 256 / image.naturalHeight)
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale
  context.drawImage(image, (256 - width) / 2, (256 - height) / 2, width, height)
  return canvas.toDataURL('image/png')
}
