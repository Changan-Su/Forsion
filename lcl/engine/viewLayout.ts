/** Geometry notifications for expensive content (PDF, canvas, editors and plugin DOM).
 * Views may resize cheap chrome during a transition and refit expensive content once settled.
 * This is opt-in: the engine constrains and coordinates every View without registration changes. */
export interface ViewLayoutState {
  width: number
  height: number
  visible: boolean
  compact: boolean
  phase: 'transition' | 'settled'
}
export interface ViewLayoutHandle {
  getSnapshot(): Readonly<ViewLayoutState>
  subscribe(listener: (state: Readonly<ViewLayoutState>) => void): () => void
}
export function createViewLayout(): ViewLayoutHandle & { attach(el: HTMLElement): () => void } {
  let state: ViewLayoutState = { width: 0, height: 0, visible: false, compact: true, phase: 'settled' }
  const listeners = new Set<(state: Readonly<ViewLayoutState>) => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); listener(state); return () => { listeners.delete(listener) } },
    attach(el) {
      const viewport = el.closest<HTMLElement>('.wb-workspace-viewport'), overlay = el.closest<HTMLElement>('.dv-render-overlay')
      const update = () => {
        const next: ViewLayoutState = { width: el.clientWidth, height: el.clientHeight, visible: overlay ? overlay.dataset.lclVisible === 'true' : el.checkVisibility(), compact: el.clientWidth < 480,
          phase: viewport?.dataset.layoutPhase === 'transition' ? 'transition' : 'settled' }
        if (Object.keys(next).every(k => next[k as keyof ViewLayoutState] === state[k as keyof ViewLayoutState])) return
        state = Object.freeze(next)
        for (const listener of listeners) { try { listener(state) } catch (error) { console.error('[lcl] View layout listener', error) } }
      }
      const resize = new ResizeObserver(update); resize.observe(el)
      const attributes = new MutationObserver(update)
      if (viewport) attributes.observe(viewport, { attributes: true, attributeFilter: ['data-layout-phase'] })
      if (overlay) attributes.observe(overlay, { attributes: true, attributeFilter: ['data-lcl-visible'] })
      update()
      return () => { resize.disconnect(); attributes.disconnect(); listeners.clear() }
    },
  }
}
