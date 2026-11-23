import { useEffect, type RefObject } from 'react'
import { zoomOf } from '@lcl/engine/menuAnchor'

/** Some platforms already put Shift + wheel on the x axis. Prefer that value when present. */
export function horizontalWheelDelta(event: WheelEvent, viewport: HTMLElement): number {
  if (event.ctrlKey || event.metaKey) return 0
  const mode = event.deltaMode
  const dx = event.shiftKey ? event.deltaX || event.deltaY : event.deltaY ? 0 : event.deltaX
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

export function useFileShiftWheel(ref: RefObject<HTMLElement | null>, selector?: string): void {
  useEffect(() => {
    const host = ref.current
    if (!host) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.shiftKey) return
      const viewport = selector && event.target instanceof Element
        ? event.target.closest<HTMLElement>(selector)
        : host
      if (viewport && host.contains(viewport)) scrollFileOnShiftWheel(event, viewport)
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [ref, selector])
}
