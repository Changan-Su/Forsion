/**
 * 提示框(Tooltip)与悬停卡(HoverCard)的唯一真源:时序、接力、定位都在这里,宿主 View、Ribbon、插件(ctx.ui)共用。
 *
 * 时序(2026-10-23 借鉴 Comma 方案 §4,取代 desktop hoverTip / Ribbon 浮签的 1s / 0.1s):
 * - 停够 `--tip-delay`(300ms)才出;悬停卡用 `--hovercard-delay`。
 * - **接力**:已经弹着(或刚离开、还在 `--tip-handoff` 80ms 的宽限里)时移到另一个触发点 → 同一张浮层直接挪过去,
 *   不重播退场 / 入场。
 * - 键盘聚焦(:focus-visible)立刻出、不做动画;失焦立刻收。按下鼠标即收,点完停在原处不再弹(移开再回来才重新计时)。
 * - 进 / 出用 transition(会被打断的状态不用 keyframes);入场从 @starting-style 起,出场加速离开。时长曲线全是 token,见 hoverSurface.css。
 *
 * 浮层只在显示时挂在 body 上,收完就摘掉(台架按 `.rb-tip` / `body > .app-ref-card` 的有无判断开合)。
 * 内容由调用方的 fill 写进浮层元素:到点才调(侧栏的 fs:stat 靠这个节流),返回 false = 这次不弹。
 */
import { zoomOf } from './menuAnchor'
import './hoverSurface.css'

export type HoverSide = 'top' | 'bottom' | 'left' | 'right'
export interface RectLike { left: number; right: number; top: number; bottom: number }

export interface HoverSpec {
  /** 浮层元素上额外的类名(主题材质登记、台架选择器)。 */
  className?: string
  /** 首选方向,放不下翻到对面。缺省 top。 */
  side?: HoverSide
  /** 锚定矩形(视口 px),缺省 = 触发元素的 getBoundingClientRect()。 */
  rect?: (trigger: HTMLElement) => RectLike
  /** 往浮层里写内容。到点才调;false / 抛错 = 不弹。可以异步:异步回来先问 alive(),已经过时(换了别的、离开了)就别写。 */
  fill(el: HTMLDivElement, alive: () => boolean): boolean | Promise<boolean>
  /** 浮层不再显示这份内容时调(收完,或接力给了别人):React 调用方在这里摘掉 portal。 */
  release?(): void
}

type Kind = 'tip' | 'card'
const TOKENS: Record<Kind, { delay: [string, number]; handoff: [string, number]; cls: string }> = {
  tip: { delay: ['--tip-delay', 300], handoff: ['--tip-handoff', 80], cls: 'lcl-tip' },
  card: { delay: ['--hovercard-delay', 300], handoff: ['--tip-handoff', 80], cls: 'lcl-hovercard' },
}

/** 读时长 token(`300ms` / `0.3s`);读不到用兜底。 */
function ms([name, fallback]: [string, number]): number {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const n = parseFloat(v)
    if (Number.isFinite(n)) return v.endsWith('ms') ? n : n * 1000
  } catch { /* 无 DOM 环境 */ }
  return fallback
}

const GAP = 8
const MARGIN = 8

/** 纯算术(测试打在这里):按首选方向摆,放不下翻面,横纵都夹进视口。全部视口 px。 */
export function placeHover(a: RectLike, w: number, h: number, vw: number, vh: number, side: HoverSide): { left: number; top: number; side: HoverSide } {
  const flip: Record<HoverSide, HoverSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  const at = (s: HoverSide): { left: number; top: number } => {
    if (s === 'top' || s === 'bottom') return { left: (a.left + a.right) / 2 - w / 2, top: s === 'top' ? a.top - GAP - h : a.bottom + GAP }
    return { left: s === 'left' ? a.left - GAP - w : a.right + GAP, top: (a.top + a.bottom) / 2 - h / 2 }
  }
  const fits = (p: { left: number; top: number }, s: HoverSide): boolean =>
    s === 'top' || s === 'bottom' ? p.top >= MARGIN && p.top + h <= vh - MARGIN : p.left >= MARGIN && p.left + w <= vw - MARGIN
  let s = side
  let p = at(s)
  if (!fits(p, s) && fits(at(flip[s]), flip[s])) { s = flip[s]; p = at(s) }
  const clamp = (v: number, size: number, max: number): number => Math.max(MARGIN, Math.min(v, max - size - MARGIN))
  return { left: clamp(p.left, w, vw), top: clamp(p.top, h, vh), side: s }
}

class HoverSurface {
  private el: HTMLDivElement | null = null
  private owner: HTMLElement | null = null
  private spec: HoverSpec | null = null
  private shown = false
  private waitTimer = 0
  private lingerTimer = 0
  private gen = 0
  /** 每真弹一次 +1:退场收尾只认自己那一次(收到一半又弹了 = 不摘)。 */
  private showSeq = 0
  /** 正在等延时 / 等内容的触发点。 */
  private pending: HTMLElement | null = null
  /** 按下过的触发点:指针还停在它上面就不再弹。 */
  private pressed: HTMLElement | null = null
  private ro: ResizeObserver | null = null
  constructor(private kind: Kind) {}

  /** 指针进入触发点。 */
  enter(trigger: HTMLElement, spec: HoverSpec): void {
    if (trigger === this.pressed) return
    window.clearTimeout(this.waitTimer)
    if (this.owner === trigger && this.shown) { window.clearTimeout(this.lingerTimer); this.el?.setAttribute('data-open', ''); return }
    const myGen = ++this.gen
    this.pending = trigger
    // 弹着(含退场途中 / 宽限里)→ 接力:直接换内容挪过去,不重播。
    if (this.shown) { void this.show(trigger, spec, myGen, true); return }
    this.waitTimer = window.setTimeout(() => void this.show(trigger, spec, myGen, false), ms(TOKENS[this.kind].delay))
  }

  /** 指针离开触发点。 */
  leave(trigger: HTMLElement): void {
    if (this.pressed === trigger) this.pressed = null
    if (trigger !== this.owner && trigger !== this.pending) return // 已经接力给别人了
    this.pending = null
    window.clearTimeout(this.waitTimer)
    this.gen++
    if (!this.shown) return
    window.clearTimeout(this.lingerTimer)
    this.lingerTimer = window.setTimeout(() => this.close(false), ms(TOKENS[this.kind].handoff))
  }

  /** 键盘聚焦:立刻出,不做动画。 */
  focus(trigger: HTMLElement, spec: HoverSpec): void {
    window.clearTimeout(this.waitTimer)
    this.pending = trigger
    void this.show(trigger, spec, ++this.gen, true)
  }

  /** 按下 / 失焦 / 滚动:立刻收。 */
  press(trigger: HTMLElement | null): void {
    this.pressed = trigger
    this.hide()
  }

  hide(): void {
    window.clearTimeout(this.waitTimer)
    this.gen++
    if (this.shown) this.close(true)
  }

  /** 触发点被拆掉 / 改了内容:只在它是当前主人时收。 */
  drop(trigger: HTMLElement): void {
    if (this.pressed === trigger) this.pressed = null
    if (this.pending === trigger) { window.clearTimeout(this.waitTimer); this.gen++; this.pending = null } // 还在等延时 / 等内容的也作废
    if (this.owner === trigger) this.hide()
  }

  isOwner(trigger: HTMLElement): boolean { return this.owner === trigger && this.shown }

  private async show(trigger: HTMLElement, spec: HoverSpec, myGen: number, instant: boolean): Promise<void> {
    if (!trigger.isConnected) return
    const r = (spec.rect ?? ((t) => t.getBoundingClientRect()))(trigger)
    // 等的这段时间里被滚出窗口(键盘焦点还在它身上)→ 不出。
    if (r.bottom < 0 || r.top > window.innerHeight) return
    const el = this.el ?? document.createElement('div')
    let ok: boolean
    try { ok = await spec.fill(el, () => myGen === this.gen) } catch { ok = false }
    if (myGen !== this.gen) return
    this.pending = null
    if (!ok) {
      // 接力到一个这次不出提示的元素(内容为空、让位给别的浮层)= 当成离开:宽限后照常退场,宽限里再移到有提示的照样接力。
      if (this.shown) { window.clearTimeout(this.lingerTimer); this.lingerTimer = window.setTimeout(() => this.close(false), ms(TOKENS[this.kind].handoff)) }
      return
    }
    window.clearTimeout(this.lingerTimer)
    // 换了主人才让上一份放手;同一个触发点(悬停之后又键盘聚焦)的两份 spec 共用一个 portal,放手会把刚填的内容清掉。
    if (this.spec && this.spec !== spec && this.owner !== trigger) this.spec.release?.()
    this.showSeq++
    this.owner = trigger
    this.spec = spec
    el.className = `${TOKENS[this.kind].cls}${spec.className ? ` ${spec.className}` : ''}`
    el.setAttribute('role', 'tooltip')
    // 接力 / 键盘:这一帧不过渡(挪位、出现都直接到位),下一帧还原,之后的退场照常动画。
    if (instant || this.shown) el.setAttribute('data-instant', '')
    if (!el.isConnected) document.body.appendChild(el)
    this.el = el
    this.place()
    el.setAttribute('data-open', '')
    this.shown = true
    if (el.hasAttribute('data-instant')) requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute('data-instant')))
    if (!this.ro) {
      // 内容异步长出来(React portal 下一次提交才落地)后重摆;滚动 / 改窗时锚点失效,直接收(瞬时浮层不做跟随)。
      this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.place()) : null
      this.ro?.observe(el)
      window.addEventListener('scroll', this.onScroll, true)
      window.addEventListener('resize', this.onScroll)
    }
  }

  private onScroll = (e: Event): void => {
    // 浮层自己里面的滚动(长悬停卡)不算。
    if (this.el && e.target instanceof Node && this.el.contains(e.target)) return
    this.hide()
  }

  private place(): void {
    const el = this.el
    const owner = this.owner
    if (!el || !owner?.isConnected || !this.spec) return
    const z = zoomOf(el)
    const a = (this.spec.rect ?? ((t) => t.getBoundingClientRect()))(owner)
    const p = placeHover(a, el.offsetWidth * z, el.offsetHeight * z, window.innerWidth, window.innerHeight, this.spec.side ?? 'top')
    el.style.left = `${p.left / z}px`
    el.style.top = `${p.top / z}px`
    el.dataset.side = p.side
  }

  private close(instant: boolean): void {
    const el = this.el
    window.clearTimeout(this.lingerTimer)
    this.shown = false
    if (!el) return
    if (instant) el.setAttribute('data-instant', '')
    el.removeAttribute('data-open')
    const seq = this.showSeq
    const done = (): void => {
      if (this.shown || seq !== this.showSeq) return // 退场途中又被叫回来了
      el.remove()
      el.removeAttribute('data-instant')
      this.spec?.release?.()
      this.owner = null
      this.spec = null
      this.ro?.disconnect()
      this.ro = null
      window.removeEventListener('scroll', this.onScroll, true)
      window.removeEventListener('resize', this.onScroll)
    }
    const anims = el.getAnimations?.() ?? []
    if (!anims.length) done()
    else void Promise.allSettled(anims.map((a) => a.finished)).then(done)
  }
}

export const tooltipSurface = new HoverSurface('tip')
export const hoverCardSurface = new HoverSurface('card')

// ---------------- 文字提示 ----------------

/** 一行或多行(第一行是标题,其余次要色);函数 = 到点才算(可异步),返回 null / 空 = 不弹。 */
export type TooltipLines = string | string[]
export type TooltipContent = TooltipLines | (() => TooltipLines | null | Promise<TooltipLines | null>)

export interface TooltipOptions {
  side?: HoverSide
  className?: string
  rect?: HoverSpec['rect']
  /** 键盘聚焦时也弹(缺省开)。 */
  focus?: boolean
}

function fillLines(content: TooltipContent): HoverSpec['fill'] {
  return async (el, alive) => {
    const v = typeof content === 'function' ? await content() : content
    if (!alive()) return false
    const lines = (Array.isArray(v) ? v : v ? [v] : []).filter((l) => typeof l === 'string' && l)
    if (!lines.length) return false
    el.replaceChildren(...lines.map((l, i) => {
      const d = document.createElement('div')
      d.textContent = l
      if (i === 0) d.className = 'lcl-tip-head'
      return d
    }))
    return true
  }
}

const tipSpec = (content: TooltipContent, o: TooltipOptions = {}): HoverSpec => ({ side: o.side, className: o.className, rect: o.rect, fill: fillLines(content) })

const keyboardFocus = (el: Element): boolean => {
  try { return el.matches(':focus-visible') } catch { return true } // 老内核不认伪类:按键盘处理
}

/** React:摊进触发元素的 props。 */
export function tooltipProps(content: TooltipContent, opts: TooltipOptions = {}): {
  onMouseEnter(e: { currentTarget: HTMLElement }): void
  onMouseLeave(e: { currentTarget: HTMLElement }): void
  onMouseDown(e: { currentTarget: HTMLElement }): void
  onFocus?(e: { currentTarget: HTMLElement }): void
  onBlur?(): void
} {
  const spec = (): HoverSpec => tipSpec(content, opts)
  const handlers = {
    onMouseEnter: (e: { currentTarget: HTMLElement }) => tooltipSurface.enter(e.currentTarget, spec()),
    onMouseLeave: (e: { currentTarget: HTMLElement }) => tooltipSurface.leave(e.currentTarget),
    onMouseDown: (e: { currentTarget: HTMLElement }) => tooltipSurface.press(e.currentTarget),
  }
  if (opts.focus === false) return handlers
  return {
    ...handlers,
    onFocus: (e: { currentTarget: HTMLElement }) => { if (keyboardFocus(e.currentTarget)) tooltipSurface.focus(e.currentTarget, spec()) },
    onBlur: () => tooltipSurface.hide(),
  }
}

/** 立刻收起当前提示(拖动开始、菜单弹出之类)。 */
export function hideTooltip(): void { tooltipSurface.hide() }

/** DOM:给一个元素挂提示,返回 update / dispose(插件经 ctx.ui.attachTooltip 用的就是这个)。 */
export function attachTooltip(el: HTMLElement, content: TooltipContent, opts: TooltipOptions = {}): { update(content: TooltipContent, opts?: TooltipOptions): void; dispose(): void } {
  let spec = tipSpec(content, opts)
  let focusOn = opts.focus !== false
  const enter = (): void => tooltipSurface.enter(el, spec)
  const leave = (): void => tooltipSurface.leave(el)
  const down = (): void => tooltipSurface.press(el)
  const focus = (): void => { if (focusOn && keyboardFocus(el)) tooltipSurface.focus(el, spec) }
  const blur = (): void => tooltipSurface.drop(el) // 含异步内容还没回来的那一次
  el.addEventListener('mouseenter', enter)
  el.addEventListener('mouseleave', leave)
  el.addEventListener('mousedown', down)
  el.addEventListener('focus', focus)
  el.addEventListener('blur', blur)
  return {
    update(next, nextOpts) {
      spec = tipSpec(next, nextOpts ?? opts)
      focusOn = (nextOpts ?? opts).focus !== false
      if (tooltipSurface.isOwner(el)) tooltipSurface.focus(el, spec) // 弹着就原地换字
    },
    dispose() {
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
      el.removeEventListener('mousedown', down)
      el.removeEventListener('focus', focus)
      el.removeEventListener('blur', blur)
      tooltipSurface.drop(el)
    },
  }
}

/** 事件委托:root 里凡是 selector 命中的元素都按 text(el) 出提示(Ribbon 认 [data-rb-tip])。
 *  enabled() 为假时不弹(拖动、菜单开着…),由调用方在状态变化时自己 hideTooltip()。 */
export function delegateTooltips(root: HTMLElement, o: TooltipOptions & { selector: string; text(el: HTMLElement): string | undefined; enabled?(): boolean }): () => void {
  let cur: HTMLElement | null = null
  const target = (e: Event): HTMLElement | null => (e.target instanceof Element ? e.target.closest<HTMLElement>(o.selector) : null)
  const spec = (el: HTMLElement): HoverSpec => tipSpec(() => o.text(el) ?? null, o)
  const over = (e: MouseEvent): void => {
    const el = target(e)
    if (el === cur) return
    if (cur) tooltipSurface.leave(cur)
    cur = el
    if (el && root.contains(el) && (o.enabled?.() ?? true)) tooltipSurface.enter(el, spec(el))
  }
  const out = (e: MouseEvent): void => {
    if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return
    if (cur) tooltipSurface.leave(cur)
    cur = null
  }
  const down = (e: MouseEvent): void => tooltipSurface.press(target(e))
  const focusin = (e: FocusEvent): void => {
    const el = target(e)
    if (el && keyboardFocus(el) && (o.enabled?.() ?? true)) tooltipSurface.focus(el, spec(el))
  }
  const focusout = (): void => tooltipSurface.hide()
  root.addEventListener('mouseover', over)
  root.addEventListener('mouseout', out)
  root.addEventListener('mousedown', down, true)
  if (o.focus !== false) { root.addEventListener('focusin', focusin); root.addEventListener('focusout', focusout) }
  return () => {
    root.removeEventListener('mouseover', over)
    root.removeEventListener('mouseout', out)
    root.removeEventListener('mousedown', down, true)
    root.removeEventListener('focusin', focusin)
    root.removeEventListener('focusout', focusout)
    if (cur) tooltipSurface.drop(cur)
  }
}
