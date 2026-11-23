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
  /** Pressed state (a toggle that is on, read-aloud while it speaks): `aria-pressed` + the `.on` look. */
  pressed?: boolean
  /** Items behind ⋯ only: a pin on the right of the row. `on` = it would sit on the bar if there were room. */
  pin?: { on: boolean; title: string; onToggle(): void }
  /** Right-click / context-menu key on a bar button: the host opens its own menu (anchor = the button). */
  onContextMenu?(anchor: HTMLElement): void
  onRun(): void
}

/** The line at the top of the ⋯ panel when some actions wanted the bar but had no room. */
export interface SelectionBarMoreNotice { text: string; action: string; onRun(): void }

/** A view's own tool: an icon button, a colour dot when `color` is set, icon + text when `label` is set. */
export interface SelectionBarTool {
  id: string
  title: string
  icon?: ReactNode
  color?: string
  label?: string
  on?: boolean
  /** Secondary trigger keeps the primary action intact and supplies a real anchor. */
  menu?: { title: string; onOpen(anchor: HTMLElement): void }
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

const Pin = ({ on }: { on: boolean }): React.ReactElement => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </svg>
)

const actionButton = (a: SelectionBarAction, group?: 'plugin'): React.ReactElement => (
  <button key={a.id} type="button" className={`selbar-btn selbar-act${a.lead ? ' lead' : ''}${a.pressed ? ' on' : ''}`} data-act={a.id} data-group={group} data-testid={a.testId}
    title={a.title} aria-pressed={a.pressed == null ? undefined : a.pressed} {...press(a.onRun)}
    onContextMenu={a.onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); a.onContextMenu!(e.currentTarget) } : undefined}>
    {a.icon}{a.label}
  </button>
)

/** The inside of the ⋯ panel: an optional "N more didn't fit · Manage" line, the host's own actions, then the plugin
 *  actions under `heading`. Every row runs on mousedown like the bar buttons; a row with `pin` gets a pin button on
 *  the right that toggles without running the action. The host draws the panel around it. */
export function SelectionBarMoreList({ host, plugins, heading, notice, onPicked, itemClass = 'selbar-menu-item' }: {
  host?: SelectionBarAction[]
  plugins: SelectionBarAction[]
  heading?: string
  notice?: SelectionBarMoreNotice
  /** Called before an item runs (close the panel). */
  onPicked(): void
  itemClass?: string
}): React.ReactElement {
  const row = (item: SelectionBarAction): React.ReactElement => (
    <div key={item.id} className="selbar-more-row" data-ai-row={item.id}>
      <button type="button" className={itemClass} role="menuitem" tabIndex={-1} data-ai={item.id} title={item.title} {...press(() => { onPicked(); item.onRun() })}>
        {item.icon}<span>{item.label}</span>
      </button>
      {item.pin && (
        <button type="button" className={`selbar-pin${item.pin.on ? ' on' : ''}`} tabIndex={-1} data-pin={item.id} title={item.pin.title} aria-label={item.pin.title} aria-pressed={item.pin.on}
          {...press(() => item.pin!.onToggle())}>
          <Pin on={item.pin.on} />
        </button>
      )}
    </div>
  )
  return (
    <>
      {notice && (
        <div className="selbar-notice" data-testid="selbar-overflow">
          <span>{notice.text}</span>
          <button type="button" className="selbar-notice-act" tabIndex={-1} data-act="manage" {...press(() => { onPicked(); notice.onRun() })}>{notice.action}</button>
        </div>
      )}
      {host?.map(row)}
      {heading && plugins.length > 0 && <div className="selbar-head">{heading}</div>}
      {plugins.map(row)}
    </>
  )
}

/** The shared action buttons, for hosts that draw their own toolbar row (the note editor). `plugins` sit after a
 *  divider (plugin actions placed on the bar); `more` adds the ⋯ button; the host owns the panel it opens. */
export function SelectionBarActions({ actions, plugins, more }: {
  actions: SelectionBarAction[]
  plugins?: SelectionBarAction[]
  more?: { label: string; open: boolean; onToggle(byKeyboard: boolean): void }
}): React.ReactElement {
  return (
    <>
      {actions.map((a) => actionButton(a))}
      {!!plugins?.length && <>{actions.length > 0 && <span className="selbar-sep" data-sep="plugins" />}{plugins.map((a) => actionButton(a, 'plugin'))}</>}
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
  // ⋯ 面板里:每行的钉不进方向键序(鼠标点;键盘用户在设置的管理表里改)
  const btns = [...box.querySelectorAll<HTMLElement>(inPanel ? '[role="menuitem"], .selbar-notice-act' : 'button')]
  const i = btns.indexOf(document.activeElement as HTMLElement)
  const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown'
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : i < 0 ? 0 : (i + (fwd ? 1 : -1) + btns.length) % btns.length
  e.preventDefault()
  e.stopPropagation()
  btns[next]?.focus()
}

/** The inside of a selection bar: one row (tools and actions, a divider between them) and the ⋯ panel under it.
 *  Put it in a positioned element carrying the `selbar` class; that element is the shell. */
export function SelectionBar({ tools, actions, plugins, more, moreHost, moreNotice, moreHeading, moreLabel, order = 'tools', onClose }: {
  tools?: SelectionBarTool[]
  actions: SelectionBarAction[]
  /** Plugin actions placed on the bar: after the shared actions, a divider between. */
  plugins?: SelectionBarAction[]
  /** Plugin actions behind ⋯ (under `moreHeading`). Empty or absent (and no `moreHost`): no ⋯ button. */
  more?: SelectionBarAction[]
  /** The host's own actions the user moved into ⋯ (above the plugins, no heading). */
  moreHost?: SelectionBarAction[]
  moreNotice?: SelectionBarMoreNotice
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
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open || !byKey.current) return
    byKey.current = false
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"], .selbar-notice-act')?.focus()
  }, [open])

  const hasMore = !!more?.length || !!moreHost?.length
  const toolEls = tools?.length ? tools.map((t) => {
    const menuKey = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (!t.menu || e.key !== 'ArrowRight') return
      e.preventDefault(); e.stopPropagation(); t.menu.onOpen(e.currentTarget)
    }
    const primary = t.color ? (
      <button type="button" className={`selbar-dot${t.on ? ' on' : ''}`} style={{ '--c': t.color } as CSSProperties} data-act={t.id} title={t.title} aria-label={t.title} aria-pressed={!!t.on} {...press(t.onRun)} onKeyDown={menuKey} />
    ) : (
      <button type="button" className={`selbar-btn${t.label ? ' selbar-act' : ''}${t.on ? ' on' : ''}`} data-act={t.id} title={t.title} aria-label={t.title} aria-pressed={t.on == null ? undefined : t.on} {...press(t.onRun)} onKeyDown={menuKey}>
        {t.icon}{t.label}
      </button>
    )
    return <span className={t.menu ? 'selbar-split' : 'selbar-tool'} key={t.id}>
      {primary}
      {t.menu && <button type="button" className="selbar-btn selbar-menu-trigger" data-menu-for={t.id} title={t.menu.title} aria-label={t.menu.title} aria-haspopup="menu"
        onMouseDown={(e) => { e.preventDefault(); if (e.button === 0) t.menu!.onOpen(e.currentTarget) }}
        onClick={(e) => { if (e.detail === 0) t.menu!.onOpen(e.currentTarget) }} onKeyDown={menuKey}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      </button>}
    </span>
  }) : null
  const actionEls = (
    <SelectionBarActions
      actions={actions}
      plugins={plugins}
      more={hasMore ? { label: moreLabel, open, onToggle: (k) => { byKey.current = k && !open; setOpen(!open) } } : undefined}
    />
  )
  const sep = toolEls && (actions.length > 0 || !!plugins?.length || hasMore) ? <span className="selbar-sep" /> : null

  return (
    <>
      <div className="selbar-row" ref={rowRef} onKeyDown={onNav}>
        {order === 'tools' ? <>{toolEls}{sep}{actionEls}</> : <>{actionEls}{sep}{toolEls}</>}
      </div>
      {open && hasMore && (
        <div className="selbar-panel" role="menu" aria-label={moreLabel} data-testid="selbar-more" ref={panelRef} onKeyDown={onNav} data-motion="enter">
          <SelectionBarMoreList host={moreHost} plugins={more ?? []} heading={moreHeading} notice={moreNotice} onPicked={() => setOpen(false)} />
        </div>
      )}
    </>
  )
}
