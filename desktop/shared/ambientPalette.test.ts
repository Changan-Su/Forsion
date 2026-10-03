import { describe, expect, it } from 'vitest'
import { clampAmbientRect, paletteFromRgba } from './ambientPalette'

describe('ambient color sampling', () => {
  it('preserves vertical color bands and rejects empty captures', () => {
    expect(paletteFromRgba([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255], 1, 3)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
    expect(paletteFromRgba(new Uint8Array(12), 1, 3)).toBeNull()
    expect(paletteFromRgba([], 1, 3)).toBeNull()
  })
  it('clips sampling to its own window and rejects malformed dimensions', () => {
    expect(clampAmbientRect({ x: 10, y: 20, width: 5000, height: 3000 }, 800, 600)).toEqual({ x: 10, y: 20, width: 790, height: 580 })
    for (const width of [Infinity, NaN, -1, '400']) expect(clampAmbientRect({ x: 0, y: 0, width, height: 500 }, 800, 600)).toBeNull()
  })
})
