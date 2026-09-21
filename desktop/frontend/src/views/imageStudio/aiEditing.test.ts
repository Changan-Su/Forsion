import { describe, expect, it } from 'vitest'
import { expansionBox } from './aiEditing'

describe('expansion geometry', () => {
  it('keeps the complete source centered with real margins at the requested aspect ratio', () => {
    for (const [w, h] of [[800, 1000], [1600, 600], [1000, 1000]]) {
      for (const ratio of ['1:1', '16:9', '9:16']) {
        const box = expansionBox(w, h, ratio, .5), [rw, rh] = ratio.split(':').map(Number)
        expect(box.w).toBeGreaterThanOrEqual(w * 1.5)
        expect(box.h).toBeGreaterThanOrEqual(h * 1.5)
        expect(Math.abs(box.w / box.h - rw / rh)).toBeLessThan(.002)
        expect(Math.abs(box.x - (box.w - w) / 2)).toBeLessThan(1)
        expect(Math.abs(box.y - (box.h - h) / 2)).toBeLessThan(1)
      }
    }
  })
})
