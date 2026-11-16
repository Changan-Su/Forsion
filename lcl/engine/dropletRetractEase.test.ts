import { describe, expect, it } from 'vitest'
import { bezierProgress, remapPlayhead } from './droplet'

const SURFACE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const BACK = 'cubic-bezier(0.65, 0, 0.35, 1)'
const D = 420
const shape = (css: string, t: number): number => bezierProgress(css)!(Math.min(1, Math.max(0, (t / D - 0.05) / 0.95)))

describe('液滴收起换曲线(11-16 Chat Box 水滴方案)', () => {
  it('认得 cubic-bezier,认不出的返回 null', () => {
    expect(bezierProgress(BACK)!(0.5)).toBeCloseTo(0.5, 3)
    expect(bezierProgress('ease')).toBeNull()
    expect(bezierProgress('linear(0, 1)')).toBeNull()
  })
  it('换曲线那一刻形状不变(开到一半就收 / 倒放途中掉头)', () => {
    for (const t of [40, 120, 200, 300, 400]) {
      const t2 = remapPlayhead(t, D, SURFACE, BACK)
      expect(shape(BACK, t2)).toBeCloseTo(shape(SURFACE, t), 3)
      const back = remapPlayhead(t2, D, BACK, SURFACE)
      expect(back).toBeCloseTo(t, 0)
    }
  })
  it('开满、停在一滴那段、认不出的曲线原样', () => {
    expect(remapPlayhead(D, D, SURFACE, BACK)).toBe(D)
    expect(remapPlayhead(10, D, SURFACE, BACK)).toBe(10)
    expect(remapPlayhead(200, D, 'ease', BACK)).toBe(200)
  })
  it('收起前一半时间收掉约一半(展开曲线直接倒放只收掉一成不到)', () => {
    // 倒放:播放头从 D 走到 0;时间过半 = 播放头在 D/2
    const reversedSurface = 1 - shape(SURFACE, D / 2)
    const reversedBack = 1 - shape(BACK, D / 2)
    expect(reversedSurface).toBeLessThan(0.1)
    expect(reversedBack).toBeGreaterThan(0.4)
  })
})
