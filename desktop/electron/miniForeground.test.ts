import { describe, it, expect, vi, afterEach } from 'vitest'
import { foregroundSignalActive, startMiniPassThrough, topRightPosition } from './miniForeground'

afterEach(() => vi.useRealTimers())
describe('Mini during foreground Computer Use', () => {
  it('only accepts a live, bounded foreground lease, including short completed clicks', () => {
    const s = { v: 1, active: true, helperPid: 10, updatedAt: 1000, expiresAt: 3500 }
    expect(foregroundSignalActive(s, 1200)).toBe(true)
    expect(foregroundSignalActive(s, 3500)).toBe(false)
    expect(foregroundSignalActive({ ...s, expiresAt: Infinity }, 1200)).toBe(false)
    expect(foregroundSignalActive({ ...s, active: false, expiresAt: 1350 }, 1200)).toBe(true)
    expect(foregroundSignalActive({ ...s, active: false }, 1200)).toBe(false)
    expect(foregroundSignalActive({ ...s, updatedAt: 5000 }, 1200)).toBe(false)
    expect(foregroundSignalActive({ active: true, ageMs: 0 }, 1200)).toBe(false) // liveView != foreground
  })
  it('parks at the top-right of the work area, including secondary displays with negative origins', () => {
    expect(topRightPosition({ width: 320, height: 420 }, { x: 0, y: 25, width: 1440, height: 875 })).toEqual({ x: 1096, y: 49 })
    expect(topRightPosition({ width: 320, height: 420 }, { x: -1440, y: 0, width: 1440, height: 900 })).toEqual({ x: -344, y: 24 })
  })
  it('passes clicks through except under the pointer and restores hit testing on stop', () => {
    vi.useFakeTimers()
    let active = true, cursor = { x: 900, y: 600 }
    const win = { isDestroyed: () => false, getBounds: () => ({ x: 1096, y: 49, width: 320, height: 420 }), setIgnoreMouseEvents: vi.fn() }
    const stop = startMiniPassThrough(win, { active: () => active, cursor: () => cursor })
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true) // click-through from the first frame
    cursor = { x: 1200, y: 60 }; vi.advanceTimersByTime(60)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false) // grabbable under the pointer
    cursor = { x: 10, y: 10 }; vi.advanceTimersByTime(60)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true)
    active = false; vi.advanceTimersByTime(60)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false) // no Computer Use: an ordinary window
    const calls = win.setIgnoreMouseEvents.mock.calls.length
    vi.advanceTimersByTime(500)
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledTimes(calls) // only transitions reach the OS
    active = true; vi.advanceTimersByTime(60); stop()
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
