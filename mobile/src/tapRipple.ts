/** 触屏按压的水波纹(Android App 里装;2026-10-13 用户实报「没有那种原生安卓的触感」)。
 *
 *  之前的按压反馈是整块变灰(base.css 的 inset box-shadow 状态层)。Android 自己的是从手指落点散开的一圈,
 *  铺满后停住,松手淡出。这里照这个做,画在一张盖在被按元素上的浮层里:
 *  · 不碰被按元素自己的样式(不改 position / overflow / 背景),所以任何能按的东西都能套,不会挤坏谁的布局;
 *  · 动的只有 transform / opacity(Web Animations),在合成线程上跑,主线程忙着切页时照样走得动;
 *  · 浮层只有一张,挂在 <html> 下(DESIGN §7:常驻的辅助元素不放 <body> 下)。
 *  哪些元素算「能按」与 base.css 那条状态层规则是同一份名单;装上后由 `html[data-ripple]` 把那条整块变灰关掉。
 *
 *  ⚠️ 在能滚的容器里先等 80ms 再画(Android 的 tap timeout 同款):手指一落就画的话,每次滑列表起手那一行都闪一下。
 *     80ms 内抬手 = 一次快点,立刻补画;80ms 内滑走 / 被系统收走 = 不画。
 *  ⚠️ 坐标:祖先上有 CSS zoom(整页 1.15)。新内核(有 currentCSSZoom)getBoundingClientRect 给的就是屏上的位置;
 *     老内核给的是缩放前的,要自己乘回累计缩放 —— 手机上的 WebView 版本参差,两种都得对。圆角两种内核都要乘。 */
const MATCH = "button, a, summary, [role='button'], [role='tab'], [role='menuitem'], [role='option']"
const ARM_MS = 80 // 能滚的容器里:等这么久再画
const SLOP = 8 // 等的时候手指挪出这么远(px)= 在滑,不画
const GROW_MS = 260
const FADE_MS = 200
const TINT = 'rgba(128, 128, 128, 0.2)' // 与 base.css 状态层同一个灰:亮暗两种底上都看得见

let installed = false
export function installTapRipple(): void {
  if (installed || typeof document === 'undefined' || typeof Element.prototype.animate !== 'function') return
  installed = true
  const box = document.createElement('div')
  box.className = 'tap-ripple'
  box.setAttribute('aria-hidden', 'true')
  box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;z-index:2147483646;display:none;contain:strict'
  const dot = document.createElement('i')
  dot.style.cssText = `position:absolute;border-radius:50%;background:${TINT};will-change:transform`
  box.appendChild(dot)
  document.documentElement.appendChild(box)
  document.documentElement.dataset.ripple = ''

  const modern = 'currentCSSZoom' in Element.prototype
  /** 这个元素在不在能滚的容器里,以及它的累计 CSS 缩放(一趟祖先走完两件事)。 */
  const survey = (el: Element): { scrolls: boolean; zoom: number } => {
    let scrolls = false
    let zoom = 1
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (!modern) zoom *= parseFloat(cs.zoom) || 1
      if (!scrolls && a !== el && ((/auto|scroll/.test(cs.overflowY) && a.scrollHeight > a.clientHeight + 1) || (/auto|scroll/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1))) scrolls = true
      if (modern && scrolls) break
    }
    return { scrolls, zoom: modern ? (el as Element & { currentCSSZoom?: number }).currentCSSZoom || 1 : zoom }
  }

  type Press = { el: Element; x: number; y: number; zoom: number; timer: number; shownAt: number }
  let cur: Press | null = null
  let fade: Animation | null = null

  const show = (p: Press): void => {
    p.timer = 0
    if (!p.el.isConnected) { cur = null; return }
    const r = p.el.getBoundingClientRect()
    const k = modern ? 1 : p.zoom // 老内核:量出来的是缩放前的,乘回去才是屏上的位置
    const left = r.left * k, top = r.top * k, w = r.width * k, h = r.height * k
    if (w < 1 || h < 1) { cur = null; return }
    const radius = Math.min((parseFloat(getComputedStyle(p.el).borderTopLeftRadius) || 0) * p.zoom, Math.min(w, h) / 2)
    fade?.cancel(); fade = null
    box.style.left = `${left}px`; box.style.top = `${top}px`; box.style.width = `${w}px`; box.style.height = `${h}px`
    box.style.borderRadius = `${radius}px`
    box.style.display = 'block'
    // 圆心在落点,半径够到最远的那个角
    const cx = Math.min(Math.max(p.x - left, 0), w), cy = Math.min(Math.max(p.y - top, 0), h)
    const reach = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
    dot.style.left = `${cx - reach}px`; dot.style.top = `${cy - reach}px`; dot.style.width = dot.style.height = `${reach * 2}px`
    dot.getAnimations().forEach((a) => a.cancel())
    dot.animate([{ transform: 'scale(0.12)' }, { transform: 'scale(1)' }], { duration: GROW_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' })
    p.shownAt = performance.now()
  }
  const release = (p: Press): void => {
    // 快点一下也让它散开一会儿再淡,不然只看得到一个点
    const held = performance.now() - p.shownAt
    const mine = fade = box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, delay: Math.max(0, GROW_MS * 0.6 - held), fill: 'forwards' })
    mine.onfinish = () => { if (fade === mine) { box.style.display = 'none'; mine.cancel(); fade = null } }
  }
  const end = (drawn: boolean): void => {
    const p = cur
    cur = null
    if (!p) return
    if (p.timer) { window.clearTimeout(p.timer); if (!drawn) return; show(p); if (!p.shownAt) return }
    release(p)
  }

  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return
    end(false)
    const el = (e.target as Element | null)?.closest?.(MATCH)
    if (!el || el.matches(':disabled, [aria-disabled="true"]')) return
    const { scrolls, zoom } = survey(el)
    const p: Press = cur = { el, x: e.clientX, y: e.clientY, zoom, timer: 0, shownAt: 0 }
    if (scrolls) p.timer = window.setTimeout(() => { if (cur === p) show(p) }, ARM_MS)
    else show(p)
  }, { capture: true, passive: true })
  window.addEventListener('pointermove', (e) => {
    if (cur?.timer && e.isPrimary && Math.hypot(e.clientX - cur.x, e.clientY - cur.y) > SLOP) end(false)
  }, { capture: true, passive: true })
  window.addEventListener('pointerup', (e) => { if (e.isPrimary) end(true) }, { capture: true, passive: true })
  window.addEventListener('pointercancel', (e) => { if (e.isPrimary) end(false) }, { capture: true, passive: true })
}
