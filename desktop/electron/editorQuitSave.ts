/**
 * Quit waits for the workspace `.md` tabs to save what is still typed.
 *
 * A workspace file tab (WsFileView → MdFileEditor) holds the last edits for up to ~1s (the editor's 200ms listener
 * window, then an 800ms save debounce) and saves them from the renderer. Quitting never runs React cleanup, and the
 * usual exit route (`before-quit` prevented, engine stopped, then `app.exit(0)`) destroys the windows without unload
 * events, so the renderer gets no chance to save on its own. Renderers report how many such editors they have open;
 * before quitting, the host asks each of those to save and waits for its answer, capped so a hung window cannot keep
 * the app from quitting.
 * Pure logic, no electron dependency (renderers and the IPC events are injected); vitest covers it directly.
 */
export interface QuitSaveRenderer {
  id: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}
type AckListener = (event: { sender: { id: number } }, requestId: unknown) => void
export interface QuitSaveEvents {
  on(channel: string, listener: AckListener): unknown
  removeListener(channel: string, listener: AckListener): unknown
}

/** Host → renderer: save every open workspace editor now; payload { requestId }. */
export const QUIT_SAVE_ASK = 'wsfile:quit-save'
/** Renderer → host: done (whatever the outcome: a conflict or a failure has gone to a sidecar by then); args requestId. */
export const QUIT_SAVE_DONE = 'wsfile:quit-saved'
/** Renderer → host: how many workspace editors this window has open now. */
export const OPEN_EDITORS = 'wsfile:open-editors'

export function createEditorQuitSave(deps: { events: QuitSaveEvents; timeoutMs?: number; newId?: () => string; log?: (m: string) => void }) {
  const timeoutMs = deps.timeoutMs ?? 5000
  let seq = 0
  const newId = deps.newId ?? (() => `quit-save-${Date.now()}-${++seq}`)
  const open = new Map<number, QuitSaveRenderer>()
  /** Windows that let an ask run into the cap: not asked again (restart asks, then its own before-quit asks once more)
   *  until they report again, which shows they are alive. */
  const unresponsive = new Set<number>()
  return {
    /** A renderer reported its open editor count. */
    report(renderer: QuitSaveRenderer, count: unknown): void {
      unresponsive.delete(renderer.id)
      if (typeof count === 'number' && count > 0) open.set(renderer.id, renderer)
      else open.delete(renderer.id)
    },
    /** The renderer navigated (reload) or went away: its editors went with it. */
    forget(id: number): void {
      open.delete(id)
      unresponsive.delete(id)
    },
    /** Before quitting: null = no window has a workspace editor open (nothing to wait for). Otherwise resolves once
     *  every such window answered, went away, or the cap passed; never rejects (quitting must not get stuck). */
    quit(): Promise<void> | null {
      const targets = [...open.values()].filter((r) => !r.isDestroyed() && !unresponsive.has(r.id))
      if (!targets.length) return null
      const requestId = newId()
      return new Promise<void>((resolve) => {
        const pending = new Set(targets.map((r) => r.id))
        const gone = new Map<QuitSaveRenderer, () => void>()
        const finish = (): void => {
          clearTimeout(timer)
          deps.events.removeListener(QUIT_SAVE_DONE, onDone)
          for (const [r, l] of gone) r.removeListener('destroyed', l)
          resolve()
        }
        const settle = (id: number): void => {
          if (!pending.delete(id)) return
          if (!pending.size) finish()
        }
        const onDone: AckListener = (event, received) => { if (received === requestId) settle(event.sender.id) }
        const timer = setTimeout(() => {
          deps.log?.(`[quit-save] ${pending.size} window(s) did not answer within ${timeoutMs}ms; quitting anyway`)
          for (const id of pending) unresponsive.add(id)
          finish()
        }, timeoutMs)
        deps.events.on(QUIT_SAVE_DONE, onDone)
        for (const r of targets) {
          const l = (): void => settle(r.id)
          gone.set(r, l)
          r.once('destroyed', l)
        }
        for (const r of targets) {
          try { r.send(QUIT_SAVE_ASK, { requestId }) } catch { settle(r.id) }
        }
      })
    },
  }
}

export interface UnloadWriteResult { ok?: boolean; conflict?: boolean; mtimeMs?: number; error?: string }

/** The save a page makes while it goes away (pagehide → `fs:writeFileSync`): the renderer is blocked until this resolves.
 *  - Always resolves, capped: a write stuck on a stalled mount must not freeze the window's reload / close for good
 *    (the write itself goes on; the renderer then tries its sidecar).
 *  - The CAS refused but the file already holds exactly these bytes (the editor's own autosave of the same text was in
 *    flight and landed first): that is a save, not a conflict — nothing to put in a sidecar. */
export function unloadWrite(
  deps: {
    write(path: string, content: string, expectedMtimeMs?: number, createNew?: boolean): Promise<{ ok?: boolean; conflict?: boolean; mtimeMs: number }>
    read(path: string): Promise<string | null>
    capMs?: number
  },
  path: string, content: string, expectedMtimeMs?: number, createNew?: boolean,
): Promise<UnloadWriteResult> {
  const capMs = deps.capMs ?? 3000
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'timeout' }), capMs)
    const done = (r: UnloadWriteResult): void => { clearTimeout(timer); resolve(r) }
    deps.write(path, content, expectedMtimeMs, createNew).then(async (r) => {
      if (r.conflict && !createNew && (await deps.read(path).catch(() => null)) === content) return done({ ok: true, mtimeMs: r.mtimeMs })
      done(r)
    }, (err) => done({ error: String((err as Error)?.message || err) }))
  })
}
