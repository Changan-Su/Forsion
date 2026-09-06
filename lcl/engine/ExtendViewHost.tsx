import React, { useEffect, useLayoutEffect, useRef, useMemo, useSyncExternalStore, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { createExtendViewController, type ExtendViewController, type ExtendViewEntry, type ExtendViewPresenter } from './extendView'
import { useEngineI18n } from './i18nSeam'
import './extendView.css'

// Disabling a submitting button can move focus to body. Remember the interacted owner so Esc
// still dismisses that editor, without closing every extension in a split workspace.
let lastInteractedOwner: HTMLElement | null = null

function Extension({ entry, titled, onDismiss }: { entry: ExtendViewEntry; titled: boolean; onDismiss(): void }) {
  const { t } = useEngineI18n()
  const body = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const options = entry.options
  const title = typeof options.title === 'function' ? options.title() : options.title
  useLayoutEffect(() => {
    // A fresh mount target prevents a plugin's deferred React cleanup touching its successor.
    const el = document.createElement('div')
    el.className = 'wb-extend-mount'
    body.current!.appendChild(el)
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let cleanup: void | (() => void)
    try { cleanup = options.mount(el, entry.handle) } catch (error) {
      console.error('[extend-view] mount failed', error)
      el.textContent = t('extendView.failed')
    }
    return () => {
      const restore = panel.current?.contains(document.activeElement) || document.activeElement === document.body
      try { cleanup?.() } catch (error) { console.error('[extend-view] cleanup failed', error) }
      queueMicrotask(() => el.remove())
      // React puts its pre-commit focus (body, once the panel is gone) back right after this cleanup; return to the
      // opener after that, and only if nothing else has taken focus meanwhile.
      if (restore && previousFocus?.isConnected) queueMicrotask(() => {
        if (previousFocus.isConnected && (!document.activeElement || document.activeElement === document.body)) previousFocus.focus({ preventScroll: true })
      })
    }
    // Mount lifetime follows the handle; locale changes must not erase a form draft.
  }, [entry.handle]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const target = body.current?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')
    ;(target ?? panel.current)?.focus({ preventScroll: true })
  }, [entry.revision])
  const side = options.side ?? 'right'
  // Left/right tab groups are icon-only, so the extension names and closes itself; bottom tabs and the drawer bar already do.
  return <section ref={panel} tabIndex={-1} role="dialog" aria-label={title} className="wb-extend" data-side={side}>
    {!titled && <header className="wb-extend-head">
      <span className="wb-extend-title">{title}</span>
      <button type="button" className="wb-extend-close" title={t('extendView.close')} aria-label={t('extendView.close')} onClick={onDismiss}><X size={14} /></button>
    </header>}
    <div ref={body} className="wb-extend-body" />
  </section>
}

/** Ownership stays with the main view; rendering is portalled into the actual workbench panel. */
export function ExtendViewHost({ children, present, owner, ownerKey = '' }: { present: ExtendViewPresenter; owner?: { readonly isVisible: boolean; onDidVisibilityChange(listener: () => void): { dispose(): void } }; ownerKey?: string; children(controller: ExtendViewController): ReactNode }) {
  const store = useMemo(createExtendViewController, [ownerKey])
  const lifetime = useMemo(() => ({ generation: 0 }), [store])
  const ref = useRef<HTMLDivElement>(null)
  const entry = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const leaseRef = useRef<ReturnType<ExtendViewPresenter> | null>(null)
  const [leaseTarget, setTarget] = useState<{ element: HTMLElement; entry: ExtendViewEntry; titled: boolean } | null>(null)
  const target = leaseTarget?.element ?? null
  // A closing extension keeps rendering (with its last entry) until the platform has collapsed its panel.
  const shown = leaseTarget ? (entry?.handle === leaseTarget.entry.handle ? entry : leaseTarget.entry) : null
  useLayoutEffect(() => {
    if (!entry) return
    const lease = present(entry.options, store.dismiss)
    leaseRef.current = lease
    setTarget({ element: lease.element, entry, titled: !!lease.titled })
    return () => {
      leaseRef.current = null
      // Replaced by a newer entry: swap in place. A plain close may tween the panel shut; drop the content only afterwards.
      const replaced = !!store.getSnapshot()
      void Promise.resolve(lease.dispose(replaced)).then(() => setTarget((current) => (current?.entry.handle === entry.handle ? null : current)))
    }
    // Same-id requests refocus without acquiring the side again.
  }, [entry?.handle, present, store]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { leaseRef.current?.activate?.() }, [entry?.revision])
  useEffect(() => {
    store.setVisible(owner?.isVisible ?? true)
    const subscription = owner?.onDidVisibilityChange(() => store.setVisible(owner.isVisible))
    return () => subscription?.dispose()
  }, [store, owner])
  useEffect(() => {
    const generation = ++lifetime.generation
    // Ignore StrictMode's setup/cleanup replay; revoke after a real owner unmount.
    return () => { queueMicrotask(() => { if (lifetime.generation === generation) store.dispose() }) }
  }, [store, lifetime])
  useEffect(() => {
    const ownsFocus = (): boolean => !!ref.current && (
      (ref.current.contains(document.activeElement) || !!target?.contains(document.activeElement))
      || (document.activeElement === document.body && lastInteractedOwner === ref.current)
    )
    const back = (event: Event): void => {
      if (!store.getSnapshot() || !ownsFocus()) return
      if (event.defaultPrevented) return
      event.preventDefault()
      store.dismiss()
    }
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') back(event) }
    window.addEventListener('keydown', keydown)
    window.addEventListener('forsion:mobile-back', back)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('forsion:mobile-back', back)
      if (lastInteractedOwner && !lastInteractedOwner.isConnected) lastInteractedOwner = null
    }
  }, [store, target])
  return <div ref={ref} className="wb-extend-owner"
    onFocusCapture={() => { lastInteractedOwner = ref.current }}
    onPointerDownCapture={() => { lastInteractedOwner = ref.current }}>
    {children(store.controller)}
    {shown && leaseTarget && createPortal(<Extension key={shown.handle.id} entry={shown} titled={leaseTarget.titled} onDismiss={store.dismiss} />, leaseTarget.element)}
  </div>
}
