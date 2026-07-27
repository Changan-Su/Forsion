import { describe, it, expect } from 'vitest'
import { subFlips } from './ModelPill'

// 视口宽 1000,子面板 200(未缩放局部 px),gap 6 / margin 8
describe('subFlips', () => {
  it('右边放得下 → 不翻', () => {
    expect(subFlips(700, 200, 1, 1000)).toBe(false)
  })
  it('右边放不下 → 翻到左侧', () => {
    expect(subFlips(820, 200, 1, 1000)).toBe(true)
  })
  it('⚠️ zoom≠1:同一个锚点,放大后就放不下了(subW 必须乘 zoom)', () => {
    // 700 + (6+200)*1 = 906 ≤ 992 放得下;×1.15 → 700+236.9=936.9 仍放得下,×1.6 → 1029.6 放不下
    expect(subFlips(700, 200, 1.15, 1000)).toBe(false)
    expect(subFlips(700, 200, 1.6, 1000)).toBe(true)
  })
})
