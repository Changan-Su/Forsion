// Read-only main-window command descriptions for the separate settings renderer.
// Functions never cross the boundary and these rows never register executable commands.
import { create } from 'zustand'
import { useCommandStore } from '@lcl/engine'
import { windowKind } from './windowKind'
import { subscribeLocale } from './i18n'

export interface ShortcutDescription { id: string; title: string; hotkey?: string; hotkeys?: string[] }
const KEY = 'forsion_shortcut_catalog'
export const useShortcutCatalog = create<{ commands: ShortcutDescription[] }>(() => ({ commands: [] }))
let installed = false
export function installShortcutCatalog(): void {
  if (installed) return
  installed = true
  if (windowKind() === 'main') {
    let queued = false
    const publish = (): void => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        const commands = useCommandStore.getState().commands.map(c => {
          let title = c.id
          try { title = typeof c.title === 'function' ? c.title() : c.title } catch { /* broken plugin title */ }
          return { id: c.id, title, hotkey: c.hotkey, hotkeys: c.hotkeys }
        })
        try { localStorage.setItem(KEY, JSON.stringify(commands)) } catch { /* local window still works */ }
      })
    }
    publish()
    useCommandStore.subscribe(publish)
    subscribeLocale(publish)
  } else {
    const read = (): void => {
      let commands: ShortcutDescription[] = []
      try {
        const data: unknown = JSON.parse(localStorage.getItem(KEY) || '[]')
        if (Array.isArray(data)) commands = data.filter(c => c && typeof c.id === 'string' && typeof c.title === 'string').map(c => ({
          id: c.id, title: c.title, hotkey: typeof c.hotkey === 'string' ? c.hotkey : undefined,
          hotkeys: Array.isArray(c.hotkeys) ? c.hotkeys.filter((k: unknown) => typeof k === 'string') : [],
        }))
      } catch { /* malformed/stale cache is not executable */ }
      useShortcutCatalog.setState({ commands })
    }
    read()
    window.addEventListener('storage', e => { if (e.key === KEY || e.key === null) read() })
  }
}
