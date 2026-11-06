/**
 * 动效主题(动效主题方案 A2,2026-11-06 用户定):内置四套 Genesis / 水滴 / 拉伸 / 平移,外加「只淡入淡出」。
 * 落在 <html data-motion-theme="…">(恒写,缺省 genesis)与 <html data-motion-fade="on">(开着才写)。
 *
 * 跟动效主题走的只有三处:按钮长出的面板(lcl/engine/panelMotion.ts openPanel)、分段胶囊的选中块、开关旋钮
 * (lcl/engine/segFlow.ts + base.css 按属性分派);手机 Dock 由原生外壳按 ChromeState.theme.motionTheme 自己画。
 * 菜单 / 提示 / 吐司 / 折叠不跟 —— 一天几百次,那是节奏不是风格;它们只受「只淡入淡出」与系统「减少动态效果」管。
 *
 * 同 calm.ts:纯本机渲染偏好,存 localStorage(forsion_motion_theme / forsion_motion_fade),不进后端、不跨设备;
 * 同机别的窗口经 storage 事件跟上。themeStore 在模块顶层 import 本文件一次(每个窗口、三端都加载,先于首次渲染)。
 * 设计语言 theme.json 的 motionTheme 只是建议:用户**从没选过**动效主题时才用;选过一次就一直是用户的(默认值不覆盖用户设过的值)。
 * Space 外观不改动效主题(切 Space 时面板换一种出法,读起来像 bug)。
 * 「只淡入淡出」:系统开了减少动态效果时视同打开(设置里灰掉);LCL 的 reducedMotion() 两者都认,
 * CSS 那半在 base.css 的 @layer forsion-guard,framer 那半是下面的 HostMotionConfig。
 * ⚠️ 插件与视图不读、不写这些键和属性;要跟主题走就用宿主的分段胶囊 / 开关 / openPanel。
 */
import React, { useSyncExternalStore } from 'react'
import { MotionConfig } from 'framer-motion'
import { MOTION_THEME_IDS, type MotionThemeId } from '@lcl/engine/panelMotion'

export { MOTION_THEME_IDS, type MotionThemeId }

const THEME_KEY = 'forsion_motion_theme'
const FADE_KEY = 'forsion_motion_fade'
const isId = (v: unknown): v is MotionThemeId => typeof v === 'string' && (MOTION_THEME_IDS as readonly string[]).includes(v)

/** 用户选过的那套;没选过 / 读不了 = null(读不了当「不知道」,只是先按建议 / 缺省画,不写回)。 */
const readChosen = (): MotionThemeId | null => {
  try { const v = localStorage.getItem(THEME_KEY); return isId(v) ? v : null } catch { return null }
}
const readFade = (): boolean => {
  try { return localStorage.getItem(FADE_KEY) === '1' } catch { return false }
}
const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null : null

// 本窗的当前值。存一份在内存里:写盘失败(隐私模式 / 配额满)时这次会话照样生效,设置里显示的也是真的。
let chosen = readChosen()
let suggested: MotionThemeId | null = null
let fade = readFade()
const listeners = new Set<() => void>()

/** 生效的那套:用户选的 → 设计语言建议的 → Genesis。 */
export const getMotionTheme = (): MotionThemeId => chosen ?? suggested ?? 'genesis'
/** 用户自己开的「只淡入淡出」(不含系统减少动态效果)。 */
export const isFadeOnlyChosen = (): boolean => fade
/** 系统开了减少动态效果:「只淡入淡出」视同打开、开关灰掉。 */
export const systemReducesMotion = (): boolean => !!mq?.matches

function apply(): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.dataset.motionTheme = getMotionTheme()
  if (fade) el.dataset.motionFade = 'on'
  else delete el.dataset.motionFade
  for (const f of listeners) f()
}

export function setMotionTheme(id: MotionThemeId): void {
  chosen = id
  try { localStorage.setItem(THEME_KEY, id) } catch { /* private mode */ }
  apply()
}

export function setFadeOnly(on: boolean): void {
  fade = on
  try { localStorage.setItem(FADE_KEY, on ? '1' : '0') } catch { /* private mode */ }
  apply()
}

/** themeStore 换设计语言、磁盘主题合进来后调:按全局设计语言的 manifest.motionTheme 更新建议值(不认识的名字当没写)。 */
export function suggestMotionTheme(v: unknown): void {
  const next = isId(v) ? v : null
  if (next === suggested) return
  suggested = next
  apply()
}

export function subscribeMotionTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

const snapshot = (): string => `${getMotionTheme()}|${fade ? 1 : 0}|${systemReducesMotion() ? 1 : 0}`
/** 设置页 / 根配置用:{ theme, fadeChosen, systemReduce }。 */
export function useMotionPrefs(): { theme: MotionThemeId; fadeChosen: boolean; systemReduce: boolean } {
  const s = useSyncExternalStore(subscribeMotionTheme, snapshot, snapshot)
  const [theme, f, sys] = s.split('|')
  return { theme: theme as MotionThemeId, fadeChosen: f === '1', systemReduce: sys === '1' }
}

/** 根上的 framer 配置:「只淡入淡出」开着时 framer 也只留透明度(always);否则跟系统(user)。main.tsx / mobileEntry.tsx 共用。 */
export function HostMotionConfig({ children }: { children: React.ReactNode }): React.ReactElement {
  const { fadeChosen } = useMotionPrefs()
  return <MotionConfig reducedMotion={fadeChosen ? 'always' : 'user'}>{children}</MotionConfig>
}

if (typeof document !== 'undefined') {
  apply()
  // 别的窗口改了(key 为 null = 那边 localStorage.clear()):以存储为准重读
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== THEME_KEY && e.key !== FADE_KEY) return
    chosen = readChosen()
    fade = readFade()
    apply()
  })
  mq?.addEventListener?.('change', () => { for (const f of listeners) f() })
}
