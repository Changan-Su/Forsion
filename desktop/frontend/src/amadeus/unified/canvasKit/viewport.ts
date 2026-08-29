/**
 * 画布视口内核(View 基座方案 §6.4 S2)——平移 / 缩放 / 记忆,两边共用一份。
 *
 * 关键约定,别各写一份:
 *  · 视口是 `{x, y, z}`,舞台变换恒 `translate(x, y) scale(z)`,`transform-origin: 0 0`。
 *  · 缩放锚 = **指针底下那个舞台点保持不动**;推导 `x' = cx - (cx - x) * z'/z`。
 *  · 屏幕→舞台一律先 ÷ 应用级 CSS zoom(`zoomOf`)再 ÷ z(08-23:body 端级 zoom × fixed 覆盖层
 *    那口坑;少除一次,缩放后所有拖拽都偏)。
 *  · 视口**不落盘**(AFFiNE 同款),只按 key 记在会话级 Map 里 —— 落 fm 会让每次平移都写盘。
 */
import { useCallback, useRef, useState } from 'react'
import { zoomOf } from '@lcl/engine'
import { GRID_STEP, MAX_Z, MIN_Z, unionBox, type Box } from './geometry'

export interface Viewport { x: number; y: number; z: number }
export type ViewportConstraint = (next: Viewport, host: HTMLElement | null) => Viewport

/** Chromium 把触控板双指捏合作为 `ctrlKey + wheel` 送达(原始 delta 很细,按实测放大);
 *  macOS 的 Cmd+滚轮是 `metaKey + wheel`,保持 1× 不动手感。 */
const TRACKPAD_PINCH_ZOOM_GAIN = 2

/** 会话级视口记忆(进程内,按 key)。key 通常是文件路径。 */
const viewports = new Map<string, Viewport>()
export const rememberViewport = (key: string, vp: Viewport): void => { if (key) viewports.set(key, vp) }
export const recallViewport = (key: string): Viewport | undefined => viewports.get(key)

export const clampZ = (z: number): number => Math.max(MIN_Z, Math.min(MAX_Z, z))

/** 以 `cx,cy`(宿主局部坐标,已除过页面 zoom)为锚缩放到 nz。 */
export function zoomAt(vp: Viewport, nz: number, cx: number, cy: number): Viewport {
  const z = clampZ(nz)
  return { z, x: cx - ((cx - vp.x) * z) / vp.z, y: cy - ((cy - vp.y) * z) / vp.z }
}

/** 宿主局部尺寸(已除过应用级 CSS zoom)。host 不在就给 0。 */
export function hostSize(host: HTMLElement | null): { w: number; h: number; u: number } {
  if (!host) return { w: 0, h: 0, u: 1 }
  const u = zoomOf(host) || 1
  const r = host.getBoundingClientRect()
  return { w: r.width / u, h: r.height / u, u }
}

/** 把一组盒子装进视口(留 pad 边距)。空集不动。 */
export function fitViewport(host: HTMLElement | null, boxes: readonly Box[], pad = 48): Viewport | null {
  const world = unionBox(boxes)
  const { w, h } = hostSize(host)
  if (!world || w <= 0 || h <= 0) return null
  const z = clampZ(Math.min((w - pad * 2) / world.w, (h - pad * 2) / world.h, 1))
  return { z, x: (w - world.w * z) / 2 - world.x * z, y: (h - world.h * z) / 2 - world.y * z }
}

/**
 * 点阵背景层的样式(与画布同一份)。
 *
 * 点阵是**画布内容的一部分,不是舞台窗口的壁纸** —— 它得跟着平移缩放走。做法:合成层只比视口多铺
 * 一格,位移取视口平移在当前格距里的相位(`phase(x, step)` 与 `x + n·step` 是同一组点),不必造一个
 * 超大元素。配套 CSS 是 `.amx-stage-grid`(styles.css,scope = `.am-app`)。
 */
export function gridLayerStyle(vp: Viewport, step = GRID_STEP): React.CSSProperties {
  const s = step * vp.z
  const phase = (v: number): number => ((v % s) + s) % s
  return {
    ['--amx-grid-step' as string]: `${s}px`,
    transform: `translate3d(${phase(vp.x)}px, ${phase(vp.y)}px, 0)`,
  } as React.CSSProperties
}

export interface CanvasViewportApi {
  vp: Viewport
  /** 现读(手势 effect 只依赖 [active] 时闭包会陈旧 —— 一律走 ref)。 */
  vpRef: React.MutableRefObject<Viewport>
  setVp: (next: Viewport) => void
  /** 屏幕坐标 → 舞台坐标。 */
  toStage: (clientX: number, clientY: number) => { x: number; y: number }
  /** 屏幕位移 → 舞台位移(÷ 页面 zoom ÷ z)。 */
  toStageDelta: (dx: number, dy: number) => { dx: number; dy: number }
  /** 挂给宿主元素的原生 wheel 监听(passive:false 才 preventDefault 得掉页面缩放/回弹)。 */
  bindWheel: (host: HTMLElement | null) => () => void
  /** 保持缩放,把某个舞台点移到视口中心(缩略图导航)。 */
  centerOn: (worldX: number, worldY: number) => void
  /** 把一组盒子装进视口。 */
  fitTo: (boxes: readonly Box[], pad?: number) => void
  reset: () => void
}

/**
 * @param hostRef 舞台宿主(量尺寸与页面 zoom 都靠它)
 * @param memoKey 视口记忆键(空串 = 不记忆)
 * @param onInteract 用户主动改视口时的回调(画布用它掐掉聚焦动画)
 */
export function useCanvasViewport(
  hostRef: React.RefObject<HTMLElement | null>,
  memoKey = '',
  onInteract?: () => void,
  /** 没有记忆时的起始视口。给一点偏移可以让贴在原点的内容不顶着窗口边(默认 0,0,1)。 */
  initial: Viewport = { x: 0, y: 0, z: 1 },
  /** 有限画布可在统一写入口约束相机；不传时仍是普通无限 Canvas。 */
  constrain?: ViewportConstraint,
): CanvasViewportApi {
  const [vp, setVpState] = useState<Viewport>(() => (memoKey && viewports.get(memoKey)) || initial)
  const vpRef = useRef(vp)
  vpRef.current = vp
  const keyRef = useRef(memoKey)
  keyRef.current = memoKey
  const interactRef = useRef(onInteract)
  interactRef.current = onInteract
  const constrainRef = useRef(constrain)
  constrainRef.current = constrain

  const setVp = useCallback((next: Viewport): void => {
    const bounded = constrainRef.current?.(next, hostRef.current) ?? next
    vpRef.current = bounded
    if (keyRef.current) viewports.set(keyRef.current, bounded)
    setVpState(bounded)
  }, [hostRef])

  const toStage = useCallback((clientX: number, clientY: number) => {
    const host = hostRef.current
    const u = zoomOf(host ?? undefined) || 1
    const r = host?.getBoundingClientRect()
    const { x, y, z } = vpRef.current
    const px = ((clientX - (r?.left ?? 0)) / u - x) / z
    const py = ((clientY - (r?.top ?? 0)) / u - y) / z
    return { x: px, y: py }
  }, [hostRef])

  const toStageDelta = useCallback((dx: number, dy: number) => {
    const u = zoomOf(hostRef.current ?? undefined) || 1
    const z = vpRef.current.z
    return { dx: dx / u / z, dy: dy / u / z }
  }, [hostRef])

  const bindWheel = useCallback((host: HTMLElement | null) => {
    if (!host) return () => {}
    const onWheel = (e: WheelEvent): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.amx-stage-minimap')) return
      interactRef.current?.()
      e.preventDefault()
      const cur = vpRef.current
      const u = zoomOf(host) || 1
      if (e.metaKey || e.ctrlKey) {
        const gain = e.ctrlKey && !e.metaKey ? TRACKPAD_PINCH_ZOOM_GAIN : 1
        const r = host.getBoundingClientRect()
        setVp(zoomAt(cur, cur.z * Math.exp((-e.deltaY * gain) / 300), (e.clientX - r.left) / u, (e.clientY - r.top) / u))
      } else {
        // Shift+滚轮 = 横向平移。mac 上浏览器多半已换好轴(deltaX 非 0)就直接用。
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey ? 0 : e.deltaY
        setVp({ z: cur.z, x: cur.x - dx / u, y: cur.y - dy / u })
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [setVp])

  const centerOn = useCallback((worldX: number, worldY: number): void => {
    interactRef.current?.()
    const { w, h } = hostSize(hostRef.current)
    if (!w || !h) return
    const z = vpRef.current.z
    setVp({ z, x: w / 2 - worldX * z, y: h / 2 - worldY * z })
  }, [hostRef, setVp])

  const fitTo = useCallback((boxes: readonly Box[], pad = 48): void => {
    const next = fitViewport(hostRef.current, boxes, pad)
    if (next) { interactRef.current?.(); setVp(next) }
  }, [hostRef, setVp])

  const initRef = useRef(initial)
  const reset = useCallback((): void => { interactRef.current?.(); setVp(initRef.current) }, [setVp])

  return { vp, vpRef, setVp, toStage, toStageDelta, bindWheel, centerOn, fitTo, reset }
}
