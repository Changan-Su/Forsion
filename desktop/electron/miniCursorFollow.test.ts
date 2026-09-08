import { describe, it, expect, vi, afterEach } from 'vitest'
import { cursorPanelTarget, cursorTransitionSpeed, foregroundSignalActive, linearCursorStep, startMiniCursorFollow } from './miniCursorFollow'

afterEach(() => vi.useRealTimers())
describe('Mini foreground following', () => {
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
  it('uses constant straight-line velocity without teleporting or overshooting', () => {
    const a = linearCursorStep({ x: 0, y: 0 }, { x: 300, y: 400 }, 20, 1000)
    const b = linearCursorStep(a, { x: 300, y: 400 }, 20, 1000)
    expect(a).toEqual({ x: 12, y: 16 })
    expect(b).toEqual({ x: 24, y: 32 })
    expect(linearCursorStep({ x: 299, y: 399 }, { x: 300, y: 400 }, 20)).toEqual({ x: 300, y: 400 })
  })
  it('stays in the cursor display work area and avoids covering the cursor at edges', () => {
    const work = { x: -1440, y: 0, width: 1440, height: 900 }
    const target = cursorPanelTarget({ x: -10, y: 880 }, { x: 0, y: 0, width: 320, height: 420 }, work)
    expect(target).toEqual({ x: -354, y: 436 })
    expect(cursorPanelTarget({ x: -1435, y: 5 }, { x: 0, y: 0, width: 320, height: 420 }, work)).toEqual({ x: -1411, y: 29 })
  })
  it('makes short jumps visible with equal displacement per frame, then retargets from the current position', () => {
    const from = { x: 100, y: 100 }, target = { x: 148, y: 100 }
    const speed = cursorTransitionSpeed(from, target)
    const a = linearCursorStep(from, target, 20, speed), b = linearCursorStep(a, target, 20, speed)
    expect(a.x - from.x).toBeCloseTo(b.x - a.x)
    expect(b.x).toBeLessThan(120) // 48px must not complete in two frames.
    const reversed = { x: 80, y: 100 }
    const next = linearCursorStep(b, reversed, 16, cursorTransitionSpeed(b, reversed))
    expect(next.x).toBeLessThan(b.x); expect(next.x).toBeGreaterThan(reversed.x)
    let end = from
    for (let i = 0; i < 11; i++) end = linearCursorStep(end, target, 20, speed)
    expect(end.x).toBeCloseTo(target.x); expect(end.y).toBe(target.y)
  })
  it('is inactive in background, restores hit testing, and cleans up pending polls on close', async () => {
    vi.useFakeTimers()
    let active = false
    const win = { isDestroyed: () => false, isVisible: () => true, getBounds: () => ({ x: 0, y: 0, width: 320, height: 420 }),
      setPosition: vi.fn(), setIgnoreMouseEvents: vi.fn() }
    const following = vi.fn()
    const stop = startMiniCursorFollow(win, { readActive: async () => active, cursor: () => ({ x: 300, y: 200 }),
      workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }), onFollowing: following })
    await vi.advanceTimersByTimeAsync(100)
    expect(win.setPosition).not.toHaveBeenCalled()
    active = true
    await vi.advanceTimersByTimeAsync(300)
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(win.setPosition.mock.calls.every((c) => c[2] === false)).toBe(true)
    active = false
    await vi.advanceTimersByTimeAsync(500)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    stop()
    const count = win.setPosition.mock.calls.length
    await vi.advanceTimersByTimeAsync(200)
    expect(win.setPosition).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })
})
