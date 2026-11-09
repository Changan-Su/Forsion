// @vitest-environment happy-dom
// 主页左右栏什么时候收(11-08 用户嫌「窗口稍小一点就收」):空栏不占地方、栏先缩到 216 再收。
// 门槛之外再扫一遍宽度,钉住 11-03 定的两条:中间 840 不缩、和栏之间至少 32,谁也不越界。
import { describe, expect, it } from 'vitest'
import { CENTER_W, EDGE, GAP, RAIL_MIN, RAIL_W, STRIP_W, centerShift, railModes, type RailMode } from './HomeWidgetParts'
import { RAIL_GEOMETRY, railGeometry, railThresholds, resetRailTuning, setRailTuning, type RailGeometry } from './homeRails'

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

// 11-09 dev 里加了调节面板(HomeRailTuner):六个数可调,缺省一个不变;中间可以先缩到「中间最窄」再收栏。
describe('rail geometry tuning', () => {
  it('default geometry reports the same thresholds as above', () => {
    expect(railThresholds(RAIL_GEOMETRY)).toEqual({
      both: { full: 1448, open: 1368, leftStrip: 1188, strips: 1008 },
      right: { open: 1120, strip: 940 },
    })
  })

  it('a shrinkable center keeps both rails open at 1320 (110% zoom in a 1512 window)', () => {
    expect(railModes(1320, both)).toMatchObject({ left: 'strip', right: 'open' })
    const g: RailGeometry = { ...RAIL_GEOMETRY, centerMin: 720 }
    // 1320 − 2×(16+32) = 1224;两栏各 216 后中间剩 792 ≥ 720
    expect(railModes(1320, both, g)).toEqual({ left: 'open', right: 'open', railW: 216, centerW: 792 })
    expect(railThresholds(g).both.open).toBe(720 + 2 * 216 + 2 * 48)
  })

  it('a smaller gap and margin move the three-column threshold by exactly what they save', () => {
    const g: RailGeometry = { ...RAIL_GEOMETRY, gap: 16, edge: 8 }
    expect(railThresholds(g).both.open).toBe(840 + 2 * 216 + 2 * (8 + 16))
  })

  it('keeps every tuned layout inside its own bounds at every width', () => {
    const geos: RailGeometry[] = [
      { centerW: 840, centerMin: 640, railW: 300, railMin: 180, gap: 16, edge: 8 },
      { centerW: 760, centerMin: 760, railW: 240, railMin: 200, gap: 24, edge: 0 },
      { centerW: 900, centerMin: 600, railW: 256, railMin: 256, gap: 48, edge: 32 },
    ]
    for (const g of geos) {
      for (let w = 700; w <= 2000; w += 3) {
        for (const has of [both, rightOnly, { left: true, right: false }]) {
          const m = railModes(w, has, g)
          const x = (w - m.centerW) / 2 + centerShift(w, { mode: m.left, shown: has.left }, { mode: m.right, shown: has.right }, m.railW, g, m.centerW)
          const width = (mode: RailMode): number => (mode === 'open' ? m.railW : mode === 'strip' ? STRIP_W : 0)
          if (m.left === 'hidden' && m.right === 'hidden') continue
          expect(m.centerW).toBeGreaterThanOrEqual(g.centerMin)
          expect(m.centerW).toBeLessThanOrEqual(g.centerW)
          if ((has.left && m.left === 'open') || (has.right && m.right === 'open')) { expect(m.railW).toBeGreaterThanOrEqual(g.railMin); expect(m.railW).toBeLessThanOrEqual(g.railW) }
          if (has.left) expect(x - (g.edge + width(m.left))).toBeGreaterThanOrEqual(g.gap)
          if (has.right) expect(w - g.edge - width(m.right) - (x + m.centerW)).toBeGreaterThanOrEqual(g.gap)
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x + m.centerW).toBeLessThanOrEqual(w)
        }
      }
    }
  })

  it('the dev store clamps, keeps min ≤ max (the knob just moved wins) and resets', () => {
    setRailTuning('railMin', 300)
    expect(railGeometry()).toMatchObject({ railMin: 300, railW: 300 })
    setRailTuning('railW', 200)
    expect(railGeometry()).toMatchObject({ railMin: 200, railW: 200 })
    setRailTuning('centerMin', 10)
    expect(railGeometry().centerMin).toBe(480)
    resetRailTuning()
    expect(railGeometry()).toEqual(RAIL_GEOMETRY)
  })
})
