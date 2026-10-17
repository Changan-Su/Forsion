/**
 * 看图(10-17,借鉴 Claude 第二轮 A2):点对话里的图,在当前窗口里铺开看。
 * - 范围 = 同一条对话流(.t2-stream-inner)里所有标了 data-viewable 的图,按出现顺序;「1 / N」。
 * - 底色是当前背景色 96%(跟主题、明暗走);主图约占 75% 宽,左右露出前后一张(40%),‹ › / ← → 切换。
 * - 滚轮 / 触控板捏合以指针为中心缩放;− + 每档 ×1.25;双击在适应窗口和 100% 之间切;≤105% 回到适应窗口;最多 800%。
 *   百分比按原图像素算(1 个图像像素 = 1 CSS px 为 100%)。放大后拖动平移;切图缩放复位。
 * - 从缩略图位置飞出来(220ms),关闭飞回;缩略图不在视口里就直接淡出。
 * - 手机:双指缩放、左右滑切换、往下拖关闭(跟手);顶栏只留名字、计数、关闭和「更多」;系统返回 = 关闭(pushMobileBack)。
 * 挂在 body 下自己的 React 根里:桌面 / 网页 / 手机三端同一份,不用进 Root / MobileRoot。
 * body 有 CSS zoom(用户界面缩放):量到的屏幕坐标一律除以 currentCSSZoom 再写进样式。
 * 方案页:docs/ToBeImproved/借鉴Claude设计系统方案_2026-10-17/round2.html §4 / §6
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Minus, MoreHorizontal, Plus, Scan, X } from 'lucide-react'
import { useNativeChromeClaim, useNativeChromeInstalled, type NativeChromeClaim } from '@lcl/engine'
import { registerMessages, translate as tr } from '../i18n'
import { saveResponseAs } from '../services/nativeDownload'
import { pushMobileBack } from '../amadeus/lib/mobileBack'
import { useApp } from '../stores/appStore'
import './imageViewer.css'

registerMessages({
  'viewer.open': { zh: '查看图片 {name}', en: 'View image {name}' },
  'viewer.prev': { zh: '上一张 (←)', en: 'Previous (←)' },
  'viewer.next': { zh: '下一张 (→)', en: 'Next (→)' },
  'viewer.zoomIn': { zh: '放大', en: 'Zoom in' },
  'viewer.zoomOut': { zh: '缩小', en: 'Zoom out' },
  'viewer.fit': { zh: '适应窗口', en: 'Fit to window' },
  'viewer.copy': { zh: '复制图片', en: 'Copy image' },
  'viewer.download': { zh: '下载', en: 'Download' },
  'viewer.close': { zh: '关闭 (Esc)', en: 'Close (Esc)' },
  'viewer.more': { zh: '更多', en: 'More' },
  'viewer.copied': { zh: '已复制图片', en: 'Image copied' },
  'viewer.copyFailed': { zh: '复制失败', en: 'Could not copy the image' },
  'viewer.downloadFailed': { zh: '下载失败', en: 'Could not download the image' },
  'viewer.hint': { zh: '← → 切换 · 滚轮缩放 · Esc 关闭', en: '← → to switch · scroll to zoom · Esc to close' },
  'viewer.hintZoomed': { zh: '拖动查看 · 滚轮缩放（以指针为中心） · 双击回到适应窗口', en: 'Drag to pan · scroll to zoom at the pointer · double-click to fit' },
  'viewer.openTab': { zh: '在标签页打开', en: 'Open in a tab' },
  'viewer.openFile': { zh: '打开文件', en: 'Open file' }, // 嵌入图:开着 Agent Desk 时进 Desk,手机 / 关了 Desk 走别处(openFileCitation 自己判)
})

export interface ViewMeta { name: string; alt?: { label: string; run: () => void } }
interface Item extends ViewMeta { el: HTMLImageElement; src: string; w: number; h: number }
interface View { s: number; tx: number; ty: number }

const metas = new WeakMap<HTMLImageElement, ViewMeta>()
const STEP = 1.25
const MAX = 8
const GAP = 32
const FLY_MS = 220

/** 给能点开看的 <img> 摊上的属性:点 / 回车 / 空格都打开看图。meta 按元素记,看图时按 DOM 顺序收。 */
export function viewableProps(meta: ViewMeta) {
  return {
    'data-viewable': '',
    tabIndex: 0,
    role: 'button',
    'aria-label': tr('viewer.open', { name: meta.name }),
    ref: (el: HTMLImageElement | null) => { if (el) metas.set(el, meta) },
    onClick: (e: ReactMouseEvent<HTMLImageElement>) => { e.preventDefault(); openImageViewer(e.currentTarget) },
    onKeyDown: (e: ReactKeyboardEvent<HTMLImageElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      openImageViewer(e.currentTarget)
    },
  }
}

let opened = false
export function openImageViewer(from: HTMLImageElement): void {
  if (opened || !(from.currentSrc || from.src)) return
  const scope = from.closest('.t2-stream-inner') ?? from.parentElement ?? document.body
  const els = [...scope.querySelectorAll<HTMLImageElement>('img[data-viewable]')].filter((el) => el.currentSrc || el.src)
  if (!els.includes(from)) els.unshift(from)
  const items: Item[] = els.map((el) => {
    const meta = metas.get(el)
    return { el, src: el.currentSrc || el.src, name: meta?.name || el.alt || '', alt: meta?.alt, w: el.naturalWidth, h: el.naturalHeight }
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  opened = true
  const done = (last: Item): void => {
    // 推到下一轮再卸:这里常在看图自己的点击 / 动画回调里被调
    window.setTimeout(() => {
      root.unmount()
      host.remove()
      opened = false
      const back = last.el.isConnected ? last.el : from
      if (back.isConnected) back.focus({ preventScroll: true }) // 焦点回到看的最后一张的缩略图
    })
  }
  root.render(<Viewer items={items} start={items.findIndex((it) => it.el === from)} onDone={done} />)
}

const reduced = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

async function fetchBlob(src: string): Promise<Blob> {
  const r = await fetch(src)
  if (!r.ok) throw new Error(String(r.status))
  return r.blob()
}
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bmp = await createImageBitmap(blob) // 剪贴板只认 PNG:别的格式先画一遍
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
}
async function copyImage(src: string): Promise<void> {
  try {
    const png = await toPng(await fetchBlob(src))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    useApp.getState().toast(tr('viewer.copied'))
  } catch {
    useApp.getState().toast(tr('viewer.copyFailed'), true)
  }
}
/** 走全应用的下载出口:安卓 App 的 WebView 不认 `<a download>`,saveResponseAs 会改走原生「存到下载」(Codex P2) */
async function downloadImage(src: string, name: string): Promise<void> {
  try {
    const r = await fetch(src)
    if (!r.ok) throw new Error(String(r.status))
    await saveResponseAs(name || 'image.png', r)
  } catch {
    useApp.getState().toast(tr('viewer.downloadFailed'), true)
  }
}

const CHROME_HIDDEN: NativeChromeClaim = { mode: 'hidden' }

function Viewer({ items, start, onDone }: { items: Item[]; start: number; onDone: (last: Item) => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const flyRef = useRef<HTMLDivElement>(null)
  const [idx, setIdx] = useState(start)
  const [view, setView] = useState<View | null>(null) // null = 适应窗口
  const [box, setBox] = useState({ W: 0, H: 0 })
  const [dims, setDims] = useState(() => items.map((it) => ({ w: it.w, h: it.h })))
  const [drag, setDrag] = useState({ dx: 0, dy: 0 }) // 手机:滑动切换 / 下拉关闭的跟手偏移
  const [menu, setMenu] = useState(false)
  const [closing, setClosing] = useState(false)
  const item = items[idx]
  // 安卓原生外壳:胶囊顶栏 / Dock 是原生视图,永远压在页面之上 —— 看图开着时收起来(Codex P1)
  useNativeChromeClaim(useNativeChromeInstalled() ? CHROME_HIDDEN : null)
  const compact = box.W > 0 && (box.W < 600 || window.matchMedia?.('(pointer: coarse)').matches)

  // 缩略图没解码完的(naturalWidth 还是 0)补量一次
  useEffect(() => {
    items.forEach((it, i) => {
      if (dims[i].w) return
      const im = new Image()
      im.onload = () => setDims((d) => d.map((x, j) => (j === i ? { w: im.naturalWidth, h: im.naturalHeight } : x)))
      im.src = it.src
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => setBox({ W: el.clientWidth, H: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitOf = useCallback((i: number): View => {
    const { w, h } = dims[i]
    if (!w || !h || !box.W) return { s: 1, tx: 0, ty: 0 }
    const maxW = compact ? box.W - 16 : box.W * 0.75
    const maxH = box.H - (compact ? 16 : 44)
    const s = Math.min(maxW / w, maxH / h, 1)
    return { s, tx: (box.W - w * s) / 2, ty: (box.H - h * s) / 2 }
  }, [dims, box, compact])

  const fit = fitOf(idx)
  const v = view ?? fit
  const zoomed = !!view && view.s > fit.s * 1.05

  /** 放大后不许整张拖出去:比视口小就居中,比视口大就贴边为止 */
  const clamp = useCallback((n: View): View => {
    const { w, h } = dims[idx]
    const cw = w * n.s, ch = h * n.s
    return {
      s: n.s,
      tx: cw <= box.W ? (box.W - cw) / 2 : Math.min(0, Math.max(box.W - cw, n.tx)),
      ty: ch <= box.H ? (box.H - ch) / 2 : Math.min(0, Math.max(box.H - ch, n.ty)),
    }
  }, [dims, idx, box])

  /** 以舞台内一点 (px, py) 为中心缩放到 s */
  const zoomTo = useCallback((s: number, px = box.W / 2, py = box.H / 2) => {
    setView((cur) => {
      const c = cur ?? fitOf(idx)
      const next = Math.min(MAX, Math.max(fitOf(idx).s, s))
      if (next <= fitOf(idx).s * 1.05) return null // 缩到适应窗口附近就回到适应窗口
      return clamp({ s: next, tx: px - (px - c.tx) * (next / c.s), ty: py - (py - c.ty) * (next / c.s) })
    })
  }, [box, fitOf, idx, clamp])

  const go = useCallback((d: number) => {
    setIdx((i) => Math.min(items.length - 1, Math.max(0, i + d)))
    setView(null)
    setDrag({ dx: 0, dy: 0 })
  }, [items.length])

  /** 舞台坐标:屏幕坐标减舞台左上角,再除掉 body 的缩放 */
  const local = (x: number, y: number): [number, number] => {
    const st = stageRef.current!
    const r = st.getBoundingClientRect()
    const z = (st as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
    return [(x - r.left) / z, (y - r.top) / z]
  }
  /** 某张缩略图在舞台坐标里的框;不在视口里返回 null */
  const thumbBox = (it: Item): { x: number; y: number; w: number; h: number } | null => {
    if (!it.el.isConnected) return null
    const r = it.el.getBoundingClientRect()
    if (r.width < 2 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null
    const [x, y] = local(r.left, r.top)
    const z = (stageRef.current as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
    return { x, y, w: r.width / z, h: r.height / z }
  }
  /** 从缩略图框到当前主图框的变换(缩略图是方块裁切:按铺满那边对齐中心) */
  const flyFrom = (t: { x: number; y: number; w: number; h: number }, cur: View, i: number): string => {
    const fw = dims[i].w * cur.s, fh = dims[i].h * cur.s
    const k = Math.max(t.w / fw, t.h / fh)
    return `translate(${t.x + t.w / 2 - (cur.tx + fw / 2)}px, ${t.y + t.h / 2 - (cur.ty + fh / 2)}px) scale(${k})`
  }

  // 打开:飞入
  const flown = useRef(false)
  useLayoutEffect(() => {
    if (flown.current || !box.W || !dims[start].w) return
    flown.current = true
    const t = thumbBox(items[start])
    const el = flyRef.current
    if (!t || !el || reduced()) return
    const f = fitOf(start)
    el.style.transformOrigin = `${f.tx + (dims[start].w * f.s) / 2}px ${f.ty + (dims[start].h * f.s) / 2}px`
    el.animate([{ transform: flyFrom(t, f, start) }, { transform: 'none' }], { duration: FLY_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' })
  })

  const close = useCallback(() => {
    if (closing) return
    setClosing(true)
    const finish = (): void => onDone(items[idx])
    const t = thumbBox(items[idx])
    const el = flyRef.current
    if (reduced() || !el) { finish(); return }
    if (t) {
      el.style.transformOrigin = `${v.tx + (dims[idx].w * v.s) / 2}px ${v.ty + (dims[idx].h * v.s) / 2}px`
      el.animate([{ transform: 'none' }, { transform: flyFrom(t, v, idx) }], { duration: FLY_MS, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' }).onfinish = finish
    } else {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).onfinish = finish // 缩略图不在视口:淡出
    }
  }, [closing, items, idx, v, dims, onDone]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }) }, [])
  // 舞台尺寸变了(转屏、改窗口、改界面缩放):放大中的视图重新贴边;小于新的适应比例就回到适应窗口
  useEffect(() => {
    setView((cur) => (!cur ? cur : cur.s <= fitOf(idx).s * 1.05 ? null : clamp(cur)))
  }, [box.W, box.H]) // eslint-disable-line react-hooks/exhaustive-deps

  // 手机返回:先关「更多」菜单,再关看图
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => pushMobileBack(() => closeRef.current()), [])
  useEffect(() => (menu ? pushMobileBack(() => setMenu(false)) : undefined), [menu])

  // 键盘(捕获相位:看图开着时 ← → Esc 不漏给底下的聊天)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      let hit = true
      if (e.key === 'Escape') { if (menu) setMenu(false); else close() }
      else if (e.key === 'ArrowLeft' && !mod) go(-1)
      else if (e.key === 'ArrowRight' && !mod) go(1)
      else if ((e.key === '+' || e.key === '=') && !mod) zoomTo((view ?? fit).s * STEP)
      else if (e.key === '-' && !mod) zoomTo((view ?? fit).s / STEP)
      else if (e.key === '0' && !mod) setView(null)
      else if (e.key.toLowerCase() === 'c' && mod && !window.getSelection()?.toString()) void copyImage(item.src)
      else if (e.key === 'Tab') {
        // aria-modal 不会自己圈住焦点:Tab / ⇧Tab 只在看图层的按钮之间转
        const els = [...(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
        const i = els.indexOf(document.activeElement as HTMLElement)
        const n = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i < 0 || i === els.length - 1 ? 0 : i + 1)
        els[n]?.focus()
      }
      else hit = false
      if (hit) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menu, close, go, zoomTo, view, fit, item.src])

  // 滚轮缩放:要 preventDefault,React 的 onWheel 是被动监听,只能自己挂
  useEffect(() => {
    const st = stageRef.current
    if (!st) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const [px, py] = local(e.clientX, e.clientY)
      const cur = view ?? fit
      zoomTo(cur.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), px, py) // ctrlKey = 触控板捏合
    }
    st.addEventListener('wheel', onWheel, { passive: false })
    return () => st.removeEventListener('wheel', onWheel)
  }, [view, fit, zoomTo]) // eslint-disable-line react-hooks/exhaustive-deps

  // 指针:放大后拖动平移;触屏在适应窗口时左右滑切换、往下拖关闭;双指捏合缩放(跟着当前两指中点走)。
  // 一按下就捕获指针,之后 pointerup 的 target 恒是舞台 —— 点的是什么要在按下时记(hit),别看松手时的 target(Codex P1)
  type Gesture = { x0: number; y0: number; t0: number; v0: View; hit: Element | null; moved: boolean; axis?: 'x' | 'y'; pinch?: { d0: number; ix: number; iy: number } }
  const ptrs = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<Gesture | null>(null)
  const startPinch = (t0: number): void => {
    const [a, b] = [...ptrs.current.values()]
    const v0 = view ?? fit
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    // 记下两指中点落在图上的哪一点(图像坐标):之后不论中点怎么挪,这一点都钉在中点下面
    gesture.current = { x0: mx, y0: my, t0, v0, hit: null, moved: true, pinch: { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, ix: (mx - v0.tx) / v0.s, iy: (my - v0.ty) / v0.s } }
    setDrag({ dx: 0, dy: 0 })
  }
  const onPointerDown = (e: ReactPointerEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return
    stageRef.current?.setPointerCapture(e.pointerId)
    const [x, y] = local(e.clientX, e.clientY)
    ptrs.current.set(e.pointerId, { x, y })
    if (ptrs.current.size >= 2) { startPinch(e.timeStamp); return }
    gesture.current = { x0: x, y0: y, t0: e.timeStamp, v0: view ?? fit, hit: (e.target as Element).closest('.iv-img'), moved: false }
  }
  const onPointerMove = (e: ReactPointerEvent): void => {
    const g = gesture.current
    if (!g || !ptrs.current.has(e.pointerId)) return
    const [x, y] = local(e.clientX, e.clientY)
    ptrs.current.set(e.pointerId, { x, y })
    if (g.pinch) {
      const [a, b] = [...ptrs.current.values()]
      if (!b) return
      const s = Math.min(MAX, Math.max(fit.s, g.v0.s * (Math.hypot(a.x - b.x, a.y - b.y) / g.pinch.d0)))
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      setView(s <= fit.s * 1.05 ? null : clamp({ s, tx: mx - g.pinch.ix * s, ty: my - g.pinch.iy * s }))
      return
    }
    const dx = x - g.x0, dy = y - g.y0
    if (!g.moved && Math.hypot(dx, dy) < 4) return
    g.moved = true
    if (zoomed) { setView(clamp({ s: g.v0.s, tx: g.v0.tx + dx, ty: g.v0.ty + dy })); return }
    if (e.pointerType !== 'touch') return
    g.axis ??= Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    setDrag(g.axis === 'x' ? { dx, dy: 0 } : { dx: 0, dy: Math.max(0, dy) })
  }
  const onPointerUp = (e: ReactPointerEvent): void => {
    ptrs.current.delete(e.pointerId)
    const g = gesture.current
    if (!g) return
    if (g.pinch && ptrs.current.size === 1) {
      // 双指松开一根:拿最新视图和剩下那根手指重起一段单指手势,别把比例拉回捏合前(Codex P2)
      const [p] = [...ptrs.current.values()]
      gesture.current = { x0: p.x, y0: p.y, t0: e.timeStamp, v0: view ?? fit, hit: null, moved: true }
      return
    }
    if (ptrs.current.size > 0) return
    gesture.current = null
    if (!g.moved) {
      // 点邻图 = 切过去;鼠标点在图外的空处 = 关闭(和多数看图一样);点主图不动
      const dir = Number((g.hit as HTMLElement | null)?.dataset.dir || 0)
      if (dir) go(dir)
      else if (!g.hit && e.pointerType === 'mouse') close()
      return
    }
    if (g.pinch || zoomed) return
    const dt = Math.max(1, e.timeStamp - g.t0)
    if (drag.dx && (Math.abs(drag.dx) > box.W * 0.18 || Math.abs(drag.dx) / dt > 0.5)) { go(drag.dx < 0 ? 1 : -1); return }
    if (drag.dy && (drag.dy > 120 || drag.dy / dt > 0.6)) { close(); return }
    setDrag({ dx: 0, dy: 0 })
  }

  const onDouble = (e: ReactMouseEvent): void => {
    const [px, py] = local(e.clientX, e.clientY)
    if (zoomed) setView(null)
    else zoomTo(fit.s < 0.99 ? 1 : fit.s * 2, px, py)
  }

  // 主图与左右邻图
  const at = (i: number): View => (i === idx ? v : fitOf(i))
  const imgStyle = (i: number, p: View = at(i)): CSSProperties =>
    ({ width: dims[i].w || undefined, height: dims[i].h || undefined, transform: `translate(${p.tx}px, ${p.ty}px) scale(${p.s})` })
  const pullDown = drag.dy ? Math.min(1, drag.dy / 400) : 0
  const prev = idx > 0 && !zoomed && !compact ? idx - 1 : -1
  const next = idx < items.length - 1 && !zoomed && !compact ? idx + 1 : -1
  /** 邻图按自己的「适应窗口」大小,贴着主图左 / 右边、隔 32px */
  const side = (i: number): View => {
    const f = fitOf(i)
    return { ...f, tx: i < idx ? fit.tx - GAP - dims[i].w * f.s : fit.tx + dims[idx].w * fit.s + GAP }
  }
  const pct = Math.round(v.s * 100)
  const tools = (
    <>
      <button type="button" className="iv-btn" title={tr('viewer.zoomOut')} aria-label={tr('viewer.zoomOut')} onClick={() => zoomTo(v.s / STEP)} disabled={!zoomed}><Minus size={14} /></button>
      <span className="iv-zoom" aria-live="polite">{pct}%</span>
      <button type="button" className="iv-btn" title={tr('viewer.zoomIn')} aria-label={tr('viewer.zoomIn')} onClick={() => zoomTo(v.s * STEP)} disabled={v.s >= MAX}><Plus size={14} /></button>
      <button type="button" className="iv-btn" title={tr('viewer.fit')} aria-label={tr('viewer.fit')} onClick={() => setView(null)} disabled={!view}><Scan size={14} /></button>
      <span className="iv-sep" />
    </>
  )
  const actions = [
    { key: 'copy', icon: <Copy size={14} />, label: tr('viewer.copy'), run: () => void copyImage(item.src) },
    { key: 'dl', icon: <Download size={14} />, label: tr('viewer.download'), run: () => void downloadImage(item.src, item.name) },
    ...(item.alt ? [{ key: 'alt', icon: <ExternalLink size={14} />, label: item.alt.label, run: () => { const run = item.alt!.run; onDone(item); run() } }] : []),
  ]
  return (
    <div ref={rootRef} className={`iv${closing ? ' is-closing' : ''}${compact ? ' is-compact' : ''}`} role="dialog" aria-modal="true" aria-label={item.name} tabIndex={-1}>
      <div className="iv-back" style={pullDown ? { opacity: 1 - pullDown } : undefined} />
      <div className="iv-bar" style={pullDown ? { opacity: 1 - pullDown } : undefined}>
        <div className="iv-title"><b title={item.name}>{item.name}</b>{items.length > 1 && <span>{idx + 1} / {items.length}</span>}</div>
        <div className="iv-tools">
          {!compact && tools}
          {!compact && actions.map((a) => <button key={a.key} type="button" className="iv-btn" title={a.label} aria-label={a.label} onClick={a.run}>{a.icon}</button>)}
          {compact && (
            <span className="iv-more">
              <button type="button" className="iv-btn" title={tr('viewer.more')} aria-label={tr('viewer.more')} aria-expanded={menu} onClick={() => setMenu((m) => !m)}><MoreHorizontal size={16} /></button>
              {menu && (
                <div className="iv-menu" role="menu">
                  {actions.map((a) => <button key={a.key} type="button" role="menuitem" onClick={() => { setMenu(false); a.run() }}>{a.icon}<span>{a.label}</span></button>)}
                </div>
              )}
            </span>
          )}
          {!compact && <span className="iv-sep" />}
          <button type="button" className="iv-btn" title={tr('viewer.close')} aria-label={tr('viewer.close')} onClick={close}><X size={16} /></button>
        </div>
      </div>
      <div
        ref={stageRef} className={`iv-stage${zoomed ? ' is-zoomed' : ''}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={onDouble}
      >
        {box.W > 0 && (
          <div key={idx} ref={flyRef} className="iv-fly" style={{ transform: `translate(${drag.dx}px, ${drag.dy}px)${pullDown ? ` scale(${1 - pullDown * 0.25})` : ''}`, transition: drag.dx || drag.dy ? 'none' : undefined }}>
            {[prev, next].filter((i) => i >= 0).map((i) => (
              <img key={i} className="iv-img is-side" src={items[i].src} alt="" draggable={false} style={imgStyle(i, side(i))} data-dir={i < idx ? -1 : 1} />
            ))}
            <img key={idx} className="iv-img" src={item.src} alt={item.name} draggable={false} style={imgStyle(idx)} />
          </div>
        )}
        {!compact && idx > 0 && <button type="button" className="iv-arrow is-prev" title={tr('viewer.prev')} aria-label={tr('viewer.prev')} onClick={() => go(-1)}><ChevronLeft size={18} /></button>}
        {!compact && idx < items.length - 1 && <button type="button" className="iv-arrow is-next" title={tr('viewer.next')} aria-label={tr('viewer.next')} onClick={() => go(1)}><ChevronRight size={18} /></button>}
        {!compact && <div className="iv-hint">{tr(zoomed ? 'viewer.hintZoomed' : 'viewer.hint')}</div>}
      </div>
    </div>
  )
}
