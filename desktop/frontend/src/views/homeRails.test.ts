// @vitest-environment happy-dom
// 主页左右栏什么时候收(11-08 用户嫌「窗口稍小一点就收」):空栏不占地方、栏先缩到 216 再收。
// 门槛之外再扫一遍宽度,钉住 11-03 定的两条:中间 840 不缩、和栏之间至少 32,谁也不越界。
import { describe, expect, it } from 'vitest'
import { CENTER_W, EDGE, GAP, RAIL_MIN, RAIL_W, STRIP_W, centerShift, railModes, type RailMode } from './HomeWidgetParts'

const both = { left: true, right: true }
const rightOnly = { left: false, right: true }
const at = (w: number, has = both): string => { const m = railModes(w, has); return `${m.left}-${m.right}@${m.railW}` }

describe('railModes', () => {
  it('default layout (left empty): the right rail stays open down to 1120, shrinking from 256 to 216 first', () => {
    expect(at(1160, rightOnly)).toBe('open-open@256')
    expect(at(1140, rightOnly)).toBe('open-open@236')
    expect(at(1120, rightOnly)).toBe('open-open@216')
    expect(at(1119, rightOnly).endsWith('strip@256')).toBe(true)
    expect(at(940, rightOnly).endsWith('strip@256')).toBe(true)
    expect(at(939, rightOnly)).toBe('hidden-hidden@256')
  })

  it('both rails used: three open from 1368 (256 wide from 1448), then left strip, then both strips, then none', () => {
    expect(at(1448)).toBe('open-open@256')
    expect(at(1400)).toBe('open-open@232')
    expect(at(1368)).toBe('open-open@216')
    expect(at(1367)).toBe('strip-open@256')
    expect(at(1188)).toBe('strip-open@216')
    expect(at(1187)).toBe('strip-strip@256')
    expect(at(1008)).toBe('strip-strip@256')
    expect(at(1007)).toBe('hidden-hidden@256')
  })

  it('is never stricter than before 11-08 (1448 / 1228 / 1008 with both rails counted)', () => {
    const old = (w: number): [RailMode, RailMode] => {
      const s = (open: boolean): RailMode => (open ? 'open' : w >= 1008 ? 'strip' : 'hidden')
      return [s(w >= 1448), s(w >= 1228)]
    }
    const rank: Record<RailMode, number> = { hidden: 0, strip: 1, open: 2 }
    for (let w = 800; w <= 1800; w++) {
      for (const has of [both, rightOnly, { left: true, right: false }]) {
        const m = railModes(w, has), [l, r] = old(w)
        if (has.left) expect(rank[m.left]).toBeGreaterThanOrEqual(rank[l])
        if (has.right) expect(rank[m.right]).toBeGreaterThanOrEqual(rank[r])
      }
    }
  })
})

describe('centerShift with the rail width', () => {
  it('keeps the 840 center at least 32 from every drawn rail and inside the page, at every width', () => {
    for (let w = 900; w <= 1800; w++) {
      for (const has of [both, rightOnly, { left: true, right: false }]) {
        const m = railModes(w, has)
        const x = (w - CENTER_W) / 2 + centerShift(w, { mode: m.left, shown: has.left }, { mode: m.right, shown: has.right }, m.railW)
        const width = (mode: RailMode): number => (mode === 'open' ? m.railW : mode === 'strip' ? STRIP_W : 0)
        expect(m.railW).toBeGreaterThanOrEqual(RAIL_MIN)
        expect(m.railW).toBeLessThanOrEqual(RAIL_W)
        if (has.left && m.left !== 'hidden') expect(x - (EDGE + width(m.left))).toBeGreaterThanOrEqual(GAP)
        if (has.right && m.right !== 'hidden') expect(w - EDGE - width(m.right) - (x + CENTER_W)).toBeGreaterThanOrEqual(GAP)
        if (m.left !== 'hidden' || m.right !== 'hidden') { expect(x).toBeGreaterThanOrEqual(0); expect(x + CENTER_W).toBeLessThanOrEqual(w) }
      }
    }
  })
})
