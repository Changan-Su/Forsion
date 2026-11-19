import { describe, expect, it } from 'vitest'
import { outputSize, recordBitrate, recordSize, sanitizeCaptureRequest, toDipRect } from './pluginCapture'

describe('plugin capture geometry', () => {
  it('sanitizes the IPC request and refuses malformed shapes', () => {
    expect(sanitizeCaptureRequest({ rect: { x: 1, y: 2, width: 30, height: 40 }, format: 'png', scale: 1 }))
      .toEqual({ rect: { x: 1, y: 2, width: 30, height: 40 }, format: 'png', scale: 1 })
    expect(sanitizeCaptureRequest({ rect: { x: 1, y: 2, width: 30, height: 40 }, format: 'bgra' })).toEqual({ rect: { x: 1, y: 2, width: 30, height: 40 }, format: 'bgra' })
    for (const bad of [null, 'x', {}, { rect: { x: 0, y: 0, width: 0, height: 5 }, format: 'png' }, { rect: { x: 0, y: 0, width: NaN, height: 5 }, format: 'png' },
      { rect: { x: 0, y: 0, width: 5, height: 5 }, format: 'jpeg' }, { rect: { x: 0, y: 0, width: 5, height: 5 }, format: 'png', scale: 0 },
      { rect: { x: 0, y: 0, width: 5, height: 5 }, format: 'png', scale: '2' }]) {
      expect(sanitizeCaptureRequest(bad)).toBeNull()
    }
  })

  it('maps viewport CSS px to DIP through the webContents zoom, rounding each edge and clamping to the content', () => {
    expect(toDipRect({ x: 10, y: 20, width: 100, height: 50 }, 1, { width: 800, height: 600 })).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    // ⌘= zoom 1.1: same element, 10% more DIP
    expect(toDipRect({ x: 10, y: 20, width: 100, height: 50 }, 1.1, { width: 800, height: 600 })).toEqual({ x: 11, y: 22, width: 110, height: 55 })
    // fractional edges: each edge rounds on its own (no extra neighbour column)
    expect(toDipRect({ x: 10.4, y: 0.6, width: 20.2, height: 10 }, 1, { width: 800, height: 600 })).toEqual({ x: 10, y: 1, width: 21, height: 10 })
    expect(toDipRect({ x: 700, y: 500, width: 300, height: 300 }, 1, { width: 800, height: 600 })).toEqual({ x: 700, y: 500, width: 100, height: 100 })
    expect(toDipRect({ x: 900, y: 0, width: 50, height: 50 }, 1, { width: 800, height: 600 })).toBeNull()
  })

  it('only lowers the pixel density, never invents pixels', () => {
    const native = { width: 1600, height: 1000 }
    expect(outputSize(native, { width: 800, height: 500 })).toEqual(native)
    expect(outputSize(native, { width: 800, height: 500 }, 2)).toEqual(native)
    expect(outputSize(native, { width: 800, height: 500 }, 3)).toEqual(native) // a 2× screen can't give 3×
    expect(outputSize(native, { width: 800, height: 500 }, 1)).toEqual({ width: 800, height: 500 })
    expect(outputSize({ width: 800, height: 500 }, { width: 800, height: 500 }, 2)).toEqual({ width: 800, height: 500 }) // 1× screen asked for 2×
  })

  it('records even frame sizes, fitted into 4K', () => {
    expect(recordSize({ width: 801, height: 501 }, 2)).toEqual({ width: 1602, height: 1002 })
    expect(recordSize({ width: 333.3, height: 101 }, 1)).toEqual({ width: 332, height: 100 })
    const big = recordSize({ width: 3000, height: 1000 }, 2)
    expect(big.width).toBeLessThanOrEqual(3840)
    expect(big.height).toBeLessThanOrEqual(2160)
    expect(big.width % 2 + big.height % 2).toBe(0)
    expect(Math.abs(big.width / big.height - 3)).toBeLessThan(0.01)
  })

  it('picks a bitrate between 2 and 16 Mbps', () => {
    expect(recordBitrate({ width: 100, height: 100 }, 30)).toBe(2e6)
    expect(recordBitrate({ width: 3840, height: 2160 }, 60)).toBe(16e6)
    const mid = recordBitrate({ width: 1600, height: 1000 }, 30)
    expect(mid).toBeGreaterThan(2e6)
    expect(mid).toBeLessThan(16e6)
  })
})
