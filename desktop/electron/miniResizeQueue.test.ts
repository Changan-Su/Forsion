import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMiniResizeQueue } from './miniResizeQueue'
const bounds = (width: number) => ({ x: 300, y: 224, width, height: 400 })
describe('Mini native resize backpressure', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('collapses a burst of pointer reports into the latest native bounds', () => {
    const apply = vi.fn(); const queue = createMiniResizeQueue(apply)
    for (let width = 640; width >= 260; width--) queue.push(bounds(width))
    expect(apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(apply.mock.calls).toEqual([[bounds(260)]])
    vi.advanceTimersByTime(1000)
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it('commits the final point on release and never replays an older pending size', () => {
    const apply = vi.fn(); const queue = createMiniResizeQueue(apply)
    queue.push(bounds(320)); vi.advanceTimersByTime(16)
    queue.push(bounds(300)); queue.push(bounds(280)); queue.flush()
    expect(apply.mock.calls).toEqual([[bounds(320)], [bounds(280)]])
    vi.advanceTimersByTime(1000)
    expect(apply).toHaveBeenCalledTimes(2)
  })
  it('a closed or reloaded window cancels its pending resize', () => {
    const apply = vi.fn(); const queue = createMiniResizeQueue(apply)
    queue.push(bounds(260)); queue.cancel(); queue.flush(); vi.advanceTimersByTime(1000)
    expect(apply).not.toHaveBeenCalled()
    queue.push(bounds(400)); vi.advanceTimersByTime(16)
    expect(apply.mock.calls).toEqual([[bounds(400)]])
  })
})
