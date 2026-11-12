/** Calendar cards may cross workbench dividers. Render above the shell, but stay owned by the source view. */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function CalendarOverlay({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const marker = useRef<HTMLSpanElement>(null)
  const [host] = useState(() => {
    const layer = document.createElement('div')
    layer.className = 'amadeus-root am-app tangu-lovable'
    layer.dataset.calendarOverlay = ''
    return layer
  })
  useLayoutEffect(() => {
    const source = marker.current?.parentElement
    if (!enabled || !source) return
    const doc = source.ownerDocument
    const sync = (): void => {
      host.style.display = source.isConnected && source.getClientRects().length ? 'contents' : 'none'
      host.dataset.mode = doc.documentElement.dataset.mode ?? 'light'
    }
    sync()
    doc.body.append(host)
    // Dockview detaches inactive views without unmounting them; a body portal must hide along with its owner.
    const size = new ResizeObserver(sync)
    size.observe(source)
    const theme = new MutationObserver(sync)
    theme.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
    return () => { size.disconnect(); theme.disconnect(); host.remove() }
  }, [enabled, host])
  return enabled ? <><span hidden ref={marker} />{createPortal(children, host)}</> : children
}
