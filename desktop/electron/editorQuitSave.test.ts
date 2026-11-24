import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorQuitSave, QUIT_SAVE_ASK, QUIT_SAVE_DONE } from './editorQuitSave'

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
    expect(saver.quit()).toBeNull()
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
})
