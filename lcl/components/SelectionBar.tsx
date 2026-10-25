/** Selection bar: the strip that pops up over selected text inside a View. Presentational only —
 *  the host tracks the selection, places the bar and decides what every button does. */
import React, { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import './selectionBar.css'

export interface SelectionBarAction {
  /** Becomes `data-act` (bar buttons) / `data-ai` (items behind ⋯). */
  id: string
  label: string
  icon?: ReactNode
  /** The first "take it to chat" action: accent ink, medium weight. */
  lead?: boolean
  title?: string
  testId?: string
  onRun(): void
}

/** A view's own tool: an icon button, a colour dot when `color` is set, icon + text when `label` is set. */
export interface SelectionBarTool {
  id: string
  title: string
  icon?: ReactNode
  color?: string
  label?: string
  on?: boolean
  onRun(): void
}

/** Which block comes first: the view's own tools, or the actions every view shares. */
export type SelectionBarOrder = 'tools' | 'actions'

/** Pointer users act on mousedown (preventDefault keeps the selection and the focus where they are);
 *  a click with detail 0 is Enter / Space. The two never both fire for one press.
 *  Only the primary button acts: a right or middle press keeps the selection but runs nothing. */
function press(fn: () => void): { onMouseDown(e: ReactMouseEvent): void; onClick(e: ReactMouseEvent): void } {
  return {
    onMouseDown: (e) => { e.preventDefault(); if (e.button === 0) fn() },
    onClick: (e) => { if (e.detail === 0) fn() },
  }
}

const Ellipsis = (): React.ReactElement => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
  </svg>
)

/** The shared action buttons, for hosts that draw their own toolbar row (the note editor). `more` adds the ⋯
 *  button; the host owns the panel it opens. */
export function SelectionBarActions({ actions, more }: {
  actions: SelectionBarAction[]
  more?: { label: string; open: boolean; onToggle(byKeyboard: boolean): void }
}): React.ReactElement {
  return (
    <>
      {actions.map((a) => (
        <button key={a.id} type="button" className={`selbar-btn selbar-act${a.lead ? ' lead' : ''}`} data-act={a.id} data-testid={a.testId} title={a.title} {...press(a.onRun)}>
          {a.icon}{a.label}
        </button>
      ))}
      {more && (
        <button
          type="button"
          className="selbar-btn"
          data-act="more"
          data-panel="more"
          title={more.label}
          aria-label={more.label}
          aria-haspopup="menu"
          aria-expanded={more.open}
          {...press(() => more.onToggle(false))}
          onClick={(e) => { if (e.detail === 0) more.onToggle(true) }}
        >
          <Ellipsis />
        </button>
      )}
    </>
  )
}

/** Arrow keys between the buttons of a row, up / down inside the ⋯ panel. */
function onNav(e: ReactKeyboardEvent<HTMLDivElement>): void {
  const box = e.currentTarget
  const inPanel = box.classList.contains('selbar-panel')
  const keys = inPanel ? ['ArrowDown', 'ArrowUp', 'Home', 'End'] : ['ArrowRight', 'ArrowLeft', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const btns = [...box.querySelectorAll<HTMLElement>('button')]
  const i = btns.indexOf(document.activeElement as HTMLElement)
  const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown'
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : i < 0 ? 0 : (i + (fwd ? 1 : -1) + btns.length) % btns.length
  e.preventDefault()
  e.stopPropagation()
  btns[next]?.focus()
}

/** The inside of a selection bar: one row (tools and actions, a divider between them) and the ⋯ panel under it.
 *  Put it in a positioned element carrying the `selbar` class; that element is the shell. */
export function SelectionBar({ tools, actions, more, moreHeading, moreLabel, order = 'tools', onClose }: {
  tools?: SelectionBarTool[]
  actions: SelectionBarAction[]
  /** What ⋯ holds. Empty or absent: no ⋯ button. */
  more?: SelectionBarAction[]
  moreHeading?: string
  moreLabel: string
  order?: SelectionBarOrder
  /** Escape, when the ⋯ panel is not what it closes. */
  onClose?: () => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const byKey = useRef(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      // Someone is typing elsewhere (a command palette, a search box opened over the view): Escape is theirs.
      const a = document.activeElement
      const bar = rowRef.current?.parentElement
      if (a && !bar?.contains(a) && a.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      e.preventDefault()
      e.stopPropagation()
      if (open) {
        setOpen(false)
        if (panelRef.current?.contains(document.activeElement)) rowRef.current?.querySelector<HTMLElement>('[data-panel="more"]')?.focus()
        return
      }
      onClose?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  useEffect(() => {
    if (!open || !byKey.current) return
    byKey.current = false
    panelRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [open])

  const hasMore = !!more?.length
  const toolEls = tools?.length ? tools.map((t) => t.color ? (
    <button key={t.id} type="button" className={`selbar-dot${t.on ? ' on' : ''}`} style={{ '--c': t.color } as CSSProperties} data-act={t.id} title={t.title} aria-label={t.title} aria-pressed={!!t.on} {...press(t.onRun)} />
  ) : (
    <button key={t.id} type="button" className={`selbar-btn${t.label ? ' selbar-act' : ''}${t.on ? ' on' : ''}`} data-act={t.id} title={t.title} aria-label={t.title} aria-pressed={t.on == null ? undefined : t.on} {...press(t.onRun)}>
      {t.icon}{t.label}
    </button>
  )) : null
  const actionEls = (
    <SelectionBarActions
      actions={actions}
      more={hasMore ? { label: moreLabel, open, onToggle: (k) => { byKey.current = k && !open; setOpen(!open) } } : undefined}
    />
  )
  const sep = toolEls && (actions.length > 0 || hasMore) ? <span className="selbar-sep" /> : null

  return (
    <>
      <div className="selbar-row" ref={rowRef} onKeyDown={onNav}>
        {order === 'tools' ? <>{toolEls}{sep}{actionEls}</> : <>{actionEls}{sep}{toolEls}</>}
      </div>
      {open && hasMore && (
        <div className="selbar-panel" role="menu" aria-label={moreLabel} data-testid="selbar-more" ref={panelRef} onKeyDown={onNav} data-motion="enter">
          {moreHeading && <div className="selbar-head">{moreHeading}</div>}
          {more!.map((item) => (
            <button key={item.id} type="button" className="selbar-menu-item" role="menuitem" tabIndex={-1} data-ai={item.id} title={item.title} {...press(() => { setOpen(false); item.onRun() })}>
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
