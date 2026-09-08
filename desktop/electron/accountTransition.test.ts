import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForAccountRenderers } from './accountTransition'

function renderer(id: number) {
  return Object.assign(new EventEmitter(), { id, send: vi.fn() })
}
afterEach(() => vi.useRealTimers())

describe('account transition editor barrier', () => {
  it('requires every loaded editor and ignores wrong windows and stale acknowledgements', async () => {
    const events = new EventEmitter()
    const a = renderer(1), b = renderer(2)
    const barrier = waitForAccountRenderers([a, b], events)
    const complete = vi.fn()
    void barrier.then(complete)
    const requestId = a.send.mock.calls[0][1].requestId
    events.emit('auth:ready', { sender: a }, 'old-request')
    events.emit('auth:ready', { sender: { id: 3 } }, requestId)
    events.emit('auth:ready', { sender: a }, requestId)
    await Promise.resolve()
    expect(complete).not.toHaveBeenCalled()
    events.emit('auth:ready', { sender: b }, requestId)
    await barrier
    expect(complete).toHaveBeenCalledOnce()
    expect(events.listenerCount('auth:ready')).toBe(0)
  })

  it('fails a switch when an editor cannot flush and cleans listeners', async () => {
    const events = new EventEmitter(), a = renderer(1)
    const barrier = waitForAccountRenderers([a], events)
    events.emit('auth:ready', { sender: a }, a.send.mock.calls[0][1].requestId, 'Disk is full')
    await expect(barrier).rejects.toThrow('Disk is full')
    expect(a.listenerCount('destroyed')).toBe(0)
  })

  it('timeouts leave credentials unchanged by rejecting the barrier', async () => {
    vi.useFakeTimers()
    const events = new EventEmitter(), a = renderer(1)
    const barrier = waitForAccountRenderers([a], events, 50).catch((e) => e)
    await vi.advanceTimersByTimeAsync(51)
    expect((await barrier).message).toContain('Account change cancelled')
    expect(events.listenerCount('auth:ready')).toBe(0)
  })
})
