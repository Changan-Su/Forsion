import { describe, it, expect } from 'vitest'
import { rectUnderPoint, nearestEdge, collapsedBounds, expandedBounds, visibleRect, pointInRect, growRect, type Rect, type Edge } from './windowGeometry'

const WA: Rect = { x: 0, y: 0, width: 1440, height: 900 }

describe('rectUnderPoint', () => {
  const a: Rect = { x: 0, y: 0, width: 100, height: 100 }
  const b: Rect = { x: 50, y: 50, width: 100, height: 100 } // 与 a 重叠,数组更后 = z 更高
  it('hits the topmost (later) rect in overlap', () => {
    expect(rectUnderPoint([a, b], 60, 60)).toBe(1) // 落在重叠区 → 取后者
  })
  it('hits the only containing rect', () => {
    expect(rectUnderPoint([a, b], 10, 10)).toBe(0)
    expect(rectUnderPoint([a, b], 140, 140)).toBe(1)
  })
  it('misses outside all', () => {
    expect(rectUnderPoint([a, b], 500, 500)).toBe(-1)
  })
  it('right/bottom edges are exclusive (x+width not inside)', () => {
    expect(rectUnderPoint([a], 100, 10)).toBe(-1) // x==100 == a.x+width → 不在内
  })
})

describe('nearestEdge', () => {
  it('detects each edge when flush', () => {
    expect(nearestEdge({ x: 0, y: 400, width: 300, height: 400 }, WA)).toBe('left')
    expect(nearestEdge({ x: 1140, y: 400, width: 300, height: 400 }, WA)).toBe('right')
    expect(nearestEdge({ x: 500, y: 0, width: 300, height: 400 }, WA)).toBe('top')
    expect(nearestEdge({ x: 500, y: 500, width: 300, height: 400 }, WA)).toBe('bottom')
  })
  it('returns null when centered away from all edges', () => {
    expect(nearestEdge({ x: 500, y: 300, width: 300, height: 300 }, WA)).toBeNull()
  })
  it('honors threshold', () => {
    expect(nearestEdge({ x: 10, y: 300, width: 300, height: 300 }, WA, 12)).toBe('left')
    expect(nearestEdge({ x: 40, y: 300, width: 300, height: 300 }, WA, 12)).toBeNull()
  })
})

// 折叠后「露出工作区内的可见部分宽/高」必须恰为 peek —— 这条不变量正是四个边最易算错处。
function visibleSpan(b: Rect, edge: Edge, wa: Rect): number {
  if (edge === 'left') return (b.x + b.width) - wa.x // 右缘 - 工作区左
  if (edge === 'right') return (wa.x + wa.width) - b.x
  if (edge === 'top') return (b.y + b.height) - wa.y
  return (wa.y + wa.height) - b.y // bottom
}

describe('collapsedBounds / expandedBounds', () => {
  const card: Rect = { x: 600, y: 300, width: 300, height: 400 }
  const edges: Edge[] = ['left', 'right', 'top', 'bottom']
  const peek = 8

  it('collapse leaves exactly `peek` visible on the snapped edge, size unchanged', () => {
    for (const e of edges) {
      const c = collapsedBounds(card, e, WA, peek)
      expect(c.width).toBe(card.width)
      expect(c.height).toBe(card.height)
      expect(visibleSpan(c, e, WA)).toBe(peek)
    }
  })

  it('expand puts the card flush inside the work area on that edge', () => {
    for (const e of edges) {
      const x = expandedBounds(card, e, WA)
      if (e === 'left') expect(x.x).toBe(WA.x)
      if (e === 'right') expect(x.x + x.width).toBe(WA.x + WA.width)
      if (e === 'top') expect(x.y).toBe(WA.y)
      if (e === 'bottom') expect(x.y + x.height).toBe(WA.y + WA.height)
    }
  })

  it('expand∘collapse is idempotent (round-trip back to flush)', () => {
    for (const e of edges) {
      const once = expandedBounds(collapsedBounds(card, e, WA, peek), e, WA)
      const twice = expandedBounds(collapsedBounds(once, e, WA, peek), e, WA)
      expect(twice).toEqual(once)
    }
  })
})

describe('visibleRect / pointInRect / growRect (mini 悬停触发+迟滞)', () => {
  const card: Rect = { x: 600, y: 300, width: 300, height: 400 }
  it('collapsed sliver visible rect is exactly the peek strip on that edge', () => {
    const c = collapsedBounds(card, 'left', WA, 14)
    const v = visibleRect(c, WA)
    expect(v.x).toBe(WA.x)
    expect(v.width).toBe(14) // 露出可辨识的把手
    expect(v.height).toBe(card.height)
  })
  it('cursor at the sliver is inside; away is outside (drives expand)', () => {
    const c = collapsedBounds(card, 'right', WA, 14)
    const v = growRect(visibleRect(c, WA), 6) // 触发容差
    expect(pointInRect(WA.x + WA.width - 2, c.y + 10, v)).toBe(true) // 贴右边=命中薄条
    expect(pointInRect(WA.x + WA.width - 200, c.y + 10, v)).toBe(false) // 深入屏内=不命中
  })
  it('hysteresis: small move inside expanded bounds stays (no flicker collapse)', () => {
    const grown = growRect(card, 24)
    expect(pointInRect(card.x + card.width + 10, card.y + 10, grown)).toBe(true) // 出界 10<24 仍算在内
    expect(pointInRect(card.x + card.width + 40, card.y + 10, grown)).toBe(false) // 出界 40>24 才算离开
  })
})
