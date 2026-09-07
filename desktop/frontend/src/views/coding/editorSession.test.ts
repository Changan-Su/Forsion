import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorFileError, StudioEditorSession, type StudioEditorIO } from './editorSession'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function diskIO(initial = 'original') {
  let content = initial
  let mtimeMs = 10
  const io: StudioEditorIO = {
    read: vi.fn(async () => ({ content, mtimeMs })),
    write: vi.fn(async (_path, next, expected) => {
      if (expected !== mtimeMs) return { conflict: true, mtimeMs }
      content = next; mtimeMs += 10
      return { ok: true, mtimeMs }
    }),
  }
  return { io, disk: () => ({ content, mtimeMs }), external: (next: string) => { content = next; mtimeMs += 10 } }
}
function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}

afterEach(() => { vi.useRealTimers() })

describe('Coding Studio file-owned editor session', () => {
  it('serializes writes and saves newer edits with the mtime returned by the preceding write', async () => {
    const first = deferred<{ ok: boolean; mtimeMs: number }>()
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ ok: true, mtimeMs: 30 })
    const session = new StudioEditorSession('/a.ts', { read: async () => ({ content: 'base', mtimeMs: 10 }), write })
    await session.load()
    session.edit('first')
    const flush = session.flush()
    await settle()
    session.edit('second')
    const otherFlush = session.flush()
    await settle()
    expect(write).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot()).toMatchObject({ content: 'second', dirty: true, status: 'saving' })
    first.resolve({ ok: true, mtimeMs: 20 })
    expect(await flush).toBe(true)
    expect(await otherFlush).toBe(true)
    expect(write.mock.calls).toEqual([['/a.ts', 'first', 10], ['/a.ts', 'second', 20]])
    expect(session.getSnapshot()).toMatchObject({ content: 'second', dirty: false, status: 'saved' })
  })

  it('undoing to the previous baseline during a write still writes the undo after that write finishes', async () => {
    const first = deferred<{ ok: boolean; mtimeMs: number }>()
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ ok: true, mtimeMs: 30 })
    const session = new StudioEditorSession('/a.ts', { read: async () => ({ content: 'base', mtimeMs: 10 }), write })
    await session.load(); session.edit('first')
    const flush = session.flush(); await settle(); session.edit('base')
    first.resolve({ ok: true, mtimeMs: 20 })
    await flush
    expect(write.mock.calls).toEqual([['/a.ts', 'first', 10], ['/a.ts', 'base', 20]])
  })

  it('keeps A writes and A late reads isolated from B when the selected file changes', async () => {
    const pendingA = deferred<{ content: string; mtimeMs: number }>()
    const aIO = diskIO('a'); const bIO = diskIO('b')
    const a = new StudioEditorSession('/a.ts', aIO.io)
    const b = new StudioEditorSession('/b.ts', bIO.io)
    await a.load(); a.edit('local A')
    const saveA = a.flush()
    await b.load(); b.edit('local B'); await b.flush(); await saveA
    aIO.io.read = () => pendingA.promise
    const reloadA = a.load()
    pendingA.resolve({ content: 'agent A', mtimeMs: 50 }); await reloadA
    expect(aIO.disk().content).toBe('local A')
    expect(bIO.disk().content).toBe('local B')
    expect(b.getSnapshot().content).toBe('local B')
    expect(a.getSnapshot().content).toBe('agent A')
  })

  it('autosaves after its view unsubscribes and remounts without losing the draft', async () => {
    vi.useFakeTimers()
    const { io, disk } = diskIO()
    const session = new StudioEditorSession('/a.ts', io)
    await session.load()
    const unsubscribe = session.subscribe(() => {})
    session.edit('draft before switch'); unsubscribe()
    expect(session.getSnapshot().content).toBe('draft before switch')
    await vi.advanceTimersByTimeAsync(700)
    expect(disk().content).toBe('draft before switch')
    expect(session.getSnapshot().dirty).toBe(false)
  })

  it('does not let a refresh overwrite text typed while the read was in flight', async () => {
    vi.useFakeTimers()
    const { io } = diskIO('base')
    const session = new StudioEditorSession('/a.ts', io)
    await session.load()
    const read = deferred<{ content: string; mtimeMs: number }>()
    io.read = () => read.promise
    const refresh = session.load(); await settle(); session.edit('new local text')
    read.resolve({ content: 'agent text', mtimeMs: 50 }); await refresh
    expect(session.getSnapshot()).toMatchObject({ content: 'new local text', dirty: true, status: 'conflict' })
    await vi.advanceTimersByTimeAsync(900)
    expect(io.write).not.toHaveBeenCalled()
  })

  it('preserves conflicts, archives local text when loading disk, and requires a deliberate save after restore', async () => {
    vi.useFakeTimers()
    const { io, external, disk } = diskIO('base')
    const storage = memoryStorage()
    const session = new StudioEditorSession('/a.ts', io, storage)
    await session.load(); session.edit('my draft'); external('agent version')
    expect(await session.flush()).toBe(false)
    expect(session.getSnapshot()).toMatchObject({ content: 'my draft', dirty: true, status: 'conflict' })
    await session.loadDisk()
    expect(session.getSnapshot()).toMatchObject({ content: 'agent version', dirty: false, recoveryDrafts: ['my draft'] })
    session.restoreDraft(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(disk().content).toBe('agent version')
    expect(session.getSnapshot().status).toBe('recovered')
    expect(await session.retry()).toBe(true)
    expect(disk().content).toBe('my draft')
    const reopened = new StudioEditorSession('/a.ts', io, storage)
    await reopened.load()
    expect(reopened.getSnapshot().recoveryDrafts).toEqual(['my draft'])
  })

  it('keeps edits made while explicit disk resolution is waiting instead of discarding them', async () => {
    vi.useFakeTimers()
    const { io, external } = diskIO('base')
    const session = new StudioEditorSession('/a.ts', io)
    await session.load(); session.edit('my draft'); external('agent'); await session.flush()
    const read = deferred<{ content: string; mtimeMs: number }>()
    io.read = () => read.promise
    const resolution = session.loadDisk(); await settle(); session.edit('an even newer draft')
    read.resolve({ content: 'agent', mtimeMs: 20 })
    expect(await resolution).toBe(false)
    expect(session.getSnapshot()).toMatchObject({ content: 'an even newer draft', dirty: true, status: 'conflict' })
  })

  it('recovers draft storage after a renderer reload, checks disk, and never writes during startup', async () => {
    vi.useFakeTimers()
    const { io, disk } = diskIO('base')
    const storage = memoryStorage()
    const original = new StudioEditorSession('/a.ts', io, storage)
    await original.load(); original.edit('persisted draft')
    // Simulate termination: the old renderer and its debounce timer are gone.
    vi.clearAllTimers()
    const reopened = new StudioEditorSession('/a.ts', io, storage)
    await reopened.load(); await vi.advanceTimersByTimeAsync(1000)
    expect(reopened.getSnapshot()).toMatchObject({ content: 'persisted draft', status: 'recovered', dirty: true })
    expect(disk().content).toBe('base')
    expect(await reopened.retry()).toBe(true)
    expect(disk().content).toBe('persisted draft')
  })

  it('surfaces read and write failures while retaining drafts and allows retry', async () => {
    const { io, disk } = diskIO('base')
    const read = io.read; const write = io.write!
    io.read = async () => { throw new Error('offline') }
    const session = new StudioEditorSession('/a.ts', io)
    await session.load()
    expect(session.getSnapshot()).toMatchObject({ status: 'error', errorKind: 'read', loaded: false })
    io.read = read; await session.retry(); session.edit('unsaved')
    io.write = async () => { throw new Error('disk full') }
    expect(await session.flush()).toBe(false)
    expect(session.getSnapshot()).toMatchObject({ status: 'error', errorKind: 'write', content: 'unsaved', dirty: true })
    io.write = write
    expect(await session.retry()).toBe(true)
    expect(disk().content).toBe('unsaved')
  })

  it('does not treat an empty or rejected host response as a successful save', async () => {
    const io: StudioEditorIO = { read: async () => ({ content: 'base', mtimeMs: 0 }), write: vi.fn(async () => ({ ok: false, mtimeMs: 10 })) }
    const session = new StudioEditorSession('/a.ts', io)
    await session.load(); session.edit('draft'); await session.flush()
    expect(io.write).toHaveBeenCalledWith('/a.ts', 'draft', 0)
    expect(session.getSnapshot()).toMatchObject({ status: 'error', dirty: true, savedSequence: 0 })
  })

  it('keeps hosts without revision information or write support read only', async () => {
    const write = vi.fn()
    const session = new StudioEditorSession('/a.ts', { read: async () => ({ content: 'safe' }), write })
    await session.load(); session.edit('unsafe'); await session.flush()
    expect(session.getSnapshot()).toMatchObject({ content: 'safe', status: 'readonly' })
    expect(write).not.toHaveBeenCalled()
    const readonly = new StudioEditorSession('/b.ts', { read: async () => ({ content: 'read only', mtimeMs: 10 }) })
    await readonly.load(); readonly.edit('ignored')
    expect(readonly.getSnapshot()).toMatchObject({ content: 'read only', status: 'readonly' })
  })

  it('reports binary/oversize errors and session-storage failure without losing the in-memory draft', async () => {
    const session = new StudioEditorSession('/a.ts', { read: async () => { throw new EditorFileError('binary') } })
    await session.load()
    expect(session.getSnapshot()).toMatchObject({ status: 'error', errorKind: 'binary' })
    const { io } = diskIO()
    const full = new StudioEditorSession('/b.ts', io, { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('quota') } })
    await full.load(); full.edit('precious draft')
    expect(full.getSnapshot()).toMatchObject({ content: 'precious draft', storageFailed: true, dirty: true })
    await full.flush()
  })
})
