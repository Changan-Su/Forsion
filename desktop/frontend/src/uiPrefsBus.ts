/**
 * 界面偏好的跨窗广播(发方一侧)。**叶子模块:只依赖 types.ts 的键名常量** —— 那几个 setter 所在的
 * 模块(uiFont / uiZoom / smoothCaret / i18n)都要 import 它,它不能反过来 import 它们。
 *
 * 为什么挂在 setter 里而不是各个 UI 调用点:字体/缩放/语言/光标都有多个入口(设置页、引导页、
 * ⌘K 命令、agent 命令),挂调用点必漏。收方重放时走 `withReplay` 静音,故不会来回弹。
 */
import { FONT_UI_KEY, FONT_BODY_KEY, FONT_MONO_KEY, SMOOTH_CARET_KEY, UI_ZOOM_KEY, LOCALE_KEY } from './types'

/** 会跨窗同步的偏好键(固定那批)。主题可调参数 `theme.<id>.--<var>` 是动态键,见 collectPrefs。 */
export const UI_PREF_KEYS = [FONT_UI_KEY, FONT_BODY_KEY, FONT_MONO_KEY, SMOOTH_CARET_KEY, UI_ZOOM_KEY, LOCALE_KEY] as const

const THEME_KNOB = /^theme\.[A-Za-z0-9._-]{1,64}\.--[a-z0-9-]{1,64}$/i

let replaying = false

/** 收方重放期间静音:重放要走和用户动作同一批 setter,不静音就会把刚收到的值再吼回去。 */
export function withReplay(fn: () => void): void {
  replaying = true
  try { fn() } finally { replaying = false }
}

const read = (k: string): string | null => {
  try { return localStorage.getItem(k) } catch { return null }
}

/** 当前这批偏好的快照(null = 未设 = 收方也要删键回默认)。 */
export function collectPrefs(): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const k of UI_PREF_KEYS) out[k] = read(k)
  // 主题自曝的可调参数:只带**当前设计语言**那一份(其余主题的值收方用不上,也免得撑爆载荷上限)。
  try {
    const current = document.documentElement.dataset.theme || ''
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && THEME_KNOB.test(k) && k.startsWith(`theme.${current}.`)) out[k] = read(k)
    }
  } catch { /* private mode */ }
  return out
}

/** 吼给其余窗口。web/移动无 host → 天然 no-op;重放期间静音。 */
export function broadcastPrefs(): void {
  if (replaying) return
  try { window.tangu?.broadcastUi?.({ prefs: collectPrefs() }) } catch { /* 无 preload */ }
}
