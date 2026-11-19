/** ctx.ui.capture / ctx.ui.record 的渲染层半边(2026-11-19,演示插件第二期的底座)。
 *
 *  归属:只认 pluginSurfaces 登记册(宿主交给插件的视图 / 浮层 / 对话框 / popover 容器),别的一律 `not-owned`。
 *  可见:capturePage 只抓屏上像素,所以元素必须整块在屏上 —— 视口之外、被滚动容器或面板边裁掉、被别人的东西盖住,都拒
 *  (`clipped` / `covered`),不截半张、不把邻居面板带进来。
 *  出图:主进程 `ui:captureRegion` 回 PNG(原生密度,只降不升)。
 *  录屏:逐帧要 BGRA 位图 → VideoFrame → 画进离屏 canvas → canvas.captureStream + MediaRecorder(MP4/H.264 优先)。
 *  不走 getDisplayMedia / desktopCapturer:那条要系统屏幕录制权限(台架机实测 denied),还会和插件屏幕共享的一次性预选抢槽。 */
import { RECORD_MAX, recordBitrate, recordSize, type CaptureRect, type CaptureRegionReply, type CaptureRegionRequest } from '../../../../shared/pluginCapture'
import { composedContains, composedParent, pluginSurfaceOwner } from './pluginSurfaces'
import type { PluginCaptureErrorCode, PluginCaptureOptions, PluginCaptureResult, PluginVideoOptions, PluginVideoResult, PluginVideoRecording } from './types'

const MESSAGES: Record<PluginCaptureErrorCode, string> = {
  'not-owned': 'the element is not inside a view, float, dialog or popover of this plugin',
  detached: 'the element is not in this window\'s document',
  empty: 'the element has no size',
  clipped: 'part of the element is not on screen (scrolled out, cut by a panel edge, or larger than the window)',
  covered: 'something that does not belong to this plugin lies on top of the element',
  'window-hidden': 'the window is minimized or hidden',
  busy: 'this window is already recording',
  unsupported: 'this video format cannot be recorded here',
  unavailable: 'capture needs the Forsion desktop app',
  disposed: 'the plugin was disabled or reloaded',
  failed: 'the screenshot failed',
}

export interface PluginCaptureError extends Error { code: PluginCaptureErrorCode }

export function captureError(code: PluginCaptureErrorCode): PluginCaptureError {
  const e = new Error(`${MESSAGES[code]} (${code})`) as PluginCaptureError
  e.name = 'PluginCaptureError'
  e.code = code
  return e
}

type Bridge = (req: CaptureRegionRequest) => Promise<CaptureRegionReply>

/** 桌面壳的出图桥;网页 / 手机 / 旧壳没有 → ctx.ui 上就不给这两个口。 */
export function captureBridge(): Bridge | null {
  const t = typeof window !== 'undefined' ? window.tangu : undefined
  return typeof t?.captureRegion === 'function' ? (req) => t.captureRegion!(req) : null
}

interface Box { left: number; top: number; right: number; bottom: number }
const boxOf = (r: { left: number; top: number; right: number; bottom: number }): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
const intersect = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) })

/** 裁剪 `el` 的祖先(按包含块链近似):overflow 不是 visible、或 contain: paint 的那些。
 *  fixed 元素跳过祖先直到为 fixed 建包含块的那层(transform / filter / perspective / contain / will-change),
 *  absolute 跳到最近的定位祖先 —— 否则窗口级浮层会被它 DOM 上路过的滚动容器误判成「裁掉了」。 */
function clippingAncestors(el: Element): Element[] {
  const out: Element[] = []
  let pos = getComputedStyle(el).position
  for (let n = composedParent(el); n && n !== document.documentElement; n = composedParent(n)) {
    const cs = getComputedStyle(n)
    const set = (v: string | undefined): boolean => !!v && v !== 'none' // 空串(没实现的引擎)按 none 算
    const fixedBlock = set(cs.transform) || set(cs.perspective) || set(cs.filter)
      || /paint|layout|strict|content/.test(cs.contain || '') || /transform|perspective|filter/.test(cs.willChange || '')
    const block = pos === 'fixed' ? fixedBlock : pos === 'absolute' ? cs.position !== 'static' || fixedBlock : true
    if (!block) continue
    const clips = (v: string | undefined): boolean => !!v && v !== 'visible'
    if (clips(cs.overflowX) || clips(cs.overflowY) || clips(cs.overflow) || /paint|strict|content/.test(cs.contain || '')) out.push(n)
    pos = cs.position
  }
  return out
}

/** 元素此刻在屏上露出来的那块(视口 ∩ 各裁剪祖先);一点都不露 = null。 */
export function visibleBox(el: Element, rect: Box = boxOf(el.getBoundingClientRect())): Box | null {
  let box = intersect(rect, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight })
  for (const a of clippingAncestors(el)) box = intersect(box, boxOf(a.getBoundingClientRect()))
  return box.right - box.left >= 1 && box.bottom - box.top >= 1 ? box : null
}

/** 露出来的那块是不是整块(各边容差 1px:小数坐标 + 边框)。 */
const whole = (rect: Box, vis: Box | null): boolean => !!vis
  && vis.left - rect.left <= 1 && vis.top - rect.top <= 1 && rect.right - vis.right <= 1 && rect.bottom - vis.bottom <= 1

/** 盖在上面的是别人的东西?在露出那块里取 4×4 个点做命中测试:命中的必须是元素自己 / 它的后代 / 它的祖先
 *  (= 点上什么都没盖)/ 同一个插件的别的表面(自己的浮层、对话框)。pointer-events: none 的遮挡物命中测试看不见 —— 已知限度。 */
export function coveredBy(el: Element, vis: Box, pluginId: string): Element | null {
  const n = 4
  const w = vis.right - vis.left, h = vis.bottom - vis.top
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = vis.left + (w * (i + 0.5)) / n, y = vis.top + (h * (j + 0.5)) / n
      const hit = document.elementFromPoint(x, y)
      if (!hit) continue
      if (composedContains(el, hit) || composedContains(hit, el) || pluginSurfaceOwner(hit) === pluginId) continue
      return hit
    }
  }
  return null
}

/** 能不能截:归属 → 在文档里 → 窗口没藏 → 有尺寸 → 整块在屏上 → 没被盖住。过了返回视口矩形(CSS px)。 */
export function checkCaptureTarget(el: Element, pluginId: string, opts: { occlusion?: boolean } = {}): CaptureRect {
  if (!el.isConnected || el.ownerDocument !== document) throw captureError('detached')
  if (pluginSurfaceOwner(el) !== pluginId) throw captureError('not-owned')
  if (document.visibilityState === 'hidden') throw captureError('window-hidden')
  const r = boxOf(el.getBoundingClientRect())
  if (r.right - r.left < 1 || r.bottom - r.top < 1) throw captureError('empty')
  const vis = visibleBox(el, r)
  if (!whole(r, vis)) throw captureError('clipped')
  if (opts.occlusion !== false && coveredBy(el, vis!, pluginId)) throw captureError('covered')
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
}

/** 等两帧:插件刚改的 DOM 画上屏再抓。rAF 在后台窗口里会停,超时兜底(不挂住)。 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 250)
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); resolve() }))
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(null) })
  })
}

const replyError = (reply: CaptureRegionReply | null): PluginCaptureError =>
  captureError(reply && !reply.ok && reply.code === 'window-hidden' ? 'window-hidden' : 'failed')

/** 参数形状错同步抛 TypeError(和 ctx.ui 别的口一致);归属 / 可见这些运行期条件走 reject。 */
export function checkCaptureArgs(el: unknown, opts: unknown, what: 'capture' | 'record'): void {
  if (!(el instanceof Element)) throw new TypeError(`ctx.ui.${what} needs an Element`)
  if (opts != null && typeof opts !== 'object') throw new TypeError(`ctx.ui.${what} options must be an object`)
  const o = (opts ?? {}) as Record<string, unknown>
  for (const k of ['scale', 'fps', 'maxSeconds', 'videoBitsPerSecond']) {
    if (o[k] !== undefined && !(typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) > 0)) throw new TypeError(`ctx.ui.${what} ${k} must be a positive number`)
  }
  if (o.mimeType !== undefined && typeof o.mimeType !== 'string') throw new TypeError(`ctx.ui.${what} mimeType must be a string`)
}

export async function capturePluginElement(pluginId: string, el: Element, opts: PluginCaptureOptions = {}, alive: () => boolean = () => true): Promise<PluginCaptureResult> {
  const bridge = captureBridge()
  if (!bridge) throw captureError('unavailable')
  checkCaptureTarget(el, pluginId) // 明显不行的先拒,不白等两帧
  await nextPaint()
  if (!alive()) throw captureError('disposed')
  const rect = checkCaptureTarget(el, pluginId)
  const reply = await withTimeout(bridge({ rect, format: 'png', ...(opts.scale ? { scale: opts.scale } : {}) }), 8000)
  if (!alive()) throw captureError('disposed')
  if (!reply || !reply.ok) throw replyError(reply)
  return { bytes: reply.data, mime: 'image/png', width: reply.width, height: reply.height, scale: Math.round((reply.width / rect.width) * 1000) / 1000 }
}

/** 缺省编码:MP4 / H.264 优先(公众号、剪映、QuickTime 都直接认),不行再 WebM。 */
export const RECORD_MIME_CANDIDATES = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'] as const

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 一扇窗同一时间只录一段(渲染层 = 一扇窗)。 */
let recordingActive = false

export async function recordPluginElement(
  pluginId: string,
  el: Element,
  opts: PluginVideoOptions = {},
  hooks: { alive(): boolean; own(cancel: () => void): { (): void; forget(): void } } = { alive: () => true, own: (c) => Object.assign(() => c(), { forget() {} }) },
): Promise<PluginVideoRecording> {
  const bridge = captureBridge()
  if (!bridge || typeof MediaRecorder === 'undefined' || typeof VideoFrame === 'undefined') throw captureError('unavailable')
  const mime = opts.mimeType ?? RECORD_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime || !MediaRecorder.isTypeSupported(mime)) throw captureError('unsupported')
  if (recordingActive) throw captureError('busy')
  const start = checkCaptureTarget(el, pluginId)
  const fps = clamp(Math.round(opts.fps ?? 30), 1, 60)
  const maxMs = clamp(opts.maxSeconds ?? 60, 1, 300) * 1000
  const density = Math.min(opts.scale ?? Infinity, window.devicePixelRatio || 1)
  const size = recordSize(start, density, RECORD_MAX)
  const canvas = document.createElement('canvas')
  canvas.width = size.width; canvas.height = size.height
  const g = canvas.getContext('2d', { alpha: false })
  if (!g) throw captureError('failed')
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.videoBitsPerSecond ?? recordBitrate(size, fps) })
  } catch {
    track.stop()
    throw captureError('unsupported')
  }
  recordingActive = true
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const stopped = new Promise<void>((r) => { recorder.onstop = () => r() })
  let phase: 'running' | 'finishing' | 'done' = 'running'
  let stoppedBy: PluginVideoResult['stoppedBy'] = 'stop'
  let frames = 0
  let startedAt = 0
  let wake: (() => void) | null = null
  let resolveDone!: (r: PluginVideoResult | null) => void
  const done = new Promise<PluginVideoResult | null>((r) => { resolveDone = r })
  const lockedW = start.width, lockedH = start.height

  /** 抓一帧画进 canvas;此刻抓不了(元素出屏、窗口藏了、主进程失败)= false,上一帧原样留着。 */
  const grab = async (): Promise<boolean> => {
    if (!el.isConnected) return false
    const r = el.getBoundingClientRect()
    const box = { left: r.left, top: r.top, right: r.left + lockedW, bottom: r.top + lockedH }
    if (document.visibilityState === 'hidden' || !whole(box, visibleBox(el, box))) return false
    const reply = await withTimeout(bridge({ rect: { x: r.left, y: r.top, width: lockedW, height: lockedH }, format: 'bgra' }), 3000)
    if (!reply || !reply.ok || phase !== 'running') return false
    const frame = new VideoFrame(reply.data as Uint8Array<ArrayBuffer>, { format: 'BGRA', codedWidth: reply.width, codedHeight: reply.height, timestamp: Math.round(performance.now() * 1000) })
    try { g.drawImage(frame, 0, 0, canvas.width, canvas.height) } finally { frame.close() }
    track.requestFrame()
    frames++
    return true
  }

  const finish = async (keep: boolean): Promise<void> => {
    if (phase !== 'running') return
    phase = 'finishing'
    wake?.()
    if (recorder.state !== 'inactive') recorder.stop()
    await stopped
    track.stop()
    phase = 'done'
    recordingActive = false
    own.forget()
    if (!keep || !frames) { resolveDone(null); return }
    const type = recorder.mimeType || mime
    const bytes = new Uint8Array(await new Blob(chunks, { type }).arrayBuffer())
    resolveDone({ bytes, mime: type, width: size.width, height: size.height, durationMs: Math.round(performance.now() - startedAt), frames, stoppedBy })
  }
  const own = hooks.own(() => { void finish(false) })

  try {
    recorder.start(1000) // 每秒交一块,长录不在编码器里攒成一整块
    startedAt = performance.now()
    // 第一帧进来才算开始(调用方据此开演);5 秒还没有 = 抓不到
    const first = Date.now() + 5000
    while (!(await grab())) {
      if (!hooks.alive()) throw captureError('disposed')
      if (Date.now() > first || !el.isConnected) throw captureError(document.visibilityState === 'hidden' ? 'window-hidden' : 'failed')
      await new Promise((r) => setTimeout(r, 100))
    }
  } catch (e) {
    await finish(false)
    throw e
  }

  void (async () => {
    const interval = 1000 / fps
    let next = performance.now() + interval
    while (phase === 'running') {
      const now = performance.now()
      if (now - startedAt >= maxMs) { stoppedBy = 'maxSeconds'; break }
      if (!el.isConnected) { stoppedBy = 'detached'; break }
      if (next > now) await new Promise<void>((r) => { wake = r; setTimeout(r, next - now) })
      wake = null
      if (phase !== 'running') return
      next = Math.max(next + interval, performance.now()) // 慢机器跟不上就丢帧,不追
      if (!hooks.alive()) { await finish(false); return } // 停用通常已经经 own 收掉;这里兜一道,不留半截录制占着 busy
      await grab()
    }
    await finish(true)
  })()

  return {
    mime,
    width: size.width,
    height: size.height,
    stop: () => { void finish(true); return done },
    cancel: () => { void finish(false) },
    done,
  }
}
