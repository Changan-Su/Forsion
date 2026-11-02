import { describe, expect, it } from 'vitest'
import { miniResizeShape } from './miniResizeShape'

describe('Mini native resize corner mask', () => {
  it('preserves the painted interior and masks all four stale square corners at min/max sizes', () => {
    for (const [width, height] of [[260, 160], [640, 900]]) {
      for (const radius of [9, 16, 20]) {
        const rows = miniResizeShape(width, height, radius)
        const contains = (x: number, y: number) => rows.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
        for (const x of [0, width - 1]) for (const y of [0, height - 1]) expect(contains(x, y)).toBe(false)
        for (let y = 0; y < height; y++) expect(contains(width / 2, y)).toBe(true)
        for (const r of rows) {
          expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0)
          expect(r.x + r.width).toBeLessThanOrEqual(width); expect(r.y + r.height).toBeLessThanOrEqual(height)
        }
      }
    }
  })
  it('lets square themes retain a rectangular native window', () => {
    expect(miniResizeShape(260, 160, 0)).toEqual([])
  })
})
