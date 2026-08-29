/** 画布交互内核 —— Amadeus 画布与仪表盘共用(View 基座方案 §6.4)。PM 相关的东西不进这里。 */
export * from './geometry'
export * from './viewport'
export * from './gestures'
export { CanvasMiniMap, MINI_W, MINI_H, MINI_PAD, type MiniItem } from './MiniMap'
export { CanvasChrome } from './Chrome'
export { resolveCardRepulsion, CARD_CLEARANCE } from '../canvasGeometry'
