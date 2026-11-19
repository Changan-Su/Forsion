/** 插件出图 / 录屏(ctx.ui.capture / record,2026-11-19)主进程与渲染层共用的形状与纯函数。
 *  主进程走 webContents.capturePage(真实合成像素:webview / canvas / 宿主零件都抓得到,DOM 复刻抓不到),
 *  通道 `ui:captureRegion`;Agent Desk 那条 `ui:captureRect`(最长边压 1024、给模型省 token)不动。 */

export interface CaptureRect { x: number; y: number; width: number; height: number }

/** png = 单张出图;bgra = 录屏逐帧(原始位图,渲染层直接做 VideoFrame,不经编解码)。 */
export type CaptureRegionFormat = 'png' | 'bgra'

export interface CaptureRegionRequest {
  /** 视口坐标(CSS px,= getBoundingClientRect);主进程按 webContents 缩放换成 DIP。 */
  rect: CaptureRect
  format: CaptureRegionFormat
  /** png 才用:每 CSS px 最多几个像素;高于屏幕原生密度时按原生(不放大造像素)。缺省 = 原生。 */
  scale?: number
}

export type CaptureRegionReply =
  | { ok: true; data: Uint8Array; width: number; height: number }
  | { ok: false; code: 'window-hidden' | 'failed' | 'untrusted' | 'bad-request' }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** IPC 入参清洗:形状不对 = null(主进程回 bad-request)。 */
export function sanitizeCaptureRequest(raw: unknown): CaptureRegionRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const r = o.rect as Record<string, unknown> | undefined
  if (!r || typeof r !== 'object') return null
  const x = num(r.x), y = num(r.y), width = num(r.width), height = num(r.height)
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null
  if (o.format !== 'png' && o.format !== 'bgra') return null
  const scale = o.scale === undefined ? undefined : num(o.scale)
  if (scale === null || (scale !== undefined && scale <= 0)) return null
  return { rect: { x, y, width, height }, format: o.format, ...(scale !== undefined ? { scale } : {}) }
}

/** 视口 CSS px → capturePage 的 DIP 矩形(× webContents 缩放,四边各自取整,夹进内容区);夹完是空的 = null。
 *  四边各自 round 而不是 x/width 分开取整:元素落在小数坐标上时左右两边都只差半像素以内,不会多带一列邻居。 */
export function toDipRect(rect: CaptureRect, zoom: number, content: { width: number; height: number }): CaptureRect | null {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1
  const left = Math.max(0, Math.round(rect.x * z)), top = Math.max(0, Math.round(rect.y * z))
  const right = Math.min(content.width, Math.round((rect.x + rect.width) * z))
  const bottom = Math.min(content.height, Math.round((rect.y + rect.height) * z))
  return right - left >= 1 && bottom - top >= 1 ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

/** 单张出图的像素尺寸:要的密度 × CSS 尺寸,但不超过抓到的原生像素(只降不升)。 */
export function outputSize(native: { width: number; height: number }, css: { width: number; height: number }, scale?: number): { width: number; height: number } {
  if (!scale || !(scale > 0)) return native
  const w = Math.round(css.width * scale)
  if (w >= native.width) return native
  return { width: Math.max(1, w), height: Math.max(1, Math.round((native.height * w) / native.width)) }
}

/** 录屏画幅上限:4K 框(H.264 level 5.1 的帧尺寸以内),超了等比缩小。 */
export const RECORD_MAX = { width: 3840, height: 2160 } as const

/** 录屏画幅:CSS 尺寸 × 密度,等比塞进 4K 框,宽高取偶数(H.264 硬编码要偶数)。 */
export function recordSize(css: { width: number; height: number }, scale: number, max: { width: number; height: number } = RECORD_MAX): { width: number; height: number } {
  let w = css.width * scale, h = css.height * scale
  const k = Math.min(1, max.width / w, max.height / h)
  w *= k; h *= k
  const even = (v: number): number => Math.max(2, Math.floor(v / 2) * 2)
  return { width: even(w), height: even(h) }
}

/** 录屏缺省码率:按像素 × 帧率估,夹在 2–16 Mbps(界面画面,VBR;5 分钟上限下最坏几百 MB 在内存里)。 */
export function recordBitrate(size: { width: number; height: number }, fps: number): number {
  return Math.round(Math.min(16e6, Math.max(2e6, size.width * size.height * fps * 0.07)))
}
