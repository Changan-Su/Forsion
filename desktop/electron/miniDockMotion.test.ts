import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMiniDockMotion, miniDockFrame } from './miniDockMotion'
import type { Edge } from './windowGeometry'

afterEach(() => vi.useRealTimers())
const bounds = { x: -1280, y: -900, width: 320, height: 420 }
function fixture() {
  const win = { isDestroyed: () => false, getContentBounds: () => bounds, setShape: vi.fn(), webContents: { send: vi.fn() } }
  return { win, motion: createMiniDockMotion(win) }
}
describe('Mini compositor docking', () => {
  it('keeps paint and OS hit testing in the same 14 DIP strip on all four edges', () => {
    for (const edge of ['left', 'right', 'top', 'bottom'] as Edge[]) {
      const { x, y, clip } = miniDockFrame(bounds, edge, 14)
      expect(clip.x).toBeGreaterThanOrEqual(0); expect(clip.y).toBeGreaterThanOrEqual(0)
      expect(clip.x + clip.width).toBeLessThanOrEqual(bounds.width)
      expect(clip.y + clip.height).toBeLessThanOrEqual(bounds.height)
      expect(Math.max(0, x)).toBe(clip.x); expect(Math.max(0, y)).toBe(clip.y)
      expect(Math.min(bounds.width, x + bounds.width) - clip.x).toBe(clip.width)
      expect(Math.min(bounds.height, y + bounds.height) - clip.y).toBe(clip.height)
    }
  })
  it('never lets an old collapse completion mask a newly expanded window', () => {
    const { win, motion } = fixture()
    motion.set('right', true, 14)
    const first = win.webContents.send.mock.calls.at(-1)![1].id
    motion.set('right', false, 14)
    const second = win.webContents.send.mock.calls.at(-1)![1].id
    win.setShape.mockClear()
    motion.finish(first)
    expect(win.setShape).not.toHaveBeenCalled(); expect(motion.pending()).toBe(true)
    motion.finish(second)
    expect(win.setShape).toHaveBeenLastCalledWith([]); expect(motion.pending()).toBe(false)
    motion.stop()
  })
  it('restores full OS hit testing on drag/reload and ignores late acknowledgements', () => {
    const { win, motion } = fixture()
    motion.set('left', true, 14)
    const request = win.webContents.send.mock.calls.at(-1)![1]
    motion.finish(request.id)
    expect(win.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 0, width: 14, height: 420 }])
    motion.reset()
    expect(win.setShape).toHaveBeenLastCalledWith([])
    win.setShape.mockClear(); motion.finish(request.id)
    expect(win.setShape).not.toHaveBeenCalled(); expect(motion.pending()).toBe(false)
  })
  it('releases a stalled animation and cancels all timers at close', () => {
    vi.useFakeTimers()
    const { win, motion } = fixture()
    motion.set('bottom', true, 14)
    vi.advanceTimersByTime(1200)
    expect(motion.pending()).toBe(false)
    expect(win.setShape).toHaveBeenLastCalledWith([{ x: 0, y: 406, width: 320, height: 14 }])
    motion.set('bottom', false, 14); motion.stop(); win.setShape.mockClear()
    vi.runAllTimers(); expect(win.setShape).not.toHaveBeenCalled()
  })
})
