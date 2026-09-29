import { describe, expect, it } from 'vitest'
import { formatRemaining, remainingPercent } from './accountQuota'

// 全端一个口径(个人中心盘点 C4):向下取整、夹到 0–100、有剩余但不足 1% 写 <1%、不限写 unlimited。
// 负对照:把 Math.floor 换成 Math.round → 0.6% 那条会写成 1%,红。
describe('formatRemaining', () => {
  it('floors, clamps and marks the last sliver', () => {
    expect(formatRemaining(remainingPercent(1000, 4, 99.6), '不限')).toBe('<1%') // 0.4% 剩余:原来网页 / 菜单写 0%
    expect(formatRemaining(remainingPercent(1000, 6, 99.4), '不限')).toBe('<1%')
    expect(formatRemaining(remainingPercent(1000, 0, 100), '不限')).toBe('0%')
    expect(formatRemaining(remainingPercent(1000, 725, 27.5), '不限')).toBe('72%')
    // remaining 缺失(null)→ 回退到已用百分比,不是当成剩 0;limit 缺失(null)与 undefined 同口径 = 不限
    expect(formatRemaining(remainingPercent(100, null, 20), '不限')).toBe('80%')
    expect(formatRemaining(remainingPercent(null, 5, 0), '不限')).toBe('不限')
    expect(formatRemaining(remainingPercent(1000, 2000, 0), '不限')).toBe('100%')
    expect(formatRemaining(remainingPercent(-1, 0, 0), '不限')).toBe('不限')
    expect(formatRemaining(remainingPercent(0, 0, 0), '不限')).toBe('0%') // 上限 0 = 没额度,不是不限
  })
})
