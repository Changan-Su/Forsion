/**
 * 落点提示(拖动时「会落在这里」的那根线 / 那圈描边)的唯一真源。动效是方案 B「原地淡入」:
 * 换落点 = 旧的在原地淡出、新的在新位置淡入并从近端展开;同一个落点只是坐标变了(自动滚动、重排)就直接跟,不动画。
 * 方案页:docs/ToBeImproved/落点过渡动效方案_2026-10-24(仓根)。
 *
 * 两种用法:
 * - 已经自己画落点元素的地方(Amadeus 编辑器、标签条):定位前调 `dropRetarget(el, key)`,藏之前调 `dropHide(el)`。
 * - 新代码 / 插件:`createDropIndicator()` 拿一个句柄,传视口坐标即可(fixed 包含块与祖先 zoom 都在里面补偿)。
 * - 每行自己用伪元素画线的列表:不走这里,用 dropIndicator.css 的 `--lcl-drop-enter` / `--lcl-drop-leave`(纯 CSS 同一手感)。
 * - 松手之后:`land(el, from)` 让被拖的那一个从松手处滑进新位置(见文件末尾「松手落位」)。
 *
 * ⚠️ 入场只动 `opacity` 和独立的 `scale` 属性,不碰 `transform`:各处的线靠内联 transform 定位,
 * 关键帧里写 transform 会压过它,线先跳回原点再弹回来(08-15 编辑器那次)。
 */
import './dropIndicator.css'
import { zoomOf } from './menuAnchor'
import { reducedMotion } from './spring'

/** 与 dropIndicator.css 的 token 同值(那边给纯 CSS 的列表用)。 */
export const DROP_IN_MS = 130
export const DROP_OUT_MS = 90
const EASE = 'cubic-bezier(.2,.8,.2,1)'

export type DropShape = 'line' | 'zone'

const current = new WeakMap<HTMLElement, string>()
/** 刚藏起来的那一下:同一个落点很快又显示回来(编辑器在同一个 dragover 里先藏后画、或下一拍接着画)就当没藏过。 */
const lastHide = new WeakMap<HTMLElement, { key: string; ghost: HTMLElement | null; at: number }>()
const REHIDE_MS = 80
/** 每个落点元素名下还在淡出的影子:销毁时一起收(插件停用那一刻不许留尾巴)。 */
const ghostsOf = new WeakMap<HTMLElement, Set<HTMLElement>>()

const shown = (el: HTMLElement): boolean => el.isConnected && getComputedStyle(el).display !== 'none'

export interface DropRetargetOptions {
  shape?: DropShape
  /** 线的走向。缺省按元素当前宽高猜 —— 还藏着(0×0)的竖线猜不出来,竖线请明说 'v'。 */
  axis?: 'h' | 'v'
}

/** 线横着从左端展开、竖着从上端展开;描边整体微缩放大。 */
function enterScale(el: HTMLElement, { shape = 'line', axis }: DropRetargetOptions): string {
  if (shape === 'zone') { el.style.transformOrigin = 'center'; return '.97' }
  const vertical = axis ? axis === 'v' : el.offsetHeight > el.offsetWidth
  el.style.transformOrigin = vertical ? 'center top' : 'left center'
  return vertical ? '1 .6' : '.6 1'
}

/** 把元素此刻的样子留一份,原地淡出后删掉。只抄画得出来的那几样;类名不带过去,免得仪器把它当成活的那根。 */
function leaveGhost(el: HTMLElement): HTMLElement | null {
  const parent = el.parentElement
  if (!parent || typeof el.animate !== 'function') return null
  const cs = getComputedStyle(el)
  const g = el.cloneNode(false) as HTMLElement
  g.removeAttribute('id')
  g.className = 'lcl-drop-ghost'
  for (const k of ['position', 'left', 'top', 'width', 'height', 'margin', 'background-color', 'border-radius', 'box-shadow', 'z-index', 'transform', 'transform-origin', 'outline']) {
    g.style.setProperty(k, cs.getPropertyValue(k))
  }
  g.style.pointerEvents = 'none'
  g.style.animation = 'none'
  parent.insertBefore(g, el)
  let set = ghostsOf.get(el)
  if (!set) ghostsOf.set(el, (set = new Set()))
  set.add(g)
  const done = (): void => { g.remove(); set!.delete(g) }
  const a = g.animate([{ opacity: cs.opacity }, { opacity: 0 }], { duration: DROP_OUT_MS, easing: 'ease-out', fill: 'forwards' })
  a.finished.then(done, done)
  return g
}

/**
 * 落点要换了:在**写新位置之前**调。key 认落点本身(块的文档位置、行 id…),不认坐标:
 * key 不变 = 同一个落点只是挪了坐标,什么都不做;key 变了且原来亮着 = 旧样子留一份淡出,el 在新位置淡入。
 */
export function dropRetarget(el: HTMLElement, key: string, opts: DropRetargetOptions = {}): void {
  const hid = lastHide.get(el)
  lastHide.delete(el)
  if (hid && hid.key === key && performance.now() - hid.at < REHIDE_MS) {
    hid.ghost?.remove() // 刚才那一下藏不算数:撤掉影子,原样亮着,不重播淡入
    current.set(el, key)
    return
  }
  const prev = current.get(el)
  current.set(el, key)
  if (prev === key || reducedMotion() || typeof el.animate !== 'function') return
  if (prev !== undefined && shown(el)) leaveGhost(el)
  const from = enterScale(el, opts)
  el.animate([{ opacity: 0, scale: from }, { opacity: 1, scale: '1' }], { duration: DROP_IN_MS, easing: EASE })
}

/** 落点提示要藏了:留一份淡出,再 `display: none`。之后再出现算新落点(会淡入);
 *  只有 80ms 内又以同一个 key 显示回来时例外 —— 那是调用方先藏后画同一处,原样接上。 */
export function dropHide(el: HTMLElement | null | undefined): void {
  if (!el) return
  const key = current.get(el)
  if (key !== undefined && shown(el)) {
    const ghost = reducedMotion() ? null : leaveGhost(el)
    lastHide.set(el, { key, ghost, at: performance.now() })
  }
  current.delete(el)
  el.style.display = 'none'
}

export interface DropRect { x: number; y: number; w?: number; h?: number }

export interface DropIndicator {
  /** 一根线,视口坐标。横线给 `{ x, y, w }`(y = 线的上沿),竖线给 `{ x, y, h }` 加 `axis: 'v'`。 */
  line(rect: DropRect, opts?: { key?: string; axis?: 'h' | 'v' }): void
  /** 「放进去」的描边,视口坐标的矩形。 */
  zone(rect: Required<DropRect>, opts?: { key?: string }): void
  hide(): void
  destroy(): void
}

/** 能给后代 `position: fixed` 当包含块的祖先(transform / filter / contain…),坐标要相对它算。 */
function fixedOrigin(el: HTMLElement): { x: number; y: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p)
    const cb = cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none'
      || (!!cs.backdropFilter && cs.backdropFilter !== 'none') || (!!cs.containerType && cs.containerType !== 'normal')
      || /\b(layout|paint|strict|content)\b/.test(cs.contain ?? '') || /\b(transform|perspective|filter|backdrop-filter|contain)\b/.test(cs.willChange ?? '')
    if (cb) {
      const r = p.getBoundingClientRect()
      return { x: r.left + (Number.parseFloat(cs.borderLeftWidth) || 0), y: r.top + (Number.parseFloat(cs.borderTopWidth) || 0) }
    }
  }
  return { x: 0, y: 0 }
}

/** 一个落点提示:一个 fixed 元素,线和描边共用(换形状也算换落点)。host 缺省 document.body。 */
export function createDropIndicator(opts: { host?: HTMLElement; className?: string } = {}): DropIndicator {
  let el: HTMLDivElement | null = null
  const ensure = (): HTMLDivElement => {
    const host = opts.host ?? document.body
    if (!el) {
      el = document.createElement('div')
      el.className = `lcl-drop-ind${opts.className ? ` ${opts.className}` : ''}`
      el.setAttribute('aria-hidden', 'true')
    }
    if (el.parentElement !== host) host.appendChild(el) // 建过就复用:host 还没挂进文档时也不另起一个
    return el
  }
  const place = (r: Required<DropRect>, shape: DropShape, axis: 'h' | 'v', key: string): void => {
    const d = ensure()
    // 先显示再量:display:none 的元素 currentCSSZoom 恒为 1(见 WorkspaceHost showTarget)
    const wasHidden = !shown(d)
    if (wasHidden) d.style.display = 'block'
    const z = zoomOf(d), o = fixedOrigin(d)
    if (wasHidden) d.style.display = 'none'
    dropRetarget(d, `${shape}:${key}`, { shape, axis }) // 先留旧样子的影子,再换形状
    d.classList.toggle('lcl-drop-ind--zone', shape === 'zone')
    d.classList.toggle('lcl-drop-ind--v', shape === 'line' && axis === 'v')
    d.style.display = 'block'
    d.style.left = `${(r.x - o.x) / z}px`
    d.style.top = `${(r.y - o.y) / z}px`
    if (shape === 'zone' || axis === 'h') d.style.width = `${r.w / z}px`; else d.style.removeProperty('width')
    if (shape === 'zone' || axis === 'v') d.style.height = `${r.h / z}px`; else d.style.removeProperty('height')
  }
  const auto = (r: Required<DropRect>): string => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
  return {
    line(rect, o = {}) {
      const axis = o.axis ?? 'h'
      const r = { x: rect.x, y: rect.y, w: rect.w ?? 0, h: rect.h ?? 0 }
      place(r, 'line', axis, o.key ?? `${axis}:${auto(r)}`)
    },
    zone(rect, o = {}) { place(rect, 'zone', 'h', o.key ?? auto(rect)) },
    hide() { dropHide(el) },
    destroy() {
      if (!el) return
      for (const g of ghostsOf.get(el) ?? []) g.remove()
      ghostsOf.delete(el); lastHide.delete(el); current.delete(el)
      el.remove(); el = null
    },
  }
}

// ───────────────────────── 松手落位(借鉴 Comma 方案 2.5,2026-10-25) ─────────────────────────
// 拖动排序松手后,被拖的那一个从松手的位置(拖影所在处)滑进新位置:160ms 减速、阴影一路变淡,邻居不动(不让位,
// 让位那半是落点方案 D,用户选了 B)。FLIP:量新位置 → 内联 transform 反向位移到松手处 → 下一拍 transition 回 0。
// ⚠️ 只用 transition,不写动 transform 的关键帧(08-15 线跳回原点那次);减少动态效果 = 直接到位。

/** 与 base.css 的 --land-duration 同值(兜底计时用)。 */
export const LAND_MS = 160
const LAND_TRANSITION = 'transform var(--lcl-land, 160ms) var(--lcl-drop-ease, cubic-bezier(.2,.8,.2,1)), box-shadow var(--lcl-land, 160ms) var(--lcl-drop-ease, cubic-bezier(.2,.8,.2,1))'

/** 视口坐标的左上角(DOMRect 直接能传)。 */
export interface LandPoint { x: number; y: number }

/** 从 `to`(现在的位置)看回 `from`(松手处)要的位移。两边都是视口 px,translate 写的是元素自己的局部 px,
 *  所以除以元素的有效缩放(`currentCSSZoom`;用户 dev 常年 110%)。 */
export function landOffset(from: LandPoint, to: LandPoint, zoom = 1): { dx: number; dy: number } {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1
  return { dx: (from.x - to.x) / z, dy: (from.y - to.y) / z }
}

/** 拖起来那一下记下指针在元素里的位置;松手时 `releasePoint(e, grab)` 就是拖影的左上角 = 落位的起点。 */
export function dragGrab(el: Element, e: { clientX: number; clientY: number }): LandPoint {
  const r = el.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
export function releasePoint(e: { clientX: number; clientY: number }, grab: LandPoint): LandPoint {
  return { x: e.clientX - grab.x, y: e.clientY - grab.y }
}

const landing = new WeakMap<HTMLElement, () => void>()

/** 停掉某个元素还在飞的落位,内联样式原样还回去。 */
export function landCancel(el: HTMLElement | null | undefined): void {
  if (el) landing.get(el)?.()
}

export interface LandOptions {
  /** 和它一起搬的元素(展开着的组底下那块会话):同一段视口位移,不带阴影。 */
  with?: Array<HTMLElement | null | undefined>
  /** 飞行期间临时放开裁剪的祖先(overflow: clip / hidden 的折叠容器,不然从组外飞进来的那一段被裁掉)。 */
  unclip?: Array<HTMLElement | null | undefined>
}

interface Flight { go(): void; restore(): void }

/** 一个元素的一次飞行:先瞬时反向位移到松手处(lead 还带上「被拿起来」的阴影),go() 再过渡回原样。 */
function flight(el: HTMLElement, dx: number, dy: number, lead: boolean): Flight {
  const s = el.style
  const prev = { transform: s.transform, transition: s.transition, boxShadow: s.boxShadow, zIndex: s.zIndex }
  const base = prev.transform && prev.transform !== 'none' ? ` ${prev.transform}` : ''
  s.transition = 'none'
  s.transform = `translate(${dx}px, ${dy}px)${base}`
  if (lead) {
    s.boxShadow = 'var(--card-shadow)'
    // 定位元素彼此按文档序叠:让飞着的那个压在邻居上面。不定位的元素有 transform 就画在普通流之上,不用管。
    if (getComputedStyle(el).position !== 'static') s.zIndex = '1'
  }
  return {
    // 回到它自己原来的样子(内联原值;没有就交还样式表),阴影也是淡回它自己的那份,不是硬写 none
    go() { s.transition = LAND_TRANSITION; s.transform = prev.transform; if (lead) s.boxShadow = prev.boxShadow },
    restore() { s.transition = prev.transition; s.transform = prev.transform; s.boxShadow = prev.boxShadow; s.zIndex = prev.zIndex },
  }
}

/**
 * 落位:`el` 已经在新位置上了(重渲之后、绘制之前调最好:useLayoutEffect / requestAnimationFrame),
 * `from` 是它看上去该出发的地方(视口 px 的左上角,通常 = `releasePoint(dropEvent, grab)`)。
 * 返回用掉的位移(局部 px);没动画(减少动态效果、元素不在文档里或没有尺寸、位移不到 1px)返回 null。
 */
export function land(el: HTMLElement | null | undefined, from: LandPoint | null | undefined, opts: LandOptions = {}): { dx: number; dy: number } | null {
  if (!el || !from || !el.isConnected || reducedMotion()) return null
  landCancel(el)
  const to = el.getBoundingClientRect()
  if (!to.width || !to.height) return null
  const viewDx = from.x - to.left, viewDy = from.y - to.top
  if (Math.abs(viewDx) < 1 && Math.abs(viewDy) < 1) return null
  const { dx, dy } = landOffset(from, { x: to.left, y: to.top }, zoomOf(el))
  const flights: Flight[] = [flight(el, dx, dy, true)]
  const movers: HTMLElement[] = [el]
  for (const w of opts.with ?? []) {
    if (!w || movers.includes(w) || !w.isConnected) continue
    landCancel(w)
    const o = landOffset({ x: viewDx, y: viewDy }, { x: 0, y: 0 }, zoomOf(w))
    flights.push(flight(w, o.dx, o.dy, false))
    movers.push(w)
  }
  const unclips: Array<() => void> = []
  for (const u of opts.unclip ?? []) {
    if (!u) continue
    const prev = u.style.overflow
    u.style.overflow = 'visible'
    unclips.push(() => { u.style.overflow = prev })
  }
  void el.getBoundingClientRect() // 先把反向位移落定,下面的 transition 才有起点
  let timer = 0
  const done = (): void => {
    window.clearTimeout(timer)
    el.removeEventListener('transitionend', onEnd)
    for (const m of movers) landing.delete(m)
    for (const f of flights) f.restore()
    for (const u of unclips) u()
  }
  const onEnd = (e: TransitionEvent): void => { if (e.target === el && e.propertyName === 'transform') done() }
  for (const m of movers) landing.set(m, done)
  for (const f of flights) f.go()
  el.addEventListener('transitionend', onEnd)
  timer = window.setTimeout(done, LAND_MS + 80) // transitionend 不一定来(被打断、元素被摘、主题把时长改成 0)
  return { dx, dy }
}

/**
 * 数据要过一会儿才重渲(插件 / 写盘之后才换组)时用:每帧问一次 `find()`,等它返回的元素**换了地方**
 * (换了元素 —— 重新挂载;或换了父节点 / 前一个兄弟 —— 被挪动)就落位;`timeout` 内没动就作罢。
 * 在绘制之前的那一帧里落,不会先闪一下新位置。返回取消函数。
 */
export function landWhenMoved(
  find: () => HTMLElement | null | undefined,
  from: LandPoint,
  opts: {
    timeout?: number
    with?: (el: HTMLElement) => LandOptions['with']
    unclip?: (el: HTMLElement) => LandOptions['unclip']
    /** 换了地方之后由调用方自己落(插件接缝要记账);缺省 = land(el, from, { with, unclip })。 */
    onMoved?: (el: HTMLElement) => void
  } = {},
): () => void {
  if (reducedMotion() || typeof requestAnimationFrame !== 'function') return () => {}
  const was = find() ?? null
  const parent = was?.parentElement ?? null
  const prev = was?.previousElementSibling ?? null
  const until = performance.now() + (opts.timeout ?? 1200)
  let raf = 0
  const tick = (): void => {
    const el = find()
    if (el && (el !== was || el.parentElement !== parent || el.previousElementSibling !== prev)) {
      if (opts.onMoved) opts.onMoved(el)
      else land(el, from, { with: opts.with?.(el), unclip: opts.unclip?.(el) })
      return
    }
    if (performance.now() < until) raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}
