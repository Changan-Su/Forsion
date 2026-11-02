// 手机上按住事件块 LONG_PRESS_MS 才进拖动(没选中的事件也行,不必先点一下再拖)。
// 按住期间手指一挪(> SLOP)就放手给页面滚动;到点后:吞掉后续 touchmove(页面不跟着滚,也就不会 pointercancel 掉拖动)、
// 吞掉长按带出来的 contextmenu / 系统菜单,以及松手后紧跟的那一下 click(否则「开卡」会被点两次)。
import type { PointerEvent as ReactPointerEvent } from 'react'

export const LONG_PRESS_MS = 400
const SLOP = 8

/** 长按到点、正在拖的那个事件块。 */
let holding: HTMLElement | null = null
const blockScroll = (ev: TouchEvent): void => { if (holding && ev.cancelable && holding.contains(ev.target as Node)) ev.preventDefault() }
const armed = new WeakSet<HTMLElement>()

/** 事件块的 ref:非被动 touchmove 必须在 touchstart **之前**就挂着 —— 浏览器在按下那一刻就定了这串触摸能不能拦,
 *  按下后再挂拦不住滚动。只挂在事件块上(不挂整个日历),别的地方滚动不必等主线程。 */
export function longPressTarget(el: HTMLElement | null): void {
  if (!el || armed.has(el)) return
  armed.add(el)
  el.addEventListener('touchmove', blockScroll, { passive: false })
}

/** 在 pointerdown 里调。fire 在长按到点时调用(此刻指针仍按着,可以 setPointerCapture)。 */
export function armLongPress(e: ReactPointerEvent, fire: (pointerId: number) => void): void {
  const el = e.currentTarget as HTMLElement
  const pid = e.pointerId
  const x0 = e.clientX
  const y0 = e.clientY
  let fired = false
  // 先把指针捕获到事件块本身:触摸的隐式捕获在里层 span 上,到点再转交会让 span 冒出 lostpointercapture,把这次拖动当场撤掉。
  try { el.setPointerCapture(pid) } catch { /* 指针已不在(极少):照旧走定时器,end 会收拾 */ }
  const timer = window.setTimeout(() => {
    if (!el.isConnected) { detach(); return } // 按住期间事件块被换掉(切视图 / 数据刷新)
    fired = true
    holding = el
    navigator.vibrate?.(10)
    fire(pid)
  }, LONG_PRESS_MS)
  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId === pid && !fired && Math.hypot(ev.clientX - x0, ev.clientY - y0) > SLOP) end(ev)
  }
  // 长按带出的 contextmenu 别冒到日历根(那儿会开事件菜单 / 抽屉)
  const onCtx = (ev: Event): void => { ev.preventDefault(); ev.stopPropagation() }
  const onClick = (ev: Event): void => { if (fired) { ev.preventDefault(); ev.stopPropagation() } }
  const end = (ev: PointerEvent): void => {
    if (ev.pointerId !== pid) return
    if (ev.type === 'lostpointercapture' && ev.target !== el) return // 里层 span 交出隐式捕获,不是松手
    detach()
  }
  const detach = (): void => {
    window.clearTimeout(timer)
    if (holding === el) holding = null
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', end)
    el.removeEventListener('pointercancel', end)
    el.removeEventListener('lostpointercapture', end)
    // click / contextmenu 在 pointerup 之后才到,多留一会儿再摘
    window.setTimeout(() => {
      el.removeEventListener('contextmenu', onCtx)
      el.removeEventListener('click', onClick, true)
    }, 400)
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  el.addEventListener('lostpointercapture', end)
  el.addEventListener('contextmenu', onCtx)
  el.addEventListener('click', onClick, true)
}
