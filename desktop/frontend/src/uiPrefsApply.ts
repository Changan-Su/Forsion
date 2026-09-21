/**
 * 界面偏好的跨窗重放(收方一侧)。与 uiPrefsBus 分成两个文件是为了**不成环**:
 * 那几个 setter 模块 import 的是叶子 uiPrefsBus,而本文件 import 它们。
 *
 * 纪律:先把值写进本窗的 localStorage,再调各自的 applier —— 那些 applier 自己读 localStorage,
 * 靠 IPC 先到还是 Chromium 的跨进程 storage 同步先到是没谱的(见 shared/uiSync.ts 的告诫)。
 */
import { FONT_UI_KEY, FONT_BODY_KEY, FONT_MONO_KEY, SMOOTH_CARET_KEY, UI_ZOOM_KEY, LOCALE_KEY } from './types'
import { applyUiFonts } from './uiFont'
import { applyStoredUiZoom } from './uiZoom'
import { setSmoothCaretEnabled } from './smoothCaret'
import { setLocaleGlobal } from './i18n'
import { applyThemeSettings } from './theme/themeSettings'
import { getLanguage } from './theme/registry'
import { withReplay } from './uiPrefsBus'

const FONT_KEYS = new Set<string>([FONT_UI_KEY, FONT_BODY_KEY, FONT_MONO_KEY])
const FIXED = new Set<string>([...FONT_KEYS, SMOOTH_CARET_KEY, UI_ZOOM_KEY, LOCALE_KEY])
/** 主题自曝的可调参数(只有磁盘主题会声明);值最终进 CSS 变量,键必须收敛。 */
const THEME_KNOB = /^theme\.[A-Za-z0-9._-]{1,64}\.--[a-z0-9-]{1,64}$/i

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* private mode / 配额满 */ }
}

/** 重放别处改过的界面偏好。白名单之外的键一律忽略(载荷跨进程而来,插件也够得着这条缝)。 */
export function applyPrefs(prefs: Record<string, string | null> | undefined): void {
  if (!prefs || typeof prefs !== 'object') return
  withReplay(() => {
    const currentTheme = document.documentElement.dataset.theme || ''
    let fonts = false
    let knobs = false
    for (const [k, v] of Object.entries(prefs)) {
      if (v !== null && typeof v !== 'string') continue
      if (FIXED.has(k)) { write(k, v); if (FONT_KEYS.has(k)) fonts = true; continue }
      // ⚠ 只接**本窗当前设计语言**那一份:别的主题的键写进来既用不上,又是一条无人看管的写盘面。
      if (currentTheme && THEME_KNOB.test(k) && k.startsWith(`theme.${currentTheme}.`)) {
        write(k, v)
        knobs = true
      }
    }
    if (fonts) applyUiFonts()
    if (UI_ZOOM_KEY in prefs) applyStoredUiZoom()
    if (SMOOTH_CARET_KEY in prefs) setSmoothCaretEnabled(prefs[SMOOTH_CARET_KEY] === '1')
    const locale = prefs[LOCALE_KEY]
    if (locale === 'zh' || locale === 'en') setLocaleGlobal(locale)
    // 只覆盖写进来的那些键;发方把某个旋钮**重置**(删键)时本窗要到下次启动才跟上 —— 磁盘主题的
    // 旋钮是小众项,为它做「按主题整组对账」会在两窗当前主题不一致时误删用户调好的值,不值当。
    if (knobs) applyThemeSettings(getLanguage(currentTheme))
  })
}
