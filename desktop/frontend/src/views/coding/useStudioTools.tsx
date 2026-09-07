import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createExtendViewController, type ExtendViewController, type ExtendViewHandle, type ExtendViewSide } from '@lcl/engine/extendView'
import { translate, useI18n } from '../../i18n'
import './studioMessages'

export type StudioTool = 'brief' | 'history' | 'checks' | 'issues' | 'setup'
export interface ActiveStudioTool { kind: StudioTool; side: ExtendViewSide; handle: ExtendViewHandle }

const titles: Record<StudioTool, string> = {
  brief: 'studio.project', history: 'studio.history', checks: 'studio.checks', issues: 'studio.issues', setup: 'studio.setup',
}
const defaultSides: Record<StudioTool, ExtendViewSide> = {
  brief: 'right', history: 'bottom', checks: 'right', issues: 'bottom', setup: 'right',
}
interface Slot { kind: StudioTool; side: ExtendViewSide; element: HTMLDivElement }

function EmbeddedTool({ slot, handle, revision, close }: { slot: Slot; handle: ExtendViewHandle; revision: number; close(): void }) {
  const { t } = useI18n()
  const panel = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const target = body.current!
    target.appendChild(slot.element)
    return () => { if (slot.element.parentElement === target) slot.element.remove() }
  }, [slot])
  useEffect(() => {
    const focus = slot.element.querySelector<HTMLElement>('input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])')
    ;(focus ?? panel.current)?.focus({ preventScroll: true })
  }, [slot, handle, revision])
  useEffect(() => {
    // The slot is a sibling React portal, so use physical DOM bubbling rather than a React
    // key handler on this wrapper. Other panels retain ownership of their own Escape key.
    const element = panel.current!
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !element.contains(document.activeElement)) return
      event.preventDefault()
      close()
    }
    element.addEventListener('keydown', keydown)
    return () => element.removeEventListener('keydown', keydown)
  }, [close])
  return createElement('section', { ref: panel, className: 'csu-embedded-tool', role: 'dialog', 'aria-label': t(titles[slot.kind]), 'data-side': slot.side, tabIndex: -1 },
    createElement('header', { className: 'csu-embedded-tool-head' },
      createElement('strong', null, t(titles[slot.kind])),
      createElement('button', { type: 'button', onClick: close, title: t('studio.close'), 'aria-label': t('studio.close') }, '×')),
    createElement('div', { ref: body, className: 'csu-embedded-tool-body' }))
}

/** Native temporary Views own their chrome and placement; the project owns each tool's React tree.
 * Moving a stable portal container between leases preserves form drafts, subscriptions and context.
 * Closed tools stay detached until this project unmounts, with at most five lazily created trees. */
export function useStudioTools(controller: ExtendViewController | undefined, root: string, { embeddedFallback = false }: { embeddedFallback?: boolean } = {}) {
  const [, refresh] = useReducer((value: number) => value + 1, 0)
  const owner = useMemo(() => ({
    mounted: false,
    active: null as ActiveStudioTool | null,
    slots: new Map<StudioTool, Slot>(),
    fallback: !controller && embeddedFallback ? createExtendViewController() : null,
  }), [controller, root, embeddedFallback])
  const effectiveController = controller ?? owner.fallback?.controller
  const notify = useCallback(() => { if (owner.mounted) refresh() }, [owner])

  useLayoutEffect(() => {
    owner.mounted = true
    return () => {
      owner.mounted = false
      // StrictMode replays effects without discarding the project's React tree. A real unmount or
      // identity change leaves this owner inactive; its old handle can never close a successor.
      queueMicrotask(() => {
        if (owner.mounted) return
        owner.active?.handle.close()
        owner.active = null
        owner.fallback?.dispose()
        for (const slot of owner.slots.values()) slot.element.remove()
        owner.slots.clear()
      })
    }
  }, [owner])

  const open = useCallback((kind: StudioTool, requestedSide?: ExtendViewSide): boolean => {
    if (!effectiveController || !owner.mounted || !Object.hasOwn(titles, kind)) return false
    const existing = owner.slots.get(kind)
    const side = requestedSide ?? existing?.side ?? defaultSides[kind]
    if (!['left', 'right', 'bottom'].includes(side)) return false
    const slot: Slot = existing ?? { kind, side, element: document.createElement('div') }
    if (!existing) {
      slot.element.className = 'csu-tool-slot'
      slot.element.dataset.studioTool = kind
    }
    let handle: ExtendViewHandle | null = null
    try {
      handle = effectiveController.open({
        // Same tool/side refocuses; changing sides acquires a new native lease for the same DOM.
        id: `coding-tool:${JSON.stringify([root, kind, side])}`,
        title: () => translate(titles[kind]),
        side,
        mount: (element) => {
          element.appendChild(slot.element)
          return () => {
            // A delayed close animation may finish after this tool has moved to another Panel.
            if (slot.element.parentElement === element) slot.element.remove()
          }
        },
        onClose: () => {
          if (owner.active?.handle !== handle) return
          owner.active = null
          notify()
        },
      })
    } catch {
      // A hidden/unmounted owner refuses late work. The caller can choose an embedded fallback.
      return false
    }
    slot.side = side
    owner.slots.set(kind, slot)
    owner.active = { kind, side, handle }
    notify()
    return true
  }, [effectiveController, owner, root, notify])

  const close = useCallback((): void => { owner.active?.handle.close() }, [owner])
  const render = useCallback((content: (kind: StudioTool, side: ExtendViewSide) => ReactNode): ReactNode => {
    const portals: ReactNode[] = [...owner.slots.values()].map(slot => createPortal(content(slot.kind, slot.side), slot.element, slot.kind))
    if (owner.fallback && owner.active) {
      const slot = owner.slots.get(owner.active.kind)!
      portals.push(createElement(EmbeddedTool, { key: 'embedded-tool', slot, handle: owner.active.handle, revision: owner.fallback.getSnapshot()?.revision ?? 0, close }))
    }
    return portals
  }, [owner, close])

  return {
    active: owner.active,
    open,
    close,
    render,
  }
}
