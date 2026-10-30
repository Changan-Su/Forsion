import React, { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, X } from 'lucide-react'
import { OverlayAt, UI_ZOOM_EVENT, useExitGhost } from '@lcl/engine'
import { useI18n } from '../i18n'

/** Match the Chat Box content-box queries; native phone chrome keeps its own layout. */
export function useComposerLayout(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const card = ref.current?.closest<HTMLElement>('.t2c-card')
    if (!card || card.classList.contains('t2c-card--phone')) return
    const update = () => {
      const style = getComputedStyle(card)
      const next = card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      setWidth(prev => prev === next ? prev : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(card)
    return () => observer.disconnect()
  }, [ref])
  return { compact: width !== null && width <= 480, tight: width !== null && width <= 260 }
}

/** A background menu must not intercept Escape from a newer dialog or search. */
export function composerMenuHasFocus(menu: HTMLElement | null, trigger: HTMLElement | null): boolean {
  return !!(menu?.contains(document.activeElement) || trigger?.contains(document.activeElement))
}

/** One surface for compact composer menus. Placement and zoom stay owned by LCL. */
export function ComposerMenuSurface({ portal, compact = true, anchorRef, innerRef, className = '', style, children }: {
  portal: boolean
  compact?: boolean
  anchorRef: RefObject<HTMLElement | null>
  innerRef?: (el: HTMLDivElement | null) => void
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}) {
  const [anchor, setAnchor] = useState({ x: 0, y: 0, top: 0 })
  const local = React.useRef<HTMLDivElement>(null)
  useExitGhost(local, !portal)
  const boundary = anchorRef.current?.closest<HTMLElement>('.t2-chat-view, .wb-view')
  useLayoutEffect(() => {
    const surface = local.current
    if (!portal || !surface) return
    const trigger = anchorRef.current?.querySelector<HTMLElement>('button')
    const first = [...surface.querySelectorAll<HTMLElement>('button.cm-row:not([tabindex="-1"]):not(:disabled),button.menu-item:not(:disabled),input:not(:disabled)')]
      .find(el => el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
    ;(first || surface.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true })
    return () => {
      if (surface.contains(document.activeElement) || document.activeElement === document.body) trigger?.focus({ preventScroll: true })
    }
  }, [portal, anchorRef])
  useLayoutEffect(() => {
    if (!portal) return
    const update = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setAnchor(prev => prev.x === r.left && prev.y === r.bottom + 8 && prev.top === r.top - 8
        ? prev : { x: r.left, y: r.bottom + 8, top: r.top - 8 })
    }
    update()
    const observer = new ResizeObserver(update)
    if (anchorRef.current) observer.observe(anchorRef.current)
    if (boundary) observer.observe(boundary)
    window.addEventListener('resize', update)
    window.addEventListener(UI_ZOOM_EVENT, update)
    document.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener(UI_ZOOM_EVENT, update)
      document.removeEventListener('scroll', update, true)
    }
  }, [portal, anchorRef, boundary])
  const navigate = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.target instanceof HTMLInputElement) return
    const buttons = [...(local.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([tabindex="-1"])') || [])]
      .filter(el => el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    event.preventDefault()
    buttons[(current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }
  if (!portal) return <div ref={el => { local.current = el; innerRef?.(el) }} className={className} style={style}>{children}</div>
  return createPortal(<div className="ui-popover-backdrop" style={{ pointerEvents: 'none' }} data-cmenu>
    <OverlayAt x={anchor.x} y={anchor.y} anchorTop={anchor.top} prefer="above" boundary={compact ? boundary : undefined}
      innerRef={el => { local.current = el; innerRef?.(el) }} onKeyDown={compact ? navigate : undefined}
      className={`${className} composer-menu--portal${compact ? ' composer-menu--compact' : ''}`}>
      {children}
    </OverlayAt>
  </div>, document.body)
}

export function ComposerMenuHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  const { t } = useI18n()
  return <div className="composer-menu-header">
    {onBack ? <button type="button" className="composer-menu-back" onClick={onBack} aria-label={t('common.back')}><ChevronLeft size={14} />{title}</button> : <span>{title}</span>}
    <button type="button" onClick={onClose} aria-label={t('common.close')}><X size={14} /></button>
  </div>
}
