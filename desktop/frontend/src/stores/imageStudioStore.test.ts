import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageBoard } from '../views/imageStudio/model'
const io = vi.hoisted(() => ({ loadBoards: vi.fn(), saveBoard: vi.fn() }))
vi.mock('../views/imageStudio/storage', () => io)
let store: typeof import('./imageStudioStore').useImageStudio
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  io.loadBoards.mockReset().mockResolvedValue([]); io.saveBoard.mockReset().mockResolvedValue(undefined)
  store = (await import('./imageStudioStore')).useImageStudio
  await store.getState().hydrate()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('Image Studio persistence and ownership', () => {
  it('keeps undo and asynchronous writes within their original project', async () => {
    const a = store.getState().create('A'), b = store.getState().create('B')
    store.getState().update(a, board => ({ ...board, name: 'A revised' }))
    store.getState().undo(a)
    expect(store.getState().boards[a].name).toBe('A')
    expect(store.getState().boards[b].name).toBe('B')
    expect(store.getState().activeId).toBe(b)
    await store.getState().flush()
    expect(io.saveBoard.mock.calls.map(call => (call[0] as ImageBoard).name)).toEqual(['A', 'B'])
  })
  it('never rolls back a session binding or resurrects an acknowledged output through undo', () => {
    const id = store.getState().create('A')
    store.getState().update(id, b => ({ ...b, name: 'Changed' }))
    store.getState().update(id, b => ({ ...b, sessionId: 'session-A', collected: ['generated.png'] }), false)
    store.getState().undo(id)
    expect(store.getState().boards[id]).toMatchObject({ name: 'A', sessionId: 'session-A', collected: ['generated.png'] })
  })
  it('reports save failure and retries the dirty document without discarding it', async () => {
    const id = store.getState().create('A')
    io.saveBoard.mockRejectedValueOnce(new Error('disk quota'))
    await store.getState().flush()
    expect(store.getState().error).toContain('disk quota')
    expect(store.getState().boards[id].name).toBe('A')
    await store.getState().flush()
    expect(store.getState().error).toBe('')
    expect(io.saveBoard).toHaveBeenCalledTimes(2)
  })
  it('serializes a later revision behind an in-flight save', async () => {
    const id = store.getState().create('A')
    let finish!: () => void
    io.saveBoard.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const writing = store.getState().flush()
    store.getState().update(id, b => ({ ...b, name: 'A final' }))
    finish(); await writing
    expect(io.saveBoard.mock.calls.map(call => (call[0] as ImageBoard).name)).toEqual(['A', 'A final'])
  })
  it('claims a queued prompt once and clears it when switching projects', () => {
    const a = store.getState().create('A'), b = store.getState().create('B')
    store.getState().open(a); store.getState().queue('session-a', 'hello')
    const seq = store.getState().pending!.seq
    expect(store.getState().consume(seq)).toBe(true)
    expect(store.getState().consume(seq)).toBe(false)
    store.getState().queue('session-a', 'next'); store.getState().open(b)
    expect(store.getState().pending).toBeNull()
  })
})
