// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Bridge = {
  reportOpenEditors: ReturnType<typeof vi.fn>
  onQuitSave: (cb: () => Promise<void>) => () => void
  reloadWindow: ReturnType<typeof vi.fn>
  quitSave?: () => Promise<void>
}

let bridge: Bridge
const load = async () => {
  vi.resetModules()
  return import('./openMdEditors')
}

beforeEach(() => {
  bridge = {
    reportOpenEditors: vi.fn(),
    onQuitSave: (cb) => { bridge.quitSave = cb; return () => {} },
    reloadWindow: vi.fn(() => Promise.resolve()),
  }
  ;(window as unknown as { tangu?: object }).tangu = bridge
})
afterEach(() => { delete (window as { tangu?: unknown }).tangu })

const editor = (order: string[], name: string, save = () => Promise.resolve()) => ({
  save: vi.fn(() => { order.push(`${name}.save`); return save() }),
  saveSync: vi.fn(() => { order.push(`${name}.saveSync`) }),
})

describe('open workspace .md editors', () => {
  it('reports the open count to the host as editors come and go', async () => {
    const m = await load()
    const order: string[] = []
    const offA = m.registerOpenMdEditor(editor(order, 'a'))
    const offB = m.registerOpenMdEditor(editor(order, 'b'))
    offA(); offA()
    offB()
    expect(bridge.reportOpenEditors.mock.calls.map((c) => c[0])).toEqual([1, 2, 1, 0])
  })

  it('pagehide / beforeunload save every open editor synchronously, and never ask to stay on the page', async () => {
    const m = await load()
    const order: string[] = []
    m.registerOpenMdEditor(editor(order, 'a'))
    m.registerOpenMdEditor({ save: () => Promise.resolve(), saveSync: () => { order.push('broken'); throw new Error('x') } })
    m.registerOpenMdEditor(editor(order, 'c'))
    const ev = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    window.dispatchEvent(new Event('pagehide'))
    expect(order).toEqual(['a.saveSync', 'broken', 'c.saveSync', 'a.saveSync', 'broken', 'c.saveSync'])
  })

  it('the quit ask saves every editor and waits for writes still in flight', async () => {
    const m = await load()
    const order: string[] = []
    let release!: () => void
    m.registerOpenMdEditor(editor(order, 'a'))
    m.registerOpenMdEditor(editor(order, 'b', () => Promise.reject(new Error('disk full'))))
    m.pendingWrites.set('/p/closed.md', new Promise<void>((r) => { release = r }))
    let done = false
    void bridge.quitSave!().then(() => { done = true })
    await Promise.resolve(); await Promise.resolve()
    expect(order).toEqual(['a.save', 'b.save'])
    expect(done).toBe(false)
    release()
    await vi.waitFor(() => expect(done).toBe(true))
  })

  it('nothing open and nothing in flight → null (callers go ahead synchronously)', async () => {
    const m = await load()
    expect(m.saveOpenMdEditors()).toBeNull()
    const off = m.registerOpenMdEditor(editor([], 'a'))
    expect(m.saveOpenMdEditors()).not.toBeNull()
    off()
    expect(m.saveOpenMdEditors()).toBeNull()
  })

  it('reloadWindow() saves the open editors before asking the host to reload', async () => {
    const m = await load()
    const { reloadWindow } = await import('../reloadWindow')
    const order: string[] = []
    let release!: () => void
    m.registerOpenMdEditor(editor(order, 'a', () => new Promise<void>((r) => { release = r })))
    bridge.reloadWindow.mockImplementation(() => { order.push('reload'); return Promise.resolve() })
    reloadWindow()
    await Promise.resolve()
    expect(order).toEqual(['a.save'])
    release()
    await vi.waitFor(() => expect(order).toEqual(['a.save', 'reload']))
  })

  it('readers wait for every write outstanding on a path, not only the latest one', async () => {
    const m = await load()
    let a!: () => void; let b!: () => void
    m.trackWrite('/p/x.md', new Promise<void>((r) => { a = r }))
    m.trackWrite('/p/x.md', new Promise<void>((_r, rej) => { b = () => rej(new Error('conflict')) }))
    let done = false
    void m.pendingWrites.get('/p/x.md')!.then(() => { done = true })
    b()
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toBe(false)
    expect(m.pendingWrites.has('/p/x.md')).toBe(true)
    a()
    await vi.waitFor(() => expect(done).toBe(true))
    await vi.waitFor(() => expect(m.pendingWrites.has('/p/x.md')).toBe(false))
  })
})

