import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { UI_ZOOM_EVENT, zoomOf } from '@lcl/engine/menuAnchor'

interface Props {
  anchorRef: RefObject<HTMLDivElement | null>
  enabled?: boolean
  onActivate?(): void
  children: ReactNode
}

const clips = /^(auto|scroll|hidden|clip)$/
const positive = (value: number, fallback = 1) => Number.isFinite(value) && value > 0 ? value : fallback
const px = (value: number) => `${Math.round(value * 1000) / 1000}px`

/**
 * Electron destroys a webview guest when ANY ancestor is detached. Dockview rebuilds
 * those ancestors even while React retains the same view. Keep this portal connected
 * to the shell for its entire lifetime; only its geometry follows the empty anchor.
 * Render the anchor before this component so its ref exists at the first layout effect.
 */
export function StudioGuestSurface({ anchorRef, enabled = true, onActivate, children }: Props) {
  const [surface] = useState(() => {
    const element = document.createElement('div')
    element.className = 'csu-guest-surface'
    element.setAttribute('aria-hidden', 'true')
    element.inert = true
    Object.assign(element.style, {
      position: 'absolute', display: 'flex', flexDirection: 'column',
      minWidth: '0', minHeight: '0', overflow: 'hidden', boxSizing: 'border-box',
      visibility: 'hidden', pointerEvents: 'none', zIndex: '1',
    })
    return element
  })
  const enabledRef = useRef(enabled); enabledRef.current = enabled
  const activateRef = useRef(onActivate); activateRef.current = onActivate
  const generation = useRef(0)
  const refreshRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    generation.current++
    let disposed = false
    let frame = 0
    let host: HTMLElement | null = surface.parentElement
    let observedAnchor: HTMLElement | null = null
    let ancestorInactive = false
    let focusInside = false
    const doc = surface.ownerDocument
    const view = doc.defaultView!
    const write = (property: Extract<keyof CSSStyleDeclaration, string>, value: string) => {
      if (surface.style[property] !== value) (surface.style as unknown as Record<string, string>)[property] = value
    }
    const hide = () => {
      write('visibility', 'hidden'); write('pointerEvents', 'none')
      if (!surface.inert) surface.inert = true
      if (surface.getAttribute('aria-hidden') !== 'true') surface.setAttribute('aria-hidden', 'true')
    }
    const syncInteraction = () => {
      // WorkspaceHost marks both tab moves and launcher drags on <html>. Its
      // drop resolver uses elementFromPoint().closest('.dv-groupview'); during
      // those drags let hits reach our anchor inside Dockview, keeping the guest
      // connected and painted. Inert also prevents descendants opting back in.
      const interactive = surface.style.visibility === 'visible' && enabledRef.current
        && !ancestorInactive && !doc.documentElement.hasAttribute('data-dv-dragging')
      write('pointerEvents', interactive ? 'auto' : 'none')
      if (surface.inert === interactive) surface.inert = !interactive
      const ariaHidden = interactive ? 'false' : 'true'
      if (surface.getAttribute('aria-hidden') !== ariaHidden) surface.setAttribute('aria-hidden', ariaHidden)
    }
    // The portal is outside Dockview's native focus-capture container. Preserve
    // panel activation without moving focus away from the guest or its inputs.
    const activate = () => {
      if (disposed || !enabledRef.current || doc.hidden || surface.inert
        || surface.style.visibility !== 'visible' || !anchorRef.current?.isConnected
        || anchorRef.current.closest('[hidden], [inert], [aria-hidden="true"]')
        || doc.documentElement.hasAttribute('data-dv-dragging')) return
      focusInside = surface.contains(doc.activeElement)
      activateRef.current?.()
    }
    const trackOutsideFocus = () => {
      if (!surface.contains(doc.activeElement)) focusInside = false
    }

    const update = (): boolean => {
      const anchor = anchorRef.current
      if (!anchor?.isConnected) { hide(); return false }
      if (!host) {
        host = anchor.closest<HTMLElement>('.shell-work') ?? anchor.closest<HTMLElement>('.shell-host') ?? doc.body
        // The fallback has no guaranteed positioned containing block.
        if (host === doc.body || view.getComputedStyle(host).position === 'static') write('position', 'fixed')
        host.appendChild(surface)
        resize?.observe(host)
      }
      if (observedAnchor !== anchor) {
        if (observedAnchor) resize?.unobserve(observedAnchor)
        resize?.observe(anchor); observedAnchor = anchor
      }
      if (!enabledRef.current || doc.hidden || !host.isConnected) { hide(); return false }

      const rect = anchor.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) { hide(); return false }
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top)
      let right = Math.min(view.innerWidth, rect.right), bottom = Math.min(view.innerHeight, rect.bottom)
      let opacity = 1
      let radius = ''
      ancestorInactive = false
      // A portal does not inherit the original pane's clipping, fade, inertness or
      // tab visibility. Reproduce them without changing its connected ancestry.
      for (let ancestor: HTMLElement | null = anchor; ancestor; ancestor = ancestor.parentElement) {
        const style = view.getComputedStyle(ancestor)
        if (ancestor.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
          hide(); return false
        }
        // Inertness removes interaction, not paint. A closing pane is inert at
        // once but remains visible for its opacity/width exit transition.
        if (ancestor.inert || ancestor.getAttribute('aria-hidden') === 'true') ancestorInactive = true
        if (ancestor !== host && !ancestor.contains(host)) opacity *= Number.parseFloat(style.opacity || '1')
        const paintContainment = /\b(paint|strict|content)\b/.test(style.contain)
        const clipX = paintContainment || clips.test(style.overflowX || style.overflow)
        const clipY = paintContainment || clips.test(style.overflowY || style.overflow)
        if (!clipX && !clipY) continue
        const bounds = ancestor.getBoundingClientRect()
        const scaleX = positive(bounds.width / ancestor.offsetWidth)
        const scaleY = positive(bounds.height / ancestor.offsetHeight)
        const edgeLeft = bounds.left + ancestor.clientLeft * scaleX
        const edgeTop = bounds.top + ancestor.clientTop * scaleY
        const edgeRight = edgeLeft + ancestor.clientWidth * scaleX
        const edgeBottom = edgeTop + ancestor.clientHeight * scaleY
        if (clipX) { left = Math.max(left, edgeLeft); right = Math.min(right, edgeRight) }
        if (clipY) { top = Math.max(top, edgeTop); bottom = Math.min(bottom, edgeBottom) }
        if (!radius && clipX && clipY && Math.abs(bounds.left - rect.left) < 1
          && Math.abs(bounds.top - rect.top) < 1 && Math.abs(bounds.right - rect.right) < 1
          && Math.abs(bounds.bottom - rect.bottom) < 1) radius = style.borderRadius
      }
      if (right <= left || bottom <= top) { hide(); return false }
      // A fade can start at exactly zero without a later DOM mutation. Keep
      // following it; inactive panes already stop above via visibility/inert.
      if (opacity <= 0) { hide(); return true }

      const hostRect = host.getBoundingClientRect()
      const cssZoom = positive(zoomOf(surface))
      const absolute = surface.style.position === 'absolute'
      // Relative to the stable shell's padding box. The rect/offset ratio includes
      // CSS zoom and the shell's onboarding scale animation without double scaling.
      const scaleX = absolute ? positive(hostRect.width / host.offsetWidth, cssZoom) : cssZoom
      const scaleY = absolute ? positive(hostRect.height / host.offsetHeight, cssZoom) : cssZoom
      write('left', px(absolute ? (rect.left - hostRect.left) / scaleX - host.clientLeft + host.scrollLeft : rect.left / scaleX))
      write('top', px(absolute ? (rect.top - hostRect.top) / scaleY - host.clientTop + host.scrollTop : rect.top / scaleY))
      write('width', px(rect.width / scaleX)); write('height', px(rect.height / scaleY))
      write('clipPath', `inset(${px((top - rect.top) / scaleY)} ${px((rect.right - right) / scaleX)} ${px((rect.bottom - bottom) / scaleY)} ${px((left - rect.left) / scaleX)})`)
      write('borderRadius', radius)
      write('opacity', String(opacity))
      write('visibility', 'visible'); syncInteraction()
      return true
    }
    const tick = () => {
      frame = 0
      if (disposed) return
      // Native panel tweens can move an anchor without resizing it. Track visible
      // surfaces each frame; hidden owners sleep until a DOM/resize/zoom wakeup.
      const following = update()
      // Electron's OOPIF changes activeElement to <webview> without dispatching
      // DOM focus/pointer events on it. Observe only the outside → inside edge;
      // repeated frames must never reactivate a panel or steal guest input focus.
      const inside = surface.contains(doc.activeElement)
      const entered = inside && !focusInside
      focusInside = inside
      if (entered) activate()
      if (following) frame = view.requestAnimationFrame(tick)
    }
    const refresh = () => { if (!disposed && !frame) frame = view.requestAnimationFrame(tick) }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh)
    const mutation = new MutationObserver(records => {
      // Update hit testing in this microtask, before the first dragover can ask
      // for a drop target. Removal on drop/dragend restores normal interaction.
      if (records.some(record => record.target === doc.documentElement && record.attributeName === 'data-dv-dragging')) syncInteraction()
      if (records.some(record => !surface.contains(record.target))) refresh()
    })
    mutation.observe(doc.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'inert', 'aria-hidden', 'data-dv-dragging'],
    })
    view.addEventListener('resize', refresh)
    doc.addEventListener('scroll', refresh, true)
    doc.addEventListener('visibilitychange', refresh)
    view.addEventListener(UI_ZOOM_EVENT, refresh)
    surface.addEventListener('focus', activate, true)
    surface.addEventListener('pointerdown', activate, true)
    doc.addEventListener('focus', trackOutsideFocus, true)
    refreshRef.current = () => { if (!enabledRef.current) hide(); refresh() }
    tick()
    return () => {
      disposed = true
      if (frame) view.cancelAnimationFrame(frame)
      resize?.disconnect(); mutation.disconnect()
      view.removeEventListener('resize', refresh)
      doc.removeEventListener('scroll', refresh, true)
      doc.removeEventListener('visibilitychange', refresh)
      view.removeEventListener(UI_ZOOM_EVENT, refresh)
      surface.removeEventListener('focus', activate, true)
      surface.removeEventListener('pointerdown', activate, true)
      doc.removeEventListener('focus', trackOutsideFocus, true)
      refreshRef.current = null
      hide()
      // StrictMode replays effects without unmounting the portal. A replay must
      // never detach an already connected guest; actual owner disposal still does.
      const cleanupGeneration = ++generation.current
      queueMicrotask(() => { if (generation.current === cleanupGeneration) surface.remove() })
    }
  }, [anchorRef, surface])

  useLayoutEffect(() => { refreshRef.current?.() }, [enabled])
  return createPortal(children, surface)
}
