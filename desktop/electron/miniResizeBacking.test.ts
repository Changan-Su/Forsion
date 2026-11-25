import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMiniResizeBacking, miniFrameCoversEdges } from './miniResizeBacking'

function fixture(hidden = false) {
  const callbacks: Array<(size: { width: number; height: number }) => void> = []
  const stop = vi.fn()
  const setNativeBackground = vi.fn()
  const backing = createMiniResizeBacking({
    setNativeBackground,
    watchPresentedFrames: (callback) => { callbacks.push(callback); return stop },
    canClearWithoutFrame: () => hidden,
  })
  return { backing, callbacks, setNativeBackground, stop }
}

afterEach(() => vi.useRealTimers())

describe('Windows Mini resize backing', () => {
  it('rejects a full-sized captured buffer that still has a transparent edge strip', () => {
    const size = { width: 320, height: 240 }
    const bitmap = Buffer.alloc(size.width * size.height * 4, 255)
    expect(miniFrameCoversEdges(bitmap, size, 16)).toBe(true)
    for (let y = 26; y < 35; y++) bitmap[((y + 1) * size.width - 1) * 4 + 3] = 0
    expect(miniFrameCoversEdges(bitmap, size, 16)).toBe(false)
  })

  it('keeps the theme colour until the released size is actually presented', () => {
    const { backing, callbacks, setNativeBackground, stop } = fixture()
    backing.setColor('#112233')
    expect(setNativeBackground).not.toHaveBeenCalled()
    backing.begin()
    backing.begin()
    backing.settle({ width: 800, height: 440 }, 20)
    callbacks[0]({ width: 799, height: 440 })
    expect(setNativeBackground.mock.calls).toEqual([['#112233']])
    callbacks[0]({ width: 800, height: 440 })
    expect(setNativeBackground.mock.calls).toEqual([['#112233'], ['#00000000']])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('cancels the old release when a new drag starts and clears on docking or reload', () => {
    vi.useFakeTimers()
    const { backing, callbacks, setNativeBackground, stop } = fixture()
    backing.begin()
    backing.settle({ width: 300, height: 200 }, 16)
    backing.begin()
    backing.setColor('#ffeedd')
    callbacks[0]({ width: 300, height: 200 })
    vi.runAllTimers()
    expect(setNativeBackground.mock.calls).toEqual([['#fbf8f5'], ['#ffeedd']])
    backing.clear()
    expect(setNativeBackground.mock.calls.at(-1)).toEqual(['#00000000'])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('restores transparency and unsubscribes if an occluded window never presents', () => {
    vi.useFakeTimers()
    const { backing, stop, setNativeBackground } = fixture(true)
    backing.begin()
    backing.settle({ width: 300, height: 200 }, 16)
    vi.runAllTimers()
    expect(setNativeBackground.mock.calls.at(-1)).toEqual(['#00000000'])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stops sampling a stalled visible window without exposing transparent strips', () => {
    vi.useFakeTimers()
    const { backing, stop, setNativeBackground } = fixture()
    backing.begin()
    backing.settle({ width: 300, height: 200 }, 16)
    vi.runAllTimers()
    expect(setNativeBackground.mock.calls).toEqual([['#fbf8f5']])
    expect(stop).toHaveBeenCalledTimes(1)
    backing.clear()
    expect(setNativeBackground.mock.calls.at(-1)).toEqual(['#00000000'])
  })
})
