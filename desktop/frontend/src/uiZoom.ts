/**
 * 全端 UI 缩放:body CSS zoom + localStorage 持久化 + 命令面板三命令(放大/缩小/重置)。
 * 端默认由各入口传入 initUiZoom:desktop 1 / web 桌面浏览器 1.10 / 触屏窄屏(web+APK) 1.15
 * (与 singleColumn.css 的移动 zoom 段同判据同值;inline style 覆盖同属性的 CSS 值,不叠乘)。
 * 用户显式调过(localStorage 有值)则一律以用户值为准;重置=清值回端默认。
 */
import { addCommand, UI_ZOOM_EVENT } from '@lcl/engine'
import { useApp } from './stores/appStore'

const KEY = 'forsion_ui_zoom'
// 2.9.9 默认缩放回归:升级/重装可能保留旧 WebStorage,按发布批次只清一次历史值。
const DEFAULT_MIGRATION_KEY = 'forsion_ui_zoom_default_2_9_9'
const STEP = 0.1
const MIN = 0.5
const MAX = 2

let endpointDefault = 1

function stored(): number | null {
  try {
    const v = parseFloat(localStorage.getItem(KEY) || '')
    return Number.isFinite(v) && v >= MIN && v <= MAX ? v : null
  } catch {
    return null
  }
}

function apply(v: number): void {
  try {
    // v===1 清空 inline,让端级 CSS(如 mini-shell 局部 zoom)自然接管
    ;(document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = v === 1 ? '' : String(v)
    // 与 zoom 同步设 --uiz:引擎 .shell 用 calc(100vh/var(--uiz)) 反补偿,消除 zoom≠1 时的全屏壳溢出/留白
    // (CSS zoom 不缩 vh 的陷阱,已实证)。v===1 移除 → 回退 var 默认 1 = 原生 100vh。
    if (v === 1) document.documentElement.style.removeProperty('--uiz')
    else document.documentElement.style.setProperty('--uiz', String(v))
    // 改 zoom 不会触发 window.resize:视口锚定的 fixed 浮层(菜单/补全/工具栏)按旧 zoom 算的
    // left/top 会当场偏掉 → 发一个约定事件让它们重算。见 lcl/engine/menuAnchor.tsx。
    window.dispatchEvent(new Event(UI_ZOOM_EVENT))
  } catch {
    /* ignore */
  }
}

export function getUiZoom(): number {
  return stored() ?? endpointDefault
}

export function setUiZoom(v: number): void {
  const clamped = Math.round(Math.min(MAX, Math.max(MIN, v)) * 100) / 100
  try {
    localStorage.setItem(KEY, String(clamped))
  } catch {
    /* ignore */
  }
  apply(clamped)
}

export function bumpUiZoom(delta: number): void {
  setUiZoom(getUiZoom() + delta)
}

export function resetUiZoom(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  apply(endpointDefault)
}

/** 首次进入本发布批次时回到端默认；迁移后用户再调的比例继续正常持久化。 */
export function migrateUiZoomDefault(): boolean {
  try {
    if (localStorage.getItem(DEFAULT_MIGRATION_KEY) === '1') return false
    localStorage.removeItem(KEY)
    localStorage.setItem(DEFAULT_MIGRATION_KEY, '1')
    return true
  } catch {
    return false
  }
}

/** 入口调用:应用持久化值(无则端默认),并注册命令面板命令。 */
export function initUiZoom(defaultZoom = 1): void {
  endpointDefault = defaultZoom
  migrateUiZoomDefault()
  apply(getUiZoom())
  const tr = (k: string): string => useApp.getState().tr(k)
  // 等效 Ctrl/⌘+±。hotkey 只在 Electron 绑(web 浏览器让原生 Ctrl+± 管浏览器缩放,不抢)。
  const isElectron = typeof window !== 'undefined' && !!(window as { tangu?: unknown }).tangu
  addCommand({
    id: 'ui-zoom-in',
    title: () => tr('command.zoomIn'),
    keywords: 'zoom in bigger 放大 缩放',
    ...(isElectron ? { hotkey: 'mod+=' } : {}),
    run: () => bumpUiZoom(STEP),
  })
  addCommand({
    id: 'ui-zoom-out',
    title: () => tr('command.zoomOut'),
    keywords: 'zoom out smaller 缩小 缩放',
    ...(isElectron ? { hotkey: 'mod+-' } : {}),
    run: () => bumpUiZoom(-STEP),
  })
  addCommand({
    id: 'ui-zoom-reset',
    title: () => tr('command.zoomReset'),
    keywords: 'zoom reset 重置 缩放 默认',
    ...(isElectron ? { hotkey: 'mod+0' } : {}),
    run: () => resetUiZoom(),
  })
}
