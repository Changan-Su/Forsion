/**
 * 主题 store(语言 lovable|<磁盘主题> × 主题色 × 背景色 × 明暗 + glass/flat;两根颜色轴共用
 * cream/coral/teal/lavender/zhi/custom 这张表,各取一半 token)。
 * 包 theme/loader.applyTheme(已 FOUC 安全 + 自持久化)。Shell 据 mode/lang 派生 dark/soft。
 * glass/flat 只是 documentElement 上的 data 属性(+localStorage),对齐 App.tsx 的 onGlassChange/onFlatChange。
 * 磁盘主题(~/.tangu/themes)经 initThemes/reloadThemes 异步合并进 registry,themesVersion 触发 UI 重渲染。
 */
import { create } from 'zustand'
import { track } from '../achievements/store'
import { applyTheme, removeInjectedThemeStyles, syncWindowMaterial } from '../theme/loader'
import {
  resolveInitialLang, resolveInitialSkin, resolveInitialBg, resolveInitialEffectiveMode, resolveInitialModePref, systemMode,
  forcedSchemeForLanguage, listSkins, listLanguages, hasLanguage, mergeDiskThemes, clearDiskThemes,
  DEFAULT_SEED, DEFAULT_LANG,
} from '../theme/registry'

type Mode = 'light' | 'dark'
type ModePref = 'light' | 'dark' | 'system'
const SKIN_IDS: string[] = listSkins().map((s) => s.id)

/** 主题锁定的 colorScheme(校验版,store 与设置面板共用同一判定)。 */
const langForcedScheme = forcedSchemeForLanguage

/** 持久化用户明暗偏好。**只在用户显式动作里调**(setModePref/setTheme)——启动/重载/换语言不写,
 * 否则新装机会把默认 light 写成「看似用户选过」,且多窗口初始化互相盖(codex Medium-1)。 */
function persistPref(pref: ModePref): void {
  try { localStorage.setItem('forsion_theme_pref', pref) } catch { /* private mode */ }
}

/** 明暗切换走 View Transition(整页交叉淡入,连 logo 明暗也一起淡);不支持/reduced-motion 时直接执行。 */
function withModeTransition(fn: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  const reduce = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } })()
  if (typeof doc.startViewTransition === 'function' && !reduce) doc.startViewTransition(fn)
  else fn()
}

interface ThemeState {
  lang: string
  /** 主题色(accent 轴) */
  skin: string
  /** 背景色(bg 轴);与 skin 同 id = 拆轴前的整套配色 */
  bg: string
  /** 落地明暗(偏好=system 时=系统当前值);Shell/组件消费这个,语义不变。 */
  mode: Mode
  /** 用户明暗偏好(可为 system);被主题 colorScheme 强制时=强制值。设置面板据此高亮。 */
  modePref: ModePref
  /** 当前语言是否锁定了明暗(colorScheme);锁定时明暗切换禁用。 */
  modeLocked: boolean
  seed: string
  /** custom 配色的独立背景色 seed(''=未设,背景跟随强调色微染——旧单色行为)。 */
  bgSeed: string
  glass: boolean
  flat: boolean
  /** 磁盘主题合并/重载后自增,驱动设置面板/引导/Shell 重渲染。 */
  themesVersion: number
  setLang(lang: string): void
  setSkin(skin: string): void
  setBg(bg: string): void
  /** 设明暗偏好(light|dark|system);主题锁定 colorScheme 时忽略。 */
  setModePref(pref: ModePref): void
  /** lang+skin+bg+偏好一次设定;末参是**偏好**(可 system),非落地明暗。 */
  setTheme(lang: string, skin: string, bg: string, pref: ModePref): void
  setSeed(seed: string): void
  setSeedValue(seed: string): void
  /** 设/清自定义背景色 seed(''=清除恢复跟随主题色);背景轴为 custom 时即时重应用。 */
  setBgSeedValue(bg: string): void
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
function readBgSeed(): string {
  try { return localStorage.getItem('forsion_theme_bg_seed') || '' } catch { return '' }
}
function readGlass(): boolean {
  try { return localStorage.getItem('forsion_glass') !== 'off' } catch { return true }
}
function readFlat(): boolean {
  // 默认扁平(2026-07-19 用户拍板):未显式设过 → on;存 '0'(用户关过)才 off。
  try { return localStorage.getItem('forsion_theme_flat') !== '0' } catch { return true }
}

/** 读 ~/.tangu/themes(无 preload/出错 → 空,渲染端纯 bundle 运行)。 */
async function fetchDiskThemes(): Promise<Array<{ id: string; manifest: Record<string, unknown>; css: string }>> {
  try { return (await window.tangu?.listThemes?.()) ?? [] } catch { return [] }
}

export const useTheme = create<ThemeState>((set, get) => {
  // 纯「应用视觉 + 派生状态」:userPref 原样保留在 state;主题锁定 colorScheme 则**落地明暗**取强制值。
  // 只写派生的 forced_scheme hint(给 index.html 首屏脚本防闪);**不写 forsion_theme_pref**——
  // 那是用户偏好,仅由 setModePref/setTheme 经 persistPref 写(见 Medium-1)。
  const apply = (lang: string, skin: string, bg: string, userPref: ModePref, seed: string): void => {
    const forced = langForcedScheme(lang)
    const eff = forced ?? userPref
    const mode: Mode = eff === 'system' ? systemMode() : eff
    applyTheme(lang, skin, bg, mode, { customColor: skin === 'custom' ? seed : undefined })
    try {
      if (forced) localStorage.setItem('forsion_theme_forced_scheme', forced)
      else localStorage.removeItem('forsion_theme_forced_scheme')
    } catch { /* private mode */ }
    set({ lang, skin, bg, mode, modePref: userPref, modeLocked: forced !== undefined, seed })
  }
  // 偏好=system(或被主题强制 system)时,跟随 OS 明暗实时切换。监听器只装一次(store 工厂只跑一次)。
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onSysChange = (): void => {
      const s = get()
      const eff = langForcedScheme(s.lang) ?? s.modePref
      if (eff !== 'system') return
      const next = systemMode()
      if (next === s.mode) return
      withModeTransition(() => {
        applyTheme(s.lang, s.skin, s.bg, next, { customColor: s.skin === 'custom' ? s.seed : undefined })
        set({ mode: next })
      })
    }
    if (mq.addEventListener) mq.addEventListener('change', onSysChange)
    else mq.addListener(onSysChange) // 老 WebKit 兜底
  } catch { /* 无 matchMedia:system 偏好退化为首屏解析后固定 */ }

  const initialLang = resolveInitialLang()
  return {
    lang: initialLang,
    skin: resolveInitialSkin(),
    bg: resolveInitialBg(),
    mode: resolveInitialEffectiveMode(), // 含 forced_scheme hint,与首屏一致(codex High-1)
    modePref: resolveInitialModePref(),  // 用户偏好(不含强制),换走锁定主题后恢复它
    modeLocked: langForcedScheme(initialLang) !== undefined,
    seed: readSeed(),
    bgSeed: readBgSeed(),
    glass: readGlass(),
    flat: readFlat(),
    themesVersion: 0,
    setLang: (lang) => apply(lang, get().skin, get().bg, get().modePref, get().seed),
    // 成就打点只在用户显式换主题/配色的动作里(setTheme/setSkin/setBg);严禁挪进 apply——启动初始化也走 apply 会误计。
    setSkin: (skin) => { track('theme.change'); apply(get().lang, skin, get().bg, get().modePref, get().seed) },
    setBg: (bg) => { track('theme.change'); apply(get().lang, get().skin, bg, get().modePref, get().seed) },
    // 主题锁定 colorScheme 时,用户改不动明暗(setModePref 忽略);过渡动画仅在真正切换时放。
    // 用户显式动作 → persistPref 写入偏好(apply 不写,见 Medium-1)。
    setModePref: (pref) => {
      if (langForcedScheme(get().lang)) return
      if (pref === get().modePref) return
      persistPref(pref)
      withModeTransition(() => apply(get().lang, get().skin, get().bg, pref, get().seed))
    },
    setTheme: (lang, skin, bg, pref) => { track('theme.change'); persistPref(pref); apply(lang, skin, bg, pref, get().seed) },
    setSeed: (seed) => apply(get().lang, 'custom', get().bg, get().modePref, seed),
    // 只更新 seed 值 + 持久化(若当前是 custom 则即时重应用);不强行切到 custom——对齐 App.tsx onSeedChange。
    setSeedValue: (seed) => {
      try { localStorage.setItem('forsion_theme_seed', seed) } catch { /* ignore */ }
      set({ seed })
      // 背景轴为 custom 且未单独设背景色时,背景「跟随主题色」—— 故换 seed 也要重跑背景一侧。
      if (get().skin === 'custom') applyTheme(get().lang, 'custom', get().bg, get().mode, { customColor: seed })
    },
    setBgSeedValue: (bg) => {
      set({ bgSeed: bg })
      // 持久化在 loader 内(customBg 空串=removeItem);背景轴非 custom 时也写盘,下次切到 custom 生效。
      if (get().bg === 'custom') applyTheme(get().lang, get().skin, 'custom', get().mode, { customBg: bg })
      else {
        try {
          if (bg) localStorage.setItem('forsion_theme_bg_seed', bg)
          else localStorage.removeItem('forsion_theme_bg_seed')
        } catch { /* ignore */ }
      }
    },
    setGlass: (on) => {
      try { document.documentElement.dataset.glass = on ? 'on' : 'off' } catch { /* ignore */ }
      try { localStorage.setItem('forsion_glass', on ? 'on' : 'off') } catch { /* ignore */ }
      syncWindowMaterial()
      set({ glass: on })
    },
    setFlat: (on) => {
      try { document.documentElement.dataset.flat = on ? '1' : '0' } catch { /* ignore */ }
      try { localStorage.setItem('forsion_theme_flat', on ? '1' : '0') } catch { /* ignore */ }
      set({ flat: on })
    },
    // 快捷明暗(ribbon/命令面板/插件):主题锁定时静默无效;否则翻到当前落地明暗的反面(显式覆盖 system)。
    toggleMode: () => { if (get().modeLocked) return; get().setModePref(get().mode === 'dark' ? 'light' : 'dark') },
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
      // 走 apply(而非裸 applyTheme):磁盘 manifest 此刻才可见,借它按 colorScheme 强制/解锁明暗
      //(如 genesis-glass 首屏还不知道要锁 system,合并后这里才补上——配合 forced_scheme 首屏 hint 防闪)。
      const want = persistedLang && hasLanguage(persistedLang) ? persistedLang : get().lang
      apply(want, get().skin, get().bg, get().modePref, get().seed)
      set({ themesVersion: get().themesVersion + 1 })
    },
    reloadThemes: async () => {
      clearDiskThemes()
      removeInjectedThemeStyles() // 清掉旧注入,让编辑过的 CSS 能重建
      const list = await fetchDiskThemes()
      if (list.length) mergeDiskThemes(list)
      const target = hasLanguage(get().lang) ? get().lang : DEFAULT_LANG // 当前语言被删 → 回退默认
      // 同样走 apply:用户编辑了 theme.json 的 colorScheme 后重载即生效。
      apply(target, get().skin, get().bg, get().modePref, get().seed)
      set({ themesVersion: get().themesVersion + 1 })
    },
  }
})
