/** A transient extension of one mounted view. Presented in a real workbench panel; no permanent view registration or persisted content. */
export type ExtendViewSide = 'left' | 'right' | 'bottom'
export type ExtendViewCloseReason = 'dismiss' | 'close' | 'replace' | 'owner'

export interface ExtendViewHandle {
  readonly id: string
  readonly isOpen: boolean
  close(): void
}

export interface ExtendViewOptions {
  /** Reopening the same id focuses the existing extension and preserves its inputs. */
  id: string
  title: string | (() => string)
  side?: ExtendViewSide
  mount(el: HTMLElement, handle: ExtendViewHandle): void | (() => void)
  onClose?(reason: ExtendViewCloseReason): void
}

export interface ExtendViewController {
  open(options: ExtendViewOptions): ExtendViewHandle
  close(): void
}

export interface ExtendViewEntry {
  options: ExtendViewOptions
  handle: ExtendViewHandle
  revision: number
}

/** Owner-scoped store. Stale handles cannot close a replacement; disposed owners reject late work. */
export function createExtendViewController() {
  let entry: ExtendViewEntry | null = null
  let alive = true
  let visible = true
  let revision = 0
  const listeners = new Set<() => void>()
  const emit = (): void => listeners.forEach((fn) => fn())
  const close = (reason: ExtendViewCloseReason): void => {
    const prev = entry
    if (!prev) return
    entry = null
    emit()
    try { prev.options.onClose?.(reason) } catch (error) { console.error('[extend-view] onClose failed', error) }
  }
  const controller: ExtendViewController = {
    open(options) {
      if (!alive) throw new Error('Extend view owner is no longer mounted')
      if (!visible) throw new Error('Extend view owner is not visible')
      if (!options.id || typeof options.mount !== 'function') throw new Error('Extend view requires an id and mount')
      if (options.side && !['left', 'right', 'bottom'].includes(options.side)) throw new Error('Invalid extend view side')
      if (entry?.options.id === options.id) { entry = { ...entry, revision: ++revision }; emit(); return entry.handle }
      close('replace')
      // onClose may itself open an extension; the most recent request wins.
      if (!alive) throw new Error('Extend view owner is no longer mounted')
      if (entry) return entry.handle
      const handle: ExtendViewHandle = {
        id: options.id,
        get isOpen() { return entry?.handle === handle },
        close: () => { if (entry?.handle === handle) close('close') },
      }
      entry = { options: { ...options }, handle, revision: ++revision }
      emit()
      return handle
    },
    close: () => close('close'),
  }
  return {
    controller,
    getSnapshot: () => entry,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    dismiss: () => close('dismiss'),
    setVisible(value: boolean) { visible = value; if (!value) close('owner') },
    dispose() { alive = false; close('owner') },
  }
}

/** The platform creates a native transient leaf, retaining ordinary panel tabs and sizing.
 *  `host` is the owner's own frame, for presenters that stay inside the owner (side Views). */
export type ExtendViewPresenter = (options: ExtendViewOptions, dismiss: () => void, host?: HTMLElement) => {
  element: HTMLElement
  /** The platform surface already shows the title and a close control (named tabs, drawer bar). Otherwise the extension draws its own header. */
  titled?: boolean
  /** The extension replaces its owner in place: its header shows Back instead of Close. */
  back?: boolean
  activate?(): void
  /** `instant` = replaced by another extension (swap in place). Otherwise the platform may collapse the panel with a
   *  tween; when it returns a promise, the host keeps the content mounted until it resolves. */
  dispose(instant?: boolean): void | Promise<void>
}

/** Side Views (side panels, bottom panel, mobile drawer): the temporary View covers its owner — never a neighbour —
 *  and Back returns to it. The owner stays mounted underneath (hidden + inert), so its scroll and drafts survive. */
export const presentInlineExtension: ExtendViewPresenter = (_options, _dismiss, host) => {
  if (!host) throw new Error('Inline extend view requires its owner frame')
  const covered = [...host.children] // hidden by CSS (:has); inert keeps focus and screen readers out
  for (const el of covered) el.toggleAttribute('inert', true)
  const element = document.createElement('div')
  element.className = 'wb-extend-target wb-extend-inline'
  host.appendChild(element)
  return {
    element, back: true,
    dispose() { // ponytail: instant, no close tween; the owner reappears exactly as it was left
      for (const el of covered) el.removeAttribute('inert')
      element.remove()
    },
  }
}
