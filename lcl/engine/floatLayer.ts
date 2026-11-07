/**
 * 浮层宿主(2026-11-07,LCL 表面规范方案 B 第一期;方案页 docs/ToBeImproved/LCL表面规范方案_2026-11-07/)。
 *
 * 「浮」是层级属性:一块东西浮起来时说清三件事 ——
 *   - 作用域 scope:浮在谁之上、跟谁一起藏。'view' = 一个视图的纸面里(视图不在就不出);'space' = 当前 Space 的三栏之上
 *     (切走那个 Space 就藏、回来原样出现);'window' = 整个窗口(切 Space 也留着)。桌面作用域(OS 窗)是后面几期的事。
 *   - 锚点 anchor:六个(四角 + 上下居中)。用户拖动把手松手后吸到最近的一个;给了 id 的记在本机。
 *   - 用途 role:'panel' 面板(停在锚点,重叠时后开的在上)/ 'notice' 通知(同一层同一锚点的通知竖着叠放,间距 8px,
 *     role=status 读屏会念)。用途只管行为,不排 z 次序(Codex 评审:弹窗里开的菜单得盖过弹窗,固定梯子做不到)。
 *
 * 层级:View 层在视图里(--z-view-float);Space 层在 Shell 封箱里(.shell-host isolation,--z-space-float 在 Dockview
 * 分隔条 99 之上);窗口层挂 body(--z-window-float,菜单 / 弹出 / 提示框都在它之上)。一个窗口里没有 Space 层(Mini、
 * 浮窗、拆出的视图窗)时 Space 作用域退到窗口层,切 Space 照样按 Space id 藏。
 *
 * 浮层本身不抢焦点(不 focus 任何东西);内容归调用方。插件经 ctx.ui.float 用它,停用 / 重载时宿主统一 close。
 */
import { useSpaceStore } from './spaceRegistry'
import { dragGrab, land, releasePoint } from './dropIndicator'
import { removeOverlayWithExit, zoomOf } from './menuAnchor'
import './floatLayer.css'

export type FloatScope = 'view' | 'space' | 'window'
export type FloatAnchor = 'top-start' | 'top-center' | 'top-end' | 'bottom-start' | 'bottom-center' | 'bottom-end'
export type FloatRole = 'panel' | 'notice'
export const FLOAT_SCOPES: readonly FloatScope[] = ['view', 'space', 'window']
export const FLOAT_ANCHORS: readonly FloatAnchor[] = ['top-start', 'top-center', 'top-end', 'bottom-start', 'bottom-center', 'bottom-end']
export const FLOAT_ROLES: readonly FloatRole[] = ['panel', 'notice']

export interface FloatOptions {
  scope: FloatScope
  /** scope 'view' 必填:浮在哪个元素里(通常是视图根)。它是 static 定位时会被设成 relative。 */
  host?: HTMLElement
  /** scope 'space':属于哪个 Space,缺省 = 打开时的 Space。 */
  space?: string
  /** 缺省 'bottom-end'。给了 id 且本机记过用户拖到的锚点时,以记住的为准。 */
  anchor?: FloatAnchor
  /** 缺省 'panel'。 */
  role?: FloatRole
  /** 稳定 id:用户拖过的锚点按它记在本机(读失败 = 不知道,用缺省)。 */
  id?: string
  /** 读屏名(panel 用 aria-label)。 */
  label?: string
  /** true = 不给卡面(底色、圆角、阴影、描边),内容自己画。 */
  bare?: boolean
  /** 用户拖动换了锚点。 */
  onAnchorChange?(anchor: FloatAnchor): void
}

export interface FloatHandle {
  /** 内容挂在这里。带 `data-float-drag` 的子元素是拖动把手(按钮、输入框上按下不算)。 */
  readonly el: HTMLElement
  readonly anchor: FloatAnchor
  readonly closed: boolean
  move(anchor: FloatAnchor): void
  close(): void
}

interface Rec {
  el: HTMLElement
  scope: FloatScope
  role: FloatRole
  anchor: FloatAnchor
  space: string | null
  host: HTMLElement | null
  id: string | null
  onAnchorChange?: (a: FloatAnchor) => void
  closed: boolean
  offDrag: () => void
}

const recs = new Set<Rec>()
let spaceLayer: HTMLElement | null = null
let windowLayer: HTMLElement | null = null
let unsubSpace: (() => void) | null = null

const KEY = (id: string): string => `lcl.float.anchor.${id}`
const isAnchor = (a: unknown): a is FloatAnchor => typeof a === 'string' && (FLOAT_ANCHORS as readonly string[]).includes(a)

/** 记住的锚点;读失败 / 没有 / 坏值 = null(用缺省,不写回)。 */
export function savedAnchor(id: string): FloatAnchor | null {
  try { const v = localStorage.getItem(KEY(id)); return isAnchor(v) ? v : null } catch { return null }
}
function saveAnchor(id: string, a: FloatAnchor): void { try { localStorage.setItem(KEY(id), a) } catch { /* 存不下就只这一程 */ } }

/** 松手点(层内的比例坐标 0~1)→ 最近的锚点:上下按一半分,左右按三等分。 */
export function nearestAnchor(fx: number, fy: number): FloatAnchor {
  const v = fy < 0.5 ? 'top' : 'bottom'
  const h = fx < 1 / 3 ? 'start' : fx > 2 / 3 ? 'end' : 'center'
  return `${v}-${h}` as FloatAnchor
}

const activeSpace = (): string => useSpaceStore.getState().activeSpaceId

function makeLayer(scope: FloatScope): HTMLElement {
  const el = document.createElement('div')
  el.className = 'lcl-float-layer'
  el.dataset.scope = scope
  return el
}
function windowLayerEl(): HTMLElement {
  if (!windowLayer || !windowLayer.isConnected) { windowLayer = makeLayer('window'); document.body.appendChild(windowLayer) }
  return windowLayer
}
function viewLayerEl(host: HTMLElement): HTMLElement {
  let layer = host.querySelector<HTMLElement>(':scope > .lcl-float-layer[data-scope="view"]')
  if (!layer) {
    const pos = getComputedStyle(host).position
    if (!pos || pos === 'static') host.style.position = 'relative'
    layer = makeLayer('view')
    host.appendChild(layer)
  }
  return layer
}
function layerFor(rec: Rec): HTMLElement {
  // View 浮层只认自己的宿主(宿主被摘下来也留在它里面,绝不退到窗口层盖住整个窗口);只有 Space 浮层会退到窗口层
  if (rec.scope === 'view') return viewLayerEl(rec.host!)
  if (rec.scope === 'space' && spaceLayer?.isConnected) return spaceLayer
  return windowLayerEl()
}
function stackOf(layer: HTMLElement, anchor: FloatAnchor): HTMLElement {
  let s = layer.querySelector<HTMLElement>(`:scope > .lcl-float-stack[data-anchor="${anchor}"]`)
  if (!s) { s = document.createElement('div'); s.className = 'lcl-float-stack'; s.dataset.anchor = anchor; layer.appendChild(s) }
  return s
}

function syncVisibility(rec: Rec): void {
  rec.el.hidden = rec.scope === 'space' && rec.space != null && rec.space !== activeSpace()
}
function place(rec: Rec): void {
  const layer = layerFor(rec)
  rec.el.dataset.anchor = rec.anchor
  if (rec.role === 'notice') {
    const stack = stackOf(layer, rec.anchor)
    if (rec.el.parentElement !== stack) stack.appendChild(rec.el)
  } else if (rec.el.parentElement !== layer) layer.appendChild(rec.el)
  syncVisibility(rec)
}
function pruneEmpty(layer: Element | null): void {
  if (!layer) return
  for (const s of layer.querySelectorAll(':scope > .lcl-float-stack')) if (!s.childElementCount) s.remove()
  if ((layer as HTMLElement).dataset.scope === 'view' && !layer.childElementCount) layer.remove()
}

function ensureSpaceWatch(): void {
  if (unsubSpace) return
  unsubSpace = useSpaceStore.subscribe((s, p) => { if (s.activeSpaceId !== p.activeSpaceId) for (const r of recs) syncVisibility(r) })
}

/** Space 层(WorkspaceHost / SingleColumnHost 各挂一个)登记;已经开着的 Space 浮层搬进来。 */
export function registerSpaceFloatLayer(el: HTMLElement): () => void {
  spaceLayer = el
  for (const r of recs) if (r.scope === 'space') place(r)
  return () => {
    if (spaceLayer !== el) return
    spaceLayer = null
    for (const r of recs) if (r.scope === 'space' && el.contains(r.el)) place(r) // 层要卸了:先搬到窗口层,别跟着一起没了
  }
}

const NO_DRAG = 'button, a[href], input, textarea, select, [contenteditable=""], [contenteditable="true"]'

function attachDrag(rec: Rec): () => void {
  const el = rec.el
  let abort: (() => void) | null = null // 正在拖的那一程:关浮层时一并撤掉窗口上的监听
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || rec.closed) return
    const t = e.target as Element | null
    const handle = t?.closest?.('[data-float-drag]')
    if (!handle || !el.contains(handle) || t!.closest(NO_DRAG)) return
    const sx = e.clientX, sy = e.clientY, grab = dragGrab(el, e), z = zoomOf(el)
    let dragging = false
    const move = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
        dragging = true
        el.dataset.dragging = ''
        try { el.setPointerCapture(ev.pointerId) } catch { /* 指针已经没了 */ }
      }
      el.style.transform = `translate(${(ev.clientX - sx) / z}px, ${(ev.clientY - sy) / z}px)`
    }
    const detach = (): void => {
      abort = null
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', onCancel, true)
    }
    const end = (ev: PointerEvent, cancel: boolean): void => {
      detach()
      if (!dragging) return
      delete el.dataset.dragging
      el.style.transform = ''
      // 拖过就吃掉松手后紧跟的那一下 click(别把把手上的点击当成开合);没有 click 跟来就在下一拍撤掉,不吃后面的点击
      const swallow = (c: Event): void => { c.stopPropagation(); c.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      if (cancel || rec.closed) return
      const layer = el.closest('.lcl-float-layer')
      const r = layer?.getBoundingClientRect()
      if (!r || !r.width || !r.height) return
      const next = nearestAnchor((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height)
      const from = releasePoint(ev, grab)
      setAnchor(rec, next, true)
      land(el, from)
    }
    const up = (ev: PointerEvent): void => end(ev, false)
    const onCancel = (ev: PointerEvent): void => end(ev, true)
    abort?.()
    abort = () => {
      detach()
      if (!dragging) return
      delete el.dataset.dragging
      el.style.transform = ''
      try { el.releasePointerCapture(e.pointerId) } catch { /* 已经放了 */ }
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', onCancel, true)
  }
  el.addEventListener('pointerdown', onDown)
  return () => { el.removeEventListener('pointerdown', onDown); abort?.() }
}

function setAnchor(rec: Rec, anchor: FloatAnchor, byUser: boolean): void {
  if (rec.closed || anchor === rec.anchor) return
  const old = rec.el.parentElement?.closest('.lcl-float-layer') ?? null
  rec.anchor = anchor
  place(rec)
  pruneEmpty(old)
  if (byUser) {
    if (rec.id) saveAnchor(rec.id, anchor)
    try { rec.onAnchorChange?.(anchor) } catch (e) { console.error('[lcl] float onAnchorChange failed', e) }
  }
}

/** 开一块浮层。参数不对同步抛 TypeError(调用方 bug,别静默)。 */
export function openFloat(opts: FloatOptions): FloatHandle {
  if (!opts || typeof opts !== 'object') throw new TypeError('openFloat needs options')
  const scope = opts.scope
  if (!FLOAT_SCOPES.includes(scope)) throw new TypeError(`float scope must be one of ${FLOAT_SCOPES.join(', ')}`)
  if (scope === 'view' && !(opts.host instanceof HTMLElement)) throw new TypeError("float scope 'view' needs a host element")
  if (opts.anchor != null && !isAnchor(opts.anchor)) throw new TypeError(`float anchor must be one of ${FLOAT_ANCHORS.join(', ')}`)
  if (opts.role != null && !FLOAT_ROLES.includes(opts.role)) throw new TypeError(`float role must be one of ${FLOAT_ROLES.join(', ')}`)
  const id = opts.id != null ? String(opts.id) : null
  const role = opts.role ?? 'panel'
  const el = document.createElement('div')
  el.className = 'lcl-float'
  el.dataset.role = role
  el.dataset.scope = scope
  el.dataset.motion = 'toast' // 统一入场的那一档:从下沿 6px 淡入,卸载替身淡出(base.css 退场名单里有 [data-motion~='toast'])
  if (opts.bare) el.dataset.bare = ''
  if (role === 'notice') { el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite') } else el.setAttribute('role', 'region')
  if (opts.label) el.setAttribute('aria-label', String(opts.label))
  const rec: Rec = {
    el, scope, role,
    anchor: (id && savedAnchor(id)) || opts.anchor || 'bottom-end',
    space: scope === 'space' ? (opts.space != null ? String(opts.space) : activeSpace()) : null,
    host: scope === 'view' ? opts.host! : null,
    id, onAnchorChange: opts.onAnchorChange, closed: false, offDrag: () => {},
  }
  rec.offDrag = attachDrag(rec)
  recs.add(rec)
  if (scope === 'space') ensureSpaceWatch()
  place(rec)
  return {
    el,
    get anchor() { return rec.anchor },
    get closed() { return rec.closed },
    move(anchor) {
      if (!isAnchor(anchor)) throw new TypeError(`float anchor must be one of ${FLOAT_ANCHORS.join(', ')}`)
      setAnchor(rec, anchor, false)
    },
    close() {
      if (rec.closed) return
      rec.closed = true
      recs.delete(rec)
      rec.offDrag()
      const layer = el.parentElement?.closest('.lcl-float-layer') ?? null
      if (el.hidden || !el.isConnected) { el.remove(); pruneEmpty(layer) }
      else void removeOverlayWithExit(el).then(() => pruneEmpty(layer)) // 替身放完退场才摘,空的叠放组 / View 层等它走了再收
    },
  }
}

/** 测试用:清掉全部浮层和层。 */
export function resetFloatsForTest(): void {
  for (const r of [...recs]) { r.closed = true; r.offDrag(); r.el.remove() }
  recs.clear()
  windowLayer?.remove(); windowLayer = null
  spaceLayer = null
  unsubSpace?.(); unsubSpace = null
}
