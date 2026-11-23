import { useEffect, type RefObject } from 'react'
import { zoomOf } from '@lcl/engine/menuAnchor'

/** Some platforms already put Shift + wheel on the x axis. Prefer that value when present. */
export function horizontalWheelDelta(event: WheelEvent, viewport: HTMLElement): number {
  if (event.ctrlKey || event.metaKey) return 0
  const mode = event.deltaMode
  const { deltaX, deltaY } = event
  const dx = event.shiftKey ? deltaX || deltaY : Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : 0
  if (!dx) return 0
  if (mode === WheelEvent.DOM_DELTA_LINE) return dx * (parseFloat(getComputedStyle(viewport).lineHeight) || 16)
  if (mode === WheelEvent.DOM_DELTA_PAGE) return dx * viewport.clientWidth
  return dx / zoomOf(viewport)
}

export function scrollFileOnShiftWheel(event: WheelEvent, viewport: HTMLElement): void {
  if (!event.shiftKey || event.defaultPrevented) return
  const dx = horizontalWheelDelta(event, viewport)
  if (!dx) return
  event.preventDefault()
  viewport.scrollBy(dx, 0)
}

/** Side-by-side diffs and other previews can have their own scroller inside the file pane. */
function scrollTarget(target: Element, pane: HTMLElement): HTMLElement {
  for (let el: Element | null = target; el && el !== pane; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth) continue
    const { overflowX } = getComputedStyle(el)
    if (overflowX === 'auto' || overflowX === 'scroll') return el
  }
  return pane
}

export function useFileShiftWheel(ref: RefObject<HTMLElement | null>, selector?: string): void {
  useEffect(() => {
    const host = ref.current
    if (!host) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.shiftKey || !(event.target instanceof Element)) return
      const pane = selector ? event.target.closest<HTMLElement>(selector) : host
      if (pane && host.contains(pane)) scrollFileOnShiftWheel(event, scrollTarget(event.target, pane))
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [ref, selector])
}
