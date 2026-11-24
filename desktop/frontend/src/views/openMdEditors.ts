/** Workspace `.md` tabs (MdFileEditor) open in this window, and their unsaved typing when the window goes away.
 *
 *  An editor holds the last ~1s of typing (the editor's 200ms listener window, then an 800ms save debounce). Closing
 *  the tab saves it on unmount, but React cleanup never runs when the whole page goes away:
 *   - app quit: the host asks first (`onQuitSave`) and waits (capped) — the usual exit is app.exit, which destroys the
 *     windows without unload events (check:wsfileflush, quit phase);
 *   - window reload (renderer recovery, Cmd+R) / window close: `pagehide` (and `beforeunload`) save synchronously, so
 *     a reloaded page never reads the file before the write landed;
 *   - reloadWindow(): saves first, then asks the host to reload.
 *  The count of open editors goes to the host, which only waits for windows that have one.
 *  No imports: reloadWindow.ts loads this early. */

/** In-flight writes by path: MdFileEditor's saves register here and readers wait for the write to land first,
 *  so a remount / reload never reads the file before the outgoing editor's save is on disk. */
export const pendingWrites = new Map<string, Promise<unknown>>()

/** Registers a write on `path`. Readers wait for every write still outstanding on the path (two tabs of the same file
 *  each have their own), not only the latest one; the entry goes once all of them settled. */
export function trackWrite(path: string, write: Promise<unknown>): void {
  const settled = write.then(() => {}, () => {})
  const prev = pendingWrites.get(path)
  const all = prev ? Promise.all([prev, settled]).then(() => {}) : settled
  pendingWrites.set(path, all)
  void all.then(() => { if (pendingWrites.get(path) === all) pendingWrites.delete(path) })
}

export interface OpenMdEditor {
  /** Hand over what the editor holds and save it (CAS; conflict / failure → sidecar). The write starts synchronously. */
  save(): Promise<void>
  /** Same for a page that is going away: returns once the host wrote it (or the sidecar). */
  saveSync(): void
}

const editors = new Set<OpenMdEditor>()
let installed = false

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const onLeave = (): void => {
    for (const e of [...editors]) {
      try { e.saveSync() } catch { /* the next editor still saves */ }
    }
  }
  window.addEventListener('pagehide', onLeave)
  // Never sets returnValue: in Electron that silently keeps the window from closing.
  window.addEventListener('beforeunload', onLeave)
  window.tangu?.onQuitSave?.(() => saveOpenMdEditors() ?? Promise.resolve())
}

export function registerOpenMdEditor(e: OpenMdEditor): () => void {
  install()
  editors.add(e)
  window.tangu?.reportOpenEditors?.(editors.size)
  return () => {
    if (editors.delete(e)) window.tangu?.reportOpenEditors?.(editors.size)
  }
}

/** Every open editor saves what it holds; also waits for writes still in flight (a tab closed a moment ago).
 *  null = nothing open and nothing in flight (callers go ahead synchronously). Never rejects. */
export function saveOpenMdEditors(): Promise<void> | null {
  if (!editors.size && !pendingWrites.size) return null
  const saves = [...editors].map((e) => e.save().catch(() => {}))
  return Promise.all([...saves, ...pendingWrites.values()]).then(() => {})
}
