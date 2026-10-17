/**
 * 主页壁纸偏好与图片存储。
 *
 * 偏好是很小的 JSON,放 localStorage 便于即时恢复;用户原图是 Blob,放 IndexedDB。
 * 不把 data URL 塞 localStorage:一张手机照片就足以撞穿常见的 5–10 MB 配额,继而连主题/布局也写不进去。
 */

export type HomepageWallpaperSource = 'theme' | 'bing' | 'image'
export type HomepageThemePreset = 'orbit' | 'path' | 'paper'
/** 「图片」来源里选哪张:随包的 Hack2Gate 海报,或用户自己上传的那张(IndexedDB)。 */
export type HomepageImageChoice = 'hack2gate' | 'custom'

export interface BingWallpaper {
  id: string
  url: string
  thumbnailUrl: string
  title: string
  copyright: string
  startDate: string
}

export interface HomepageWallpaperPrefs {
  source: HomepageWallpaperSource
  themePreset: HomepageThemePreset
  imageChoice: HomepageImageChoice
  bingDaily: boolean
  focusBlur: boolean
  vignette: boolean
  /** 主题背景的动态效果(星轨公转、日行光晕);系统「减弱动态效果」打开时一律不动。设置 → 外观里那一行读写同一个值。 */
  motion: boolean
  bing: BingWallpaper | null
}

export const HOMEPAGE_WALLPAPER_PREFS_KEY = 'forsion.homepage.wallpaper.v1'
export const HOMEPAGE_CUSTOM_WALLPAPER_MAX_BYTES = 32 * 1024 * 1024

export const DEFAULT_HOMEPAGE_WALLPAPER_PREFS: HomepageWallpaperPrefs = {
  source: 'theme',
  themePreset: 'orbit',
  imageChoice: 'hack2gate',
  bingDaily: true,
  focusBlur: true,
  vignette: true,
  motion: true,
  bing: null,
}

const asText = (value: unknown): string => typeof value === 'string' ? value : ''

/** 只接纳 Bing 自己的 https 图片,防止持久化数据被篡改后变成任意远端追踪像素。 */
function safeBingUrl(value: unknown): string {
  const raw = asText(value)
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && (url.hostname === 'www.bing.com' || url.hostname.endsWith('.bing.com')) ? url.toString() : ''
  } catch {
    return ''
  }
}

export function normalizeBingWallpaper(value: unknown): BingWallpaper | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const url = safeBingUrl(raw.url)
  if (!url) return null
  const thumbnailUrl = safeBingUrl(raw.thumbnailUrl) || url
  const startDate = asText(raw.startDate)
  return {
    id: asText(raw.id) || startDate || url,
    url,
    thumbnailUrl,
    title: asText(raw.title),
    copyright: asText(raw.copyright),
    startDate,
  }
}

/** 10-17 换了一套主题背景:旧三张各映射到气质最近的新图;Hack2Gate 是位图,挪进「图片」来源;旧「自定义」并进「图片」。 */
const LEGACY_PRESETS: Record<string, HomepageThemePreset> = { rings: 'orbit', topography: 'path', weave: 'paper' }

export function normalizeHomepageWallpaperPrefs(value: unknown): HomepageWallpaperPrefs {
  if (!value || typeof value !== 'object') return { ...DEFAULT_HOMEPAGE_WALLPAPER_PREFS }
  const raw = value as Record<string, unknown>
  const legacyHack2gate = raw.themePreset === 'hack2gate'
  let source: HomepageWallpaperSource = raw.source === 'bing' || raw.source === 'image' ? raw.source : 'theme'
  let imageChoice: HomepageImageChoice = raw.imageChoice === 'custom' ? 'custom' : 'hack2gate'
  if (raw.source === 'custom') { source = 'image'; imageChoice = 'custom' }
  else if (legacyHack2gate && source === 'theme') { source = 'image'; imageChoice = 'hack2gate' }
  const preset = typeof raw.themePreset === 'string' ? raw.themePreset : ''
  const themePreset: HomepageThemePreset = preset === 'orbit' || preset === 'path' || preset === 'paper' ? preset : Object.hasOwn(LEGACY_PRESETS, preset) ? LEGACY_PRESETS[preset] : 'orbit'
  return {
    source,
    themePreset,
    imageChoice,
    bingDaily: raw.bingDaily !== false,
    focusBlur: raw.focusBlur !== false,
    vignette: raw.vignette !== false,
    motion: raw.motion !== false,
    bing: normalizeBingWallpaper(raw.bing),
  }
}

export function loadHomepageWallpaperPrefs(): HomepageWallpaperPrefs {
  try {
    return normalizeHomepageWallpaperPrefs(JSON.parse(localStorage.getItem(HOMEPAGE_WALLPAPER_PREFS_KEY) || 'null'))
  } catch {
    return { ...DEFAULT_HOMEPAGE_WALLPAPER_PREFS }
  }
}

export function saveHomepageWallpaperPrefs(prefs: HomepageWallpaperPrefs): void {
  try { localStorage.setItem(HOMEPAGE_WALLPAPER_PREFS_KEY, JSON.stringify(prefs)) } catch { /* 无持久化能力时仍保留本次会话态 */ }
}

const PREFS_CHANGED = 'forsion:homepage-wallpaper'
/** 设置 → 外观的「主页壁纸动效」写同一份偏好。桌面端设置是另一扇窗(storage 事件);网页版设置在同一个文档里,storage 不触发,补一个自定义事件。 */
export function setHomepageWallpaperMotion(motion: boolean): void {
  saveHomepageWallpaperPrefs({ ...loadHomepageWallpaperPrefs(), motion })
  window.dispatchEvent(new Event(PREFS_CHANGED))
}
export function onHomepageWallpaperPrefsChange(run: () => void): () => void {
  const onStorage = (event: StorageEvent): void => { if (event.key === HOMEPAGE_WALLPAPER_PREFS_KEY || event.key === null) run() }
  window.addEventListener('storage', onStorage)
  window.addEventListener(PREFS_CHANGED, run)
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(PREFS_CHANGED, run) }
}

/** Bing HPImageArchive 的 renderer web 回落与 Electron IPC 返回都汇入同一个窄类型。 */
export function mapBingArchive(value: unknown): BingWallpaper[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).images)
      ? (value as { images: unknown[] }).images
      : []
  return list.flatMap((entry): BingWallpaper[] => {
    if (!entry || typeof entry !== 'object') return []
    const raw = entry as Record<string, unknown>
    const base = asText(raw.urlbase)
    const given = asText(raw.url)
    const original = base ? `https://www.bing.com${base}_UHD.jpg` : given.startsWith('/') ? `https://www.bing.com${given}` : given
    const thumb = base ? `https://www.bing.com${base}_400x240.jpg` : original
    const item = normalizeBingWallpaper({
      id: asText(raw.startdate) || base || original,
      url: original,
      thumbnailUrl: thumb,
      title: raw.title,
      copyright: raw.copyright,
      startDate: raw.startdate,
    })
    return item ? [item] : []
  })
}

export async function fetchBingWallpapers(locale: string): Promise<BingWallpaper[]> {
  if (window.tangu?.wallpaperListBing) {
    const result = await window.tangu.wallpaperListBing(locale === 'zh' ? 'zh-CN' : 'en-US', 8)
    if (!result.ok) throw new Error(result.error || 'Bing wallpaper unavailable')
    return result.items.map(normalizeBingWallpaper).filter((item): item is BingWallpaper => !!item)
  }
  const response = await fetch(`/api/wallpaper/daily?mkt=${locale === 'zh' ? 'zh-CN' : 'en-US'}&n=8&idx=0`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return mapBingArchive(await response.json())
}

const DB_NAME = 'forsion-homepage'
const DB_STORE = 'wallpaper'
const CUSTOM_KEY = 'custom'

function openWallpaperDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'))
  })
}

async function withWallpaperStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openWallpaperDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode)
      const req = run(tx.objectStore(DB_STORE))
      let result: T
      req.onsuccess = () => { result = req.result }
      req.onerror = () => reject(req.error || tx.error || new Error('Wallpaper storage failed'))
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error || new Error('Wallpaper storage failed'))
      tx.onabort = () => reject(tx.error || new Error('Wallpaper storage aborted'))
    })
  } finally {
    db.close()
  }
}

export async function readCustomWallpaper(): Promise<Blob | null> {
  const value = await withWallpaperStore<unknown>('readonly', (store) => store.get(CUSTOM_KEY))
  return value instanceof Blob && value.type.startsWith('image/') ? value : null
}

export async function writeCustomWallpaper(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) throw new Error('NOT_IMAGE')
  if (file.size > HOMEPAGE_CUSTOM_WALLPAPER_MAX_BYTES) throw new Error('TOO_LARGE')
  await withWallpaperStore<IDBValidKey>('readwrite', (store) => store.put(file, CUSTOM_KEY))
}

export async function clearCustomWallpaper(): Promise<void> {
  await withWallpaperStore<undefined>('readwrite', (store) => store.delete(CUSTOM_KEY))
}
