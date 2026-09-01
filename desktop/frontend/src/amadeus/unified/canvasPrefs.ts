/** 画布交互偏好只影响本机视口，不属于笔记内容，也不应写进 frontmatter。 */
import { MIN_Z } from './canvasKit/geometry'

export const CANVAS_DOUBLE_CLICK_FOCUS_KEY = 'amadeus.canvas.doubleClickFocus'
export const CANVAS_MINIMAP_KEY = 'amadeus.canvas.minimap'
export const CANVAS_GRID_SNAP_KEY = 'amadeus.canvas.gridSnap'
export const CANVAS_OVERVIEW_KEY = 'amadeus.canvas.overview'
export const CANVAS_OVERVIEW_Z_KEY = 'amadeus.canvas.overviewZ'
const CANVAS_OVERVIEW_Z_EVENT = 'amadeus:canvas-overview-z'

/** 默认开启；只把显式的 `0` 视为关闭，旧用户无需迁移。 */
export function canvasDoubleClickFocusEnabled(): boolean {
  try { return localStorage.getItem(CANVAS_DOUBLE_CLICK_FOCUS_KEY) !== '0' } catch { return true }
}

export function setCanvasDoubleClickFocusEnabled(on: boolean): void {
  try { localStorage.setItem(CANVAS_DOUBLE_CLICK_FOCUS_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

/** 缩略图默认开启；显式关闭才隐藏，保证升级用户仍看到原有画布总览。 */
export function canvasMiniMapEnabled(): boolean {
  try { return localStorage.getItem(CANVAS_MINIMAP_KEY) !== '0' } catch { return true }
}

export function setCanvasMiniMapEnabled(on: boolean): void {
  try { localStorage.setItem(CANVAS_MINIMAP_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

/** 点阵吸附默认开启；它只影响本机手势，不属于笔记内容。 */
export function canvasGridSnapEnabled(): boolean {
  try { return localStorage.getItem(CANVAS_GRID_SNAP_KEY) !== '0' } catch { return true }
}

export function setCanvasGridSnapEnabled(on: boolean): void {
  try { localStorage.setItem(CANVAS_GRID_SNAP_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

/** 低倍率简略显示默认开启；关闭后即使缩到阈值以下也继续渲染完整正文。 */
export function canvasOverviewEnabled(): boolean {
  try { return localStorage.getItem(CANVAS_OVERVIEW_KEY) !== '0' } catch { return true }
}

export function setCanvasOverviewEnabled(on: boolean): void {
  try { localStorage.setItem(CANVAS_OVERVIEW_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

/** 低倍率简略显示的**触发阈值**:缩放 ≤ 它才换成简略标题。
 *  缺省 = `MIN_Z`(25%,缩到底那一档) —— 原先是写死的 0.55,用户实测「还没缩多少正文就没了」。
 *  只认 [MIN_Z, 1] 内的数,越界/坏值一律回缺省(设置里存的是选单里的固定几档,不校验也不会错,
 *  但这个键是明文 localStorage,手改坏了不该让画布跟着坏)。 */
export function canvasOverviewZoom(): number {
  try {
    const n = Number(localStorage.getItem(CANVAS_OVERVIEW_Z_KEY))
    return Number.isFinite(n) && n >= MIN_Z && n <= 1 ? n : MIN_Z
  } catch { return MIN_Z }
}

export function setCanvasOverviewZoom(z: number): void {
  try { localStorage.setItem(CANVAS_OVERVIEW_Z_KEY, String(z)) } catch { /* ignore */ }
  // 设置页与画布在同一个窗口里,`storage` 事件只跨窗口发 —— 自己广播一枚,开着的画布当场跟上
  // (否则「改了设置没反应,得把笔记关了重开」)。
  try { window.dispatchEvent(new Event(CANVAS_OVERVIEW_Z_EVENT)) } catch { /* ignore */ }
}

/** 订阅阈值变化(画布舞台用);返回退订函数。 */
export function onCanvasOverviewZoomChange(fn: () => void): () => void {
  window.addEventListener(CANVAS_OVERVIEW_Z_EVENT, fn)
  return () => window.removeEventListener(CANVAS_OVERVIEW_Z_EVENT, fn)
}
