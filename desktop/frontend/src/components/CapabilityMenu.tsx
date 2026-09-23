import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { isCoarsePointer } from '../touch'
import './capabilityMenu.css'

export type CapabilityMenuItem = { id: string; label: string; icon?: ReactNode; selected?: boolean; disabled?: boolean; danger?: boolean; onSelect: () => void }

/** Shared action/selection menu for capability settings, in the same overlay layer as the workbench. */
export function CapabilityMenu({ label, children, items, className = 'capability-menu-trigger', searchLabel, selection = false, disabled = false }: {
  label: string; children?: ReactNode; items: CapabilityMenuItem[]; className?: string; searchLabel?: string; selection?: boolean; disabled?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number; top: number } | null>(null)
  const [query, setQuery] = useState('')
  const close = (restore = true) => { setAnchor(null); setQuery(''); if (restore && trigger.current?.isConnected) trigger.current.focus() }
  const open = () => { const r = trigger.current?.getBoundingClientRect(); if (r) setAnchor({ x: r.left, y: r.bottom + 4, top: r.top }) }
  useEffect(() => {
    if (!anchor) return
    const down = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false) }
    const reposition = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return
      const rect = trigger.current?.getBoundingClientRect()
      // Opening/focusing a portal can queue a scroll event without moving the anchor.
      if (!rect || !trigger.current?.isConnected) { close(false); return }
      if (Math.abs(rect.left - anchor.x) > 1 || Math.abs(rect.bottom + 4 - anchor.y) > 1) setAnchor({ x: rect.left, y: rect.bottom + 4, top: rect.top })
    }
    document.addEventListener('pointerdown', down)
    window.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)
    return () => { document.removeEventListener('pointerdown', down); window.removeEventListener('resize', reposition); document.removeEventListener('scroll', reposition, true) }
  }, [anchor])
  useEffect(() => {
    if (!anchor || isCoarsePointer()) return
    const el = menu.current
    ;(el?.querySelector<HTMLInputElement>('input') || el?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled), button:not(:disabled)'))?.focus({ preventScroll: true })
  }, [!!anchor])
  const visible = items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()))
  return <>
    <button ref={trigger} type="button" className={className} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!anchor} aria-controls={anchor ? id : undefined} disabled={disabled}
      onClick={() => anchor ? close() : open()} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open() } }}>
      {children || <><span>{label}</span><ChevronDown size={13} /></>}
    </button>
    {anchor && createPortal(<div className="ui-popover-backdrop" style={{ pointerEvents: 'none' }}><OverlayAt style={{ pointerEvents: 'auto' }} x={anchor.x} y={anchor.y} anchorTop={anchor.top} innerRef={(el) => { menu.current = el }} id={id}
      className={`ui-popover capability-menu${selection ? ' capability-menu-selection' : ''}`} role="menu" aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
        if (event.key === 'Tab') { close(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        if (event.target instanceof HTMLInputElement && ['Home', 'End'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}>
      {searchLabel && <label className="capability-menu-search"><Search size={14} /><input aria-label={searchLabel} placeholder={searchLabel} value={query} onChange={(e) => setQuery(e.target.value)} /></label>}
      <div className="capability-menu-items">{visible.map((item) => <button key={item.id} type="button" role={selection ? 'menuitemradio' : 'menuitem'} aria-checked={selection ? !!item.selected : undefined} disabled={item.disabled} className={item.danger ? 'danger' : ''}
        onClick={() => { close(); item.onSelect() }}><span className="capability-menu-icon">{item.icon}</span><span>{item.label}</span>{item.selected && <Check size={14} />}</button>)}</div>
    </OverlayAt></div>, document.body)}
  </>
}
