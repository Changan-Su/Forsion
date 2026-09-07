/** A file owns its I/O queue and draft. React views only subscribe: changing files or
 * unmounting cannot redirect a pending write or throw away an unsaved edit. */
export type EditorStatus = 'loading' | 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'readonly' | 'recovered'
export type EditorErrorKind = 'read' | 'write' | 'tooLarge' | 'binary' | 'unavailable' | 'revision'
export interface EditorSnapshot {
  content: string
  loaded: boolean
  dirty: boolean
  status: EditorStatus
  error: string | null
  errorKind: EditorErrorKind | null
  savedSequence: number
  recoveryDrafts: string[]
  storageFailed: boolean
}
export interface StudioEditorIO {
  read(path: string): Promise<{ content: string; mtimeMs?: number }>
  write?: (path: string, content: string, mtimeMs: number) => Promise<{ ok?: boolean; conflict?: boolean; mtimeMs: number }>
}
interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
interface StoredDraft { content: string; base: string; mtime?: number; recoveryDrafts: string[] }
const storageKey = (path: string): string => `forsion.coding.draft.v1:${path}`
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
export class EditorFileError extends Error {
  constructor(public readonly kind: EditorErrorKind, message = kind) { super(message) }
}

export class StudioEditorSession {
  private state: EditorSnapshot = { content: '', loaded: false, dirty: false, status: 'loading', error: null, errorKind: null, savedSequence: 0, recoveryDrafts: [], storageFailed: false }
  private base = ''
  private mtime?: number
  private revision = 0
  private paused = false
  private listeners = new Set<() => void>()
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(readonly path: string, private readonly io: StudioEditorIO, private readonly storage?: DraftStorage, private readonly debounceMs = 650) {
    try {
      const raw = storage?.getItem(storageKey(path))
      if (raw) {
        const draft = JSON.parse(raw) as StoredDraft
        if (typeof draft.content === 'string' && typeof draft.base === 'string') {
          this.base = draft.base
          this.mtime = typeof draft.mtime === 'number' && Number.isFinite(draft.mtime) ? draft.mtime : undefined
          this.state = { ...this.state, content: draft.content, dirty: draft.content !== draft.base,
            recoveryDrafts: Array.isArray(draft.recoveryDrafts) ? draft.recoveryDrafts.filter((v) => typeof v === 'string') : [] }
          // A restored draft waits for an explicit Save; startup must never write files.
          this.paused = this.state.dirty
        }
      }
    } catch { this.state = { ...this.state, storageFailed: true } }
  }

  getSnapshot = (): EditorSnapshot => this.state
  canEdit = (): boolean => this.state.loaded && !!this.io.write && this.mtime !== undefined
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private publish(patch: Partial<EditorSnapshot>): void {
    this.state = { ...this.state, ...patch }
    try {
      if (this.state.dirty || this.state.recoveryDrafts.length) {
        this.storage?.setItem(storageKey(this.path), JSON.stringify({ content: this.state.content, base: this.base, mtime: this.mtime, recoveryDrafts: this.state.recoveryDrafts } satisfies StoredDraft))
      } else this.storage?.removeItem(storageKey(this.path))
    } catch { this.state = { ...this.state, storageFailed: true } }
    for (const listener of this.listeners) listener()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => {})
    return next
  }

  private clearTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
  private schedule(): void {
    this.clearTimer()
    if (this.paused || !this.state.dirty || !this.state.loaded || !this.io.write) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, this.debounceMs)
  }
  private fail(error: unknown, fallback: EditorErrorKind): void {
    this.paused = true
    this.publish({ status: 'error', errorKind: error instanceof EditorFileError ? error.kind : fallback, error: errorText(error) })
  }
  private readyStatus(): EditorStatus {
    if (!this.io.write || this.mtime === undefined) return 'readonly'
    return this.state.dirty ? (this.paused ? 'recovered' : 'dirty') : 'saved'
  }

  /** Refresh is also used after agent writes. A disk update never replaces a draft. */
  load = (): Promise<void> => {
    return this.enqueue(async () => {
      if (!this.state.loaded) this.publish({ status: 'loading', error: null, errorKind: null })
      try {
        const disk = await this.io.read(this.path)
        if (this.state.dirty && disk.content !== this.base && disk.content !== this.state.content) {
          this.paused = true
          this.publish({ loaded: true, status: 'conflict', error: null, errorKind: null })
          return
        }
        this.mtime = typeof disk.mtimeMs === 'number' && Number.isFinite(disk.mtimeMs) ? disk.mtimeMs : undefined
        if (!this.state.dirty || disk.content === this.state.content) {
          this.base = disk.content
          this.paused = false
          this.publish({ content: disk.content, dirty: false, loaded: true, error: null, errorKind: null })
        } else this.publish({ loaded: true, error: null, errorKind: null })
        this.publish({ status: this.readyStatus() })
        this.schedule()
      } catch (error) { this.fail(error, 'read') }
    })
  }

  edit = (content: string): void => {
    if (!this.state.loaded || !this.io.write || this.mtime === undefined || content === this.state.content) return
    this.revision++
    const dirty = content !== this.base
    const blocked = this.state.status === 'conflict' || this.state.status === 'error' || this.state.status === 'recovered'
    this.publish({ content, dirty, status: blocked ? this.state.status : this.state.status === 'saving' ? 'saving' : dirty ? 'dirty' : 'saved' })
    this.schedule()
  }

  /** Resolve once all edits received during the current write have been saved.
   * A false result means a preserved conflict/error/draft still needs attention. */
  flush = (): Promise<boolean> => {
    this.clearTimer()
    return this.enqueue(async () => {
      while (this.state.dirty && !this.paused) {
        if (!this.io.write || !this.state.loaded || this.mtime === undefined) return false
        const content = this.state.content
        const expected = this.mtime
        this.publish({ status: 'saving', error: null, errorKind: null })
        try {
          const result = await this.io.write(this.path, content, expected)
          if (result?.conflict) {
            this.paused = true
            this.publish({ status: 'conflict' })
            return false
          }
          if (!result?.ok || !Number.isFinite(result.mtimeMs)) throw new EditorFileError('write')
          this.base = content
          this.mtime = result.mtimeMs
          const dirty = this.state.content !== content
          this.publish({ dirty, status: dirty ? (this.paused ? 'recovered' : 'dirty') : 'saved', savedSequence: this.state.savedSequence + 1 })
        } catch (error) { this.fail(error, 'write'); return false }
      }
      return !this.state.dirty
    })
  }

  /** Retry is deliberate. It rechecks the disk before resuming autosave. */
  retry = async (): Promise<boolean> => {
    await this.load()
    if (this.state.status === 'conflict' || this.state.status === 'error' || this.state.status === 'readonly') return false
    this.paused = false
    this.publish({ status: this.readyStatus() })
    return this.flush()
  }

  /** Explicit conflict resolution archives the local text before loading disk.
   * If another edit arrives while reading, the resolution is cancelled. */
  loadDisk = (): Promise<boolean> => {
    this.clearTimer()
    const requestedRevision = this.revision
    return this.enqueue(async () => {
      try {
        const disk = await this.io.read(this.path)
        if (this.revision !== requestedRevision) return false
        const recoveries = this.state.dirty && this.state.content !== disk.content
          ? [...this.state.recoveryDrafts, this.state.content] : this.state.recoveryDrafts
        this.base = disk.content
        this.mtime = typeof disk.mtimeMs === 'number' && Number.isFinite(disk.mtimeMs) ? disk.mtimeMs : undefined
        this.paused = false
        this.revision++
        this.publish({ content: disk.content, loaded: true, dirty: false, recoveryDrafts: recoveries, error: null, errorKind: null })
        this.publish({ status: this.readyStatus() })
        return true
      } catch (error) { this.fail(error, 'read'); return false }
    })
  }

  restoreDraft = (index: number): void => {
    const content = this.state.recoveryDrafts[index]
    if (content === undefined || !this.state.loaded) return
    this.clearTimer()
    this.paused = true
    this.revision++
    const recoveries = this.state.dirty && this.state.content !== content
      ? [...this.state.recoveryDrafts, this.state.content] : this.state.recoveryDrafts
    this.publish({ content, dirty: content !== this.base, recoveryDrafts: recoveries, status: 'recovered', error: null, errorKind: null })
  }
}

const sessions = new Map<string, StudioEditorSession>()
const normalizePath = (path: string): string => path.replace(/\\/g, '/')

function browserIO(): StudioEditorIO {
  return {
    read: async (path) => {
      if (!window.tangu?.readHostFile) throw new EditorFileError('unavailable')
      const file = await window.tangu.readHostFile(path)
      if (!file) throw new EditorFileError('read')
      if (file.tooLarge) throw new EditorFileError('tooLarge')
      const bytes = Uint8Array.from(atob(file.content), (ch) => ch.charCodeAt(0))
      // TextDecoder must be lossless: editing binary or invalid UTF-8 would corrupt it.
      if (bytes.includes(0)) throw new EditorFileError('binary')
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { throw new EditorFileError('binary') }
      return { content, mtimeMs: file.mtimeMs }
    },
    ...(typeof window !== 'undefined' && window.tangu?.writeHostFile ? {
      write: async (path: string, content: string, mtime: number) => {
        if (!window.tangu?.writeHostFile) throw new EditorFileError('unavailable')
        return window.tangu.writeHostFile(path, content, mtime)
      },
    } : {}),
  }
}

export function getStudioEditorSession(path: string): StudioEditorSession {
  const key = normalizePath(path)
  let session = sessions.get(key)
  if (!session) {
    let storage: DraftStorage | undefined
    try { storage = window.sessionStorage } catch { /* In-memory drafts remain available. */ }
    session = new StudioEditorSession(path, browserIO(), storage)
    sessions.set(key, session)
  }
  return session
}
function inRoot(path: string, root?: string): boolean {
  const prefix = root ? normalizePath(root).replace(/\/$/, '') : null
  return prefix === null || path === prefix || path.startsWith(prefix + '/')
}
export async function flushStudioEditors(root?: string): Promise<boolean> {
  const results = await Promise.all([...sessions].filter(([path]) => inRoot(path, root)).map(([, session]) => session.flush()))
  return results.every(Boolean)
}
export function hasUnsavedStudioEditors(root?: string): boolean {
  return [...sessions].some(([path, session]) => inRoot(path, root) && (session.getSnapshot().dirty || session.getSnapshot().status === 'saving'))
}
/** Let the project surface a blocked draft even when another file is selected. */
export function getUnsavedStudioEditorPaths(root?: string): string[] {
  return [...sessions].filter(([path, session]) => inRoot(path, root) && (session.getSnapshot().dirty || session.getSnapshot().status === 'saving')).map(([, session]) => session.path)
}
