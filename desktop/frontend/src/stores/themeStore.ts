/**
 * 主题 store(双轴:语言 lovable|<磁盘主题> × 配色 cream/coral/teal/lavender/custom × 明暗 + glass/flat)。
 * 包 theme/loader.applyTheme(已 FOUC 安全 + 自持久化)。Shell 据 mode/lang 派生 dark/soft。
 * glass/flat 只是 documentElement 上的 data 属性(+localStorage),对齐 App.tsx 的 onGlassChange/onFlatChange。
 * 磁盘主题(~/.tangu/themes)经 initThemes/reloadThemes 异步合并进 registry,themesVersion 触发 UI 重渲染。
 */
import { create } from 'zustand'
import { track } from '../achievements/store'
import { applyTheme, removeInjectedThemeStyles } from '../theme/loader'
import {
  resolveInitialLang, resolveInitialSkin, resolveInitialMode, listSkins, listLanguages,
  hasLanguage, mergeDiskThemes, clearDiskThemes, DEFAULT_SEED, DEFAULT_LANG,
} from '../theme/registry'

type Mode = 'light' | 'dark'
const SKIN_IDS: string[] = listSkins().map((s) => s.id)

/** 明暗切换走 View Transition(整页交叉淡入,连 logo 明暗也一起淡);不支持/reduced-motion 时直接执行。 */
function withModeTransition(fn: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  const reduce = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } })()
  if (typeof doc.startViewTransition === 'function' && !reduce) doc.startViewTransition(fn)
  else fn()
}

interface ThemeState {
  lang: string
  skin: string
  mode: Mode
  seed: string
  glass: boolean
  flat: boolean
  /** 磁盘主题合并/重载后自增,驱动设置面板/引导/Shell 重渲染。 */
  themesVersion: number
  setLang(lang: string): void
  setSkin(skin: string): void
  setMode(mode: Mode): void
  setTheme(lang: string, skin: string, mode: Mode): void
  setSeed(seed: string): void
  setSeedValue(seed: string): void
  setGlass(on: boolean): void
  setFlat(on: boolean): void
  toggleMode(): void
  cycleSkin(): void
  cycleLang(): void
  /** 启动后合并磁盘主题;persistedLang=首屏被 FOUC 回退前的原始持久化语言(承接磁盘语言)。 */
  initThemes(persistedLang?: string | null): Promise<void>
  /** 用户拖入/编辑主题后重扫并重应用。 */
  reloadThemes(): Promise<void>
}

function readSeed(): string {
  try { return localStorage.getItem('forsion_theme_seed') || DEFAULT_SEED } catch { return DEFAULT_SEED }
}
function readGlass(): boolean {
  try { return localStorage.getItem('forsion_glass') !== 'off' } catch { return true }
}
function readFlat(): boolean {
  try { return localStorage.getItem('forsion_theme_flat') === '1' } catch { return false }
}

/** 读 ~/.tangu/themes(无 preload/出错 → 空,渲染端纯 bundle 运行)。 */
async function fetchDiskThemes(): Promise<Array<{ id: string; manifest: Record<string, unknown>; css: string }>> {
  try { return (await window.tangu?.listThemes?.()) ?? [] } catch { return [] }
}

export const useTheme = create<ThemeState>((set, get) => {
  const apply = (lang: string, skin: string, mode: Mode, seed: string): void => {
    applyTheme(lang, skin, mode, { customColor: skin === 'custom' ? seed : undefined })
    set({ lang, skin, mode, seed })
  }
  return {
    lang: resolveInitialLang(),
    skin: resolveInitialSkin(),
    mode: resolveInitialMode(),
    seed: readSeed(),
    glass: readGlass(),
    flat: readFlat(),
    themesVersion: 0,
    setLang: (lang) => apply(lang, get().skin, get().mode, get().seed),
    // 成就打点只在用户显式换主题/配色的动作里(setTheme/setSkin);严禁挪进 apply——启动初始化也走 apply 会误计。
    setSkin: (skin) => { track('theme.change'); apply(get().lang, skin, get().mode, get().seed) },
    setMode: (mode) => withModeTransition(() => apply(get().lang, get().skin, mode, get().seed)),
    setTheme: (lang, skin, mode) => { track('theme.change'); apply(lang, skin, mode, get().seed) },
    setSeed: (seed) => apply(get().lang, 'custom', get().mode, seed),
    // 只更新 seed 值 + 持久化(若当前是 custom 则即时重应用);不强行切到 custom——对齐 App.tsx onSeedChange。
    setSeedValue: (seed) => {
      try { localStorage.setItem('forsion_theme_seed', seed) } catch { /* ignore */ }
      set({ seed })
      if (get().skin === 'custom') applyTheme(get().lang, 'custom', get().mode, { customColor: seed })
    },
    setGlass: (on) => {
      try { document.documentElement.dataset.glass = on ? 'on' : 'off' } catch { /* ignore */ }
      try { localStorage.setItem('forsion_glass', on ? 'on' : 'off') } catch { /* ignore */ }
      set({ glass: on })
    },
    setFlat: (on) => {
      try { document.documentElement.dataset.flat = on ? '1' : '0' } catch { /* ignore */ }
      try { localStorage.setItem('forsion_theme_flat', on ? '1' : '0') } catch { /* ignore */ }
      set({ flat: on })
    },
    toggleMode: () => get().setMode(get().mode === 'dark' ? 'light' : 'dark'),
    cycleSkin: () => {
      const i = SKIN_IDS.indexOf(get().skin)
      get().setSkin(SKIN_IDS[(i + 1) % SKIN_IDS.length])
    },
    cycleLang: () => {
      const langs = listLanguages().map((e) => e.manifest.id)
      if (!langs.length) return
      const i = langs.indexOf(get().lang)
      get().setLang(langs[(i + 1) % langs.length])
    },
    initThemes: async (persistedLang) => {
      const list = await fetchDiskThemes()
      if (list.length) mergeDiskThemes(list)
      // 承接首屏:持久化语言若是刚合并的磁盘主题(首屏被回退到 lovable),现重应用其结构。
      const want = persistedLang && hasLanguage(persistedLang) ? persistedLang : null
      if (want && want !== get().lang) {
        applyTheme(want, get().skin, get().mode, { customColor: get().skin === 'custom' ? get().seed : undefined })
        set({ lang: want })
      }
      set({ themesVersion: get().themesVersion + 1 })
    },
    reloadThemes: async () => {
      clearDiskThemes()
      removeInjectedThemeStyles() // 清掉旧注入,让编辑过的 CSS 能重建
      const list = await fetchDiskThemes()
      if (list.length) mergeDiskThemes(list)
      const target = hasLanguage(get().lang) ? get().lang : DEFAULT_LANG // 当前语言被删 → 回退默认
      applyTheme(target, get().skin, get().mode, { customColor: get().skin === 'custom' ? get().seed : undefined })
      set({ lang: target, themesVersion: get().themesVersion + 1 })
    },
  }
})
