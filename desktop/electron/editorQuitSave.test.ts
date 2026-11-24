import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorQuitSave, QUIT_SAVE_ASK, QUIT_SAVE_DONE, unloadWrite } from './editorQuitSave'

class FakeRenderer extends EventEmitter {
  sent: Array<{ channel: string; payload: any }> = []
  destroyed = false
  constructor(public id: number, private events: EventEmitter, private answer: 'yes' | 'no' | 'throw' = 'yes') { super() }
  isDestroyed(): boolean { return this.destroyed }
  send(channel: string, payload: any): void {
    if (this.answer === 'throw') throw new Error('gone')
    this.sent.push({ channel, payload })
    if (this.answer === 'yes') queueMicrotask(() => this.events.emit(QUIT_SAVE_DONE, { sender: { id: this.id } }, payload.requestId))
  }
  destroy(): void { this.destroyed = true; this.emit('destroyed') }
}

const setup = (timeoutMs = 1000) => {
  const events = new EventEmitter()
  const saver = createEditorQuitSave({ events, timeoutMs, newId: () => 'req-1' })
  return { events, saver }
}

afterEach(() => { vi.useRealTimers() })

describe('createEditorQuitSave', () => {
  it('does not wait when no window has a workspace editor open', () => {
    const { events, saver } = setup()
    const r = new FakeRenderer(1, events)
    saver.report(r, 2)
    saver.report(r, 0)
    expect(saver.quit()).toBeNull()
    expect(r.sent).toEqual([])
  })

  it('asks every window with open editors and resolves once all answered', async () => {
    const { events, saver } = setup()
    const a = new FakeRenderer(1, events); const b = new FakeRenderer(2, events); const idle = new FakeRenderer(3, events)
    saver.report(a, 1); saver.report(b, 3); saver.report(idle, 0)
    await saver.quit()
    expect(a.sent).toEqual([{ channel: QUIT_SAVE_ASK, payload: { requestId: 'req-1' } }])
    expect(b.sent).toHaveLength(1)
    expect(idle.sent).toEqual([])
    expect(events.listenerCount(QUIT_SAVE_DONE)).toBe(0)
  })

  it('waits for the slowest window, ignores answers to other requests and from other windows', async () => {
    vi.useFakeTimers()
    const { events, saver } = setup(5000)
    const slow = new FakeRenderer(1, events, 'no')
    saver.report(slow, 1)
    let done = false
    void saver.quit()!.then(() => { done = true })
    events.emit(QUIT_SAVE_DONE, { sender: { id: 1 } }, 'other-request')
    events.emit(QUIT_SAVE_DONE, { sender: { id: 9 } }, 'req-1')
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(false)
    events.emit(QUIT_SAVE_DONE, { sender: { id: 1 } }, 'req-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('a window that goes away or cannot be asked counts as done', async () => {
    const { events, saver } = setup()
    const gone = new FakeRenderer(1, events, 'no'); const broken = new FakeRenderer(2, events, 'throw')
    saver.report(gone, 1); saver.report(broken, 1)
    const p = saver.quit()!
    gone.destroy()
    await expect(p).resolves.toBeUndefined()
    expect(gone.listenerCount('destroyed')).toBe(0)
  })

  it('a hung window cannot keep the app from quitting: resolves at the cap', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const events = new EventEmitter()
    const saver = createEditorQuitSave({ events, timeoutMs: 5000, log })
    saver.report(new FakeRenderer(1, events, 'no'), 1)
    let done = false
    void saver.quit()!.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(4999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(log).toHaveBeenCalledOnce()
    expect(events.listenerCount(QUIT_SAVE_DONE)).toBe(0)
  })

  it('forgets a window that navigated or was destroyed before the quit', () => {
    const { events, saver } = setup()
    const reloaded = new FakeRenderer(1, events); const dead = new FakeRenderer(2, events)
    saver.report(reloaded, 1); saver.report(dead, 1)
    saver.forget(1)
    dead.destroyed = true
    expect(saver.quit()).toBeNull()
    expect(reloaded.sent).toEqual([])
  })

  it('once per quit: the before-quit after a restart that already asked gets null, a second ask while pending the same promise', async () => {
    const { events, saver } = setup()
    const r = new FakeRenderer(1, events, 'no')
    saver.report(r, 1)
    const first = saver.quit()!
    expect(saver.quit()).toBe(first)
    events.emit(QUIT_SAVE_DONE, { sender: { id: 1 } }, 'req-1')
    await first
    expect(saver.quit()).toBeNull() // must not make that quit take the app.exit route
    expect(r.sent).toHaveLength(1)
  })

  it('reset() after a restart that did not happen: the next quit asks again', async () => {
    const { events, saver } = setup()
    const r = new FakeRenderer(1, events)
    saver.report(r, 1)
    await saver.quit()
    saver.reset()
    await saver.quit()
    expect(r.sent).toHaveLength(2)
  })
})

describe('unloadWrite', () => {
  const ok = (mtimeMs = 2) => Promise.resolve({ ok: true, mtimeMs })
  it('passes a plain write through', async () => {
    await expect(unloadWrite({ write: () => ok(7), read: async () => null }, '/a.md', 'x', 1)).resolves.toEqual({ ok: true, mtimeMs: 7 })
  })
  it('a refused CAS over a file that already holds exactly these bytes is a save, not a conflict', async () => {
    const write = () => Promise.resolve({ conflict: true, mtimeMs: 9 })
    await expect(unloadWrite({ write, read: async () => 'same' }, '/a.md', 'same', 1)).resolves.toEqual({ ok: true, mtimeMs: 9 })
    await expect(unloadWrite({ write, read: async () => 'theirs' }, '/a.md', 'mine', 1)).resolves.toEqual({ conflict: true, mtimeMs: 9 })
    await expect(unloadWrite({ write, read: async () => { throw new Error('gone') } }, '/a.md', 'mine', 1)).resolves.toEqual({ conflict: true, mtimeMs: 9 })
  })
  it('a failed write answers with the error instead of throwing', async () => {
    await expect(unloadWrite({ write: () => Promise.reject(new Error('EACCES')), read: async () => null }, '/a.md', 'x')).resolves.toEqual({ error: 'EACCES' })
  })
  it('always answers: a write stuck on a stalled mount resolves at the cap', async () => {
    vi.useFakeTimers()
    let answer: unknown = null
    void unloadWrite({ write: () => new Promise(() => {}), read: async () => null, capMs: 3000 }, '/a.md', 'x', 1).then((r) => { answer = r })
    await vi.advanceTimersByTimeAsync(2999)
    expect(answer).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toEqual({ error: 'timeout' })
  })
})
