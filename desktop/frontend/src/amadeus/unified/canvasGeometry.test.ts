import { describe, expect, it } from 'vitest'
import { CARD_CLEARANCE, resolveCardRepulsion } from './canvasGeometry'

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

describe('resolveCardRepulsion', () => {
  it('keeps a non-overlapping drop exactly where the user released it', () => {
    expect(resolveCardRepulsion([{ x: 300, y: 0, w: 100, h: 80 }], [{ x: 0, y: 0, w: 120, h: 100 }])).toEqual({ x: 0, y: 0 })
  })

  it('pushes an overlapping card through the nearest edge and leaves clearance', () => {
    const moving = { x: 80, y: 20, w: 100, h: 80 }
    const obstacle = { x: 0, y: 0, w: 120, h: 100 }
    const push = resolveCardRepulsion([moving], [obstacle], { x: 200, y: 0 })
    const final = { ...moving, x: moving.x + push.x, y: moving.y + push.y }
    expect(push.x).toBeGreaterThan(0)
    expect(overlap(final, {
      x: obstacle.x - CARD_CLEARANCE,
      y: obstacle.y - CARD_CLEARANCE,
      w: obstacle.w + CARD_CLEARANCE * 2,
      h: obstacle.h + CARD_CLEARANCE * 2,
    })).toBe(false)
  })

  it('moves a multi-selection as one rigid group', () => {
    const moving = [
      { x: 80, y: 10, w: 100, h: 70 },
      { x: 80, y: 130, w: 100, h: 70 },
    ]
    const obstacles = [
      { x: 0, y: 0, w: 120, h: 90 },
      { x: 0, y: 120, w: 120, h: 90 },
    ]
    const push = resolveCardRepulsion(moving, obstacles, { x: 180, y: 0 })
    expect(push.x).toBeGreaterThan(0)
    expect((moving[1].x + push.x) - (moving[0].x + push.x)).toBe(0)
    expect((moving[1].y + push.y) - (moving[0].y + push.y)).toBe(120)
    for (const box of moving) for (const obstacle of obstacles) {
      expect(overlap({ ...box, x: box.x + push.x, y: box.y + push.y }, obstacle)).toBe(false)
    }
  })
})

