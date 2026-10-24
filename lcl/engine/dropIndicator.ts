/**
 * 落点提示(拖动时「会落在这里」的那根线 / 那圈描边)的唯一真源。动效是方案 B「原地淡入」:
 * 换落点 = 旧的在原地淡出、新的在新位置淡入并从近端展开;同一个落点只是坐标变了(自动滚动、重排)就直接跟,不动画。
 * 方案页:docs/ToBeImproved/落点过渡动效方案_2026-10-24(仓根)。
 *
 * 两种用法:
 * - 已经自己画落点元素的地方(Amadeus 编辑器、标签条):定位前调 `dropRetarget(el, key)`,藏之前调 `dropHide(el)`。
 * - 新代码 / 插件:`createDropIndicator()` 拿一个句柄,传视口坐标即可(fixed 包含块与祖先 zoom 都在里面补偿)。
 * - 每行自己用伪元素画线的列表:不走这里,用 dropIndicator.css 的 `--lcl-drop-enter` / `--lcl-drop-leave`(纯 CSS 同一手感)。
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
  const a = g.animate([{ opacity: cs.opacity }, { opacity: 0 }], { duration: DROP_OUT_MS, easing: 'ease-out', fill: 'forwards' })
  a.finished.then(() => g.remove(), () => g.remove())
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
    if (el?.isConnected) return el
    el = document.createElement('div')
    el.className = `lcl-drop-ind${opts.className ? ` ${opts.className}` : ''}`
    el.setAttribute('aria-hidden', 'true')
    ;(opts.host ?? document.body).appendChild(el)
    return el
  }
  const place = (r: Required<DropRect>, shape: DropShape, axis: 'h' | 'v', key: string): void => {
    const d = ensure()
    d.classList.toggle('lcl-drop-ind--zone', shape === 'zone')
    d.classList.toggle('lcl-drop-ind--v', shape === 'line' && axis === 'v')
    // 先显示再量:display:none 的元素 currentCSSZoom 恒为 1(见 WorkspaceHost showTarget)
    const wasHidden = !shown(d)
    if (wasHidden) d.style.display = 'block'
    const z = zoomOf(d), o = fixedOrigin(d)
    if (wasHidden) d.style.display = 'none'
    dropRetarget(d, `${shape}:${key}`, { shape, axis })
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
    destroy() { if (el) { current.delete(el); el.remove(); el = null } },
  }
}
