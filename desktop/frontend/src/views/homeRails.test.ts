// @vitest-environment happy-dom
// 主页左右栏什么时候收、中间多宽(11-09 用户在试玩页拉出的手感):中间 720、可缩到 500,栏 216–256,缝 32,外边 16,两边对称。
// 门槛之外逐宽度扫一遍:中间不小于 500、和画出来的栏至少隔 32、不越界、永远在正中(对称)。
import { describe, expect, it } from 'vitest'
import { CENTER_MIN, CENTER_W, EDGE, GAP, RAIL_GEOMETRY, RAIL_MIN, RAIL_W, STRIP_W, centerShift, railModes, type RailGeometry, type RailMode } from './HomeWidgetParts'

const both = { left: true, right: true }
const rightOnly = { left: false, right: true }
const leftOnly = { left: true, right: false }
const at = (w: number, has = both, g?: RailGeometry): string => { const m = railModes(w, has, g); return `${m.left}-${m.right}@${m.railW}/${m.centerW}` }
/** 最小的主页宽:从这一宽起 railModes 满足 ok。 */
const first = (has: { left: boolean; right: boolean }, ok: (m: ReturnType<typeof railModes>) => boolean, g?: RailGeometry): number | null => {
  for (let w = 400; w <= 2600; w++) if (ok(railModes(w, has, g))) return w
  return null
}

describe('railModes (11-09 numbers)', () => {
  it('uses the numbers picked in the playground', () => {
    expect(RAIL_GEOMETRY).toEqual({ centerW: 720, centerMin: 500, railW: 256, railMin: 216, gap: 32, edge: 16, maxShift: 0 })
  })

  it('both rails: full width from 1328, open from 1028 (center shrinks 720 → 500 first), both strips from 668, then none', () => {
    expect(at(1400)).toBe('open-open@256/720')
    expect(at(1328)).toBe('open-open@256/720')
    expect(at(1300)).toBe('open-open@242/720')
    expect(at(1248)).toBe('open-open@216/720')
    expect(at(1100)).toBe('open-open@216/572')
    expect(at(1028)).toBe('open-open@216/500')
    expect(at(1027).startsWith('strip-strip@256/')).toBe(true)
    expect(at(668)).toBe('strip-strip@256/500')
    expect(at(667).startsWith('hidden-hidden')).toBe(true)
  })

  it('symmetric: only the right rail used gives the same thresholds as both rails (the empty left keeps its space)', () => {
    for (const has of [rightOnly, leftOnly]) {
      expect(first(has, (m) => m.right === 'open' && m.left === 'open')).toBe(CENTER_MIN + 2 * (EDGE + RAIL_MIN + GAP))
      expect(first(has, (m) => m.right !== 'hidden')).toBe(CENTER_MIN + 2 * (EDGE + STRIP_W + GAP))
    }
    // 1315(1512 窗、110%):中间 720,剩下的两边平分(空的左边也留),栏 249
    expect(at(1315, rightOnly)).toBe('open-open@249/720')
  })

  it('never shows one strip next to one open rail (that would be lopsided)', () => {
    for (let w = 400; w <= 2000; w++) expect(railModes(w, both).left === 'strip' && railModes(w, both).right === 'open').toBe(false)
  })

  it('is never stricter than before 11-08 (1448 / 1228 / 1008 with both rails counted)', () => {
    const old = (w: number): [RailMode, RailMode] => {
      const s = (open: boolean): RailMode => (open ? 'open' : w >= 1008 ? 'strip' : 'hidden')
      return [s(w >= 1448), s(w >= 1228)]
    }
    const rank: Record<RailMode, number> = { hidden: 0, strip: 1, open: 2 }
    for (let w = 800; w <= 1800; w++) {
      for (const has of [both, rightOnly, leftOnly]) {
        const m = railModes(w, has), [l, r] = old(w)
        if (has.left) expect(rank[m.left]).toBeGreaterThanOrEqual(rank[l])
        if (has.right) expect(rank[m.right]).toBeGreaterThanOrEqual(rank[r])
      }
    }
  })
})

describe('centerShift with the computed center', () => {
  const sweep = (g: RailGeometry): void => {
    for (let w = 600; w <= 2000; w++) {
      for (const has of [both, rightOnly, leftOnly]) {
        const m = railModes(w, has, g)
        if (m.left === 'hidden' && m.right === 'hidden') continue
        const x = (w - m.centerW) / 2 + centerShift(w, { mode: m.left, shown: has.left }, { mode: m.right, shown: has.right }, m.railW, g, m.centerW)
        const width = (mode: RailMode): number => (mode === 'open' ? m.railW : mode === 'strip' ? STRIP_W : 0)
        expect(m.centerW).toBeGreaterThanOrEqual(g.centerMin)
        expect(m.centerW).toBeLessThanOrEqual(g.centerW)
        if ((has.left && m.left === 'open') || (has.right && m.right === 'open')) { expect(m.railW).toBeGreaterThanOrEqual(g.railMin); expect(m.railW).toBeLessThanOrEqual(g.railW) }
        if (has.left) expect(x - (g.edge + width(m.left))).toBeGreaterThanOrEqual(g.gap)
        if (has.right) expect(w - g.edge - width(m.right) - (x + m.centerW)).toBeGreaterThanOrEqual(g.gap)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x + m.centerW).toBeLessThanOrEqual(w)
        expect(Math.abs(x - (w - m.centerW) / 2)).toBeLessThanOrEqual(g.maxShift + 0.5)
      }
    }
  }
  it('keeps the center between 500 and 720, 32 from every drawn rail, inside the page and dead center, at every width', () => {
    expect([CENTER_W, CENTER_MIN, RAIL_W, RAIL_MIN]).toEqual([720, 500, 256, 216])
    sweep(RAIL_GEOMETRY)
  })
  it('the geometry knobs still hold the same invariants with other numbers (offset allowed, center fixed, wider margins)', () => {
    sweep({ centerW: 840, centerMin: 640, railW: 300, railMin: 180, gap: 16, edge: 8, maxShift: 400 })
    sweep({ centerW: 760, centerMin: 760, railW: 240, railMin: 200, gap: 24, edge: 0, maxShift: 0 })
    sweep({ centerW: 900, centerMin: 600, railW: 256, railMin: 256, gap: 48, edge: 32, maxShift: 64 })
  })
})
