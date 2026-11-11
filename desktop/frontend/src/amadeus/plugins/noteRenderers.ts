/** Read-only note rendering is replaceable; the document/editor and its save pipeline stay in the host. */
export interface NoteReadingSnapshot {
  readonly path: string
  readonly markdown: string
  /** Host-produced static markup, with editing controls and active content removed. */
  readonly html: string
  readonly revision: number
}
export interface NoteRendererHost {
  readonly signal: AbortSignal
  /** Delegate wiki / external links to the host. Never writes a note. */
  openLink(href: string, kind?: 'wiki' | 'url'): void
}
export interface NoteRendererContribution {
  id: string
  apiVersion: 1
  /** Resolve only once the staged surface is ready. Throw/reject to retain the last working surface. */
  mount(element: HTMLElement, snapshot: NoteReadingSnapshot, host: NoteRendererHost):
    void | (() => void) | Promise<void | (() => void)>
}
export interface NoteRendererEntry extends NoteRendererContribution { pluginId: string; generation: number }
const entries = new Map<string, NoteRendererEntry>()
const reloads = new Map<string, 'pending' | 'failed'>()
const listeners = new Set<() => void>()
let generation = 0
let scheduled = false
const emit = (): void => {
  // Teardown + synchronous setup is one replacement, not a flash of the default renderer.
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => { scheduled = false; for (const fn of [...listeners]) fn() })
}
export function registerNoteRenderer(pluginId: string, def: NoteRendererContribution): () => void {
  if (!def?.id?.trim() || def.apiVersion !== 1 || typeof def.mount !== 'function') throw new TypeError('registerNoteRenderer requires id, apiVersion: 1 and mount')
  const key = `${pluginId}:${def.id}`
  const entry = { ...def, pluginId, generation: ++generation }
  entries.set(key, entry)
  emit()
  return () => { if (entries.get(key) === entry) { entries.delete(key); emit() } }
}
export function currentNoteRenderer(): NoteRendererEntry | null {
  return [...entries.values()].sort((a, b) => b.generation - a.generation)[0] ?? null
}
/** The plugin loader holds the old read surface while replacing a package, including async setup. */
export function beginNoteRendererReload(pluginId: string): void {
  if ([...entries.values()].some((entry) => entry.pluginId === pluginId) || reloads.has(pluginId)) { reloads.set(pluginId, 'pending'); emit() }
}
export function settleNoteRendererReload(pluginId: string, success: boolean): void {
  if (!reloads.has(pluginId)) return
  if (success) reloads.delete(pluginId)
  else reloads.set(pluginId, 'failed')
  emit()
}
export function clearNoteRendererReload(pluginId: string): void { if (reloads.delete(pluginId)) emit() }
export function noteRendererReloadState(pluginId: string): 'pending' | 'failed' | undefined { return reloads.get(pluginId) }
export function subscribeNoteRenderers(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }

/** Staged mounts are committed atomically. Late generations cannot replace the current document. */
export function createNoteRenderSurface(root: HTMLElement, openLink: NoteRendererHost['openLink']) {
  let turn = 0
  let pending: AbortController | null = null
  let current: { element: HTMLElement; dispose?: () => void; controller: AbortController } | null = null
  const close = (value: typeof current): void => {
    if (!value) return
    value.controller.abort()
    try { value.dispose?.() } catch (e) { console.error('[amadeus] note renderer cleanup failed', e) }
    value.element.remove()
  }
  return {
    async render(renderer: NoteRendererContribution, snapshot: NoteReadingSnapshot, beforeCommit?: () => (() => void)): Promise<boolean> {
      const mine = ++turn
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      const element = document.createElement('div')
      element.className = 'amx-reading-renderer'
      let dispose: void | (() => void)
      try {
        dispose = await renderer.mount(element, Object.freeze({ ...snapshot }), { signal: controller.signal, openLink })
        if (controller.signal.aborted || mine !== turn) {
          if (typeof dispose === 'function') dispose()
          element.remove()
          return false
        }
        const restore = beforeCommit?.()
        const previous = current
        current = { element, controller, ...(typeof dispose === 'function' ? { dispose } : {}) }
        root.replaceChildren(element)
        // A committed surface remains live until its successor has committed successfully.
        if (pending === controller) pending = null
        close(previous)
        restore?.()
        return true
      } catch (e) {
        if (pending === controller) pending = null
        controller.abort()
        element.remove()
        if (mine === turn) console.error('[amadeus] note renderer update failed; previous surface retained', e)
        return false
      }
    },
    dispose(): void { turn++; pending?.abort(); close(current); current = null; root.replaceChildren() },
  }
}
