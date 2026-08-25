/** 画布交互偏好只影响本机视口，不属于笔记内容，也不应写进 frontmatter。 */
export const CANVAS_DOUBLE_CLICK_FOCUS_KEY = 'amadeus.canvas.doubleClickFocus'
export const CANVAS_MINIMAP_KEY = 'amadeus.canvas.minimap'
export const CANVAS_GRID_SNAP_KEY = 'amadeus.canvas.gridSnap'

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
