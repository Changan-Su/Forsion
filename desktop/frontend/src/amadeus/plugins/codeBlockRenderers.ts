import type { CodeBlockRendererContribution } from './types'

export interface RegisteredCodeBlockRenderer {
  key: number
  pluginId: string
  item: CodeBlockRendererContribution
}
const renderers: RegisteredCodeBlockRenderer[] = []
const listeners = new Set<() => void>()
let sequence = 0
const changed = (): void => { for (const fn of [...listeners]) fn() }
export const subscribeCodeBlockRenderers = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export const findCodeBlockRenderer = (language: string): RegisteredCodeBlockRenderer | undefined =>
  renderers.find(r => r.item.language === language)

/** Scoped registrations and mounts: late async cleanup is run even after disable. */
export function registerCodeBlockRenderer(pluginId: string, def: CodeBlockRendererContribution): () => void {
  if (!def.id || !def.language || /\s/.test(def.language) || def.language.startsWith('forsion-') || def.language === 'mermaid') {
    throw new Error('Invalid or reserved code block renderer language')
  }
  let active = true
  const mounts = new Set<() => void>()
  const registered: RegisteredCodeBlockRenderer = { key: ++sequence, pluginId, item: {
    ...def,
    mount(el, block) {
      if (!active) throw new Error('Code block renderer is unregistered')
      const controller = new AbortController()
      let done = false, cleanup: (() => void) | void
      const dispose = (): void => {
        if (done) return
        done = true; controller.abort(); mounts.delete(dispose)
        block.signal.removeEventListener('abort', dispose)
        cleanup?.()
      }
      mounts.add(dispose)
      block.signal.addEventListener('abort', dispose, {once: true})
      if (block.signal.aborted) { dispose(); return dispose }
      try {
        const mounted = def.mount(el, {...block, signal: controller.signal})
        if (mounted && typeof (mounted as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(mounted).then(fn => {
            if (done) fn?.(); else cleanup = fn
            return dispose
          }, error => { dispose(); throw error })
        }
        cleanup = mounted as (() => void) | void
        if (done) cleanup?.()
        return dispose
      } catch (error) { dispose(); throw error }
    },
  } }
  renderers.push(registered); changed()
  return () => {
    if (!active) return
    active = false
    const i = renderers.indexOf(registered)
    if (i !== -1) renderers.splice(i, 1)
    for (const dispose of [...mounts]) {
      try { dispose() } catch (error) { console.error('[plugin-code-block] cleanup failed', error) }
    }
    changed()
  }
}
