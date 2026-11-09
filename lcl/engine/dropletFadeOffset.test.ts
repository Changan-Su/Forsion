import { describe, expect, it } from 'vitest'
import { fadePanelContentOut } from './droplet'

// 真浏览器里 animate() 遇到 offset 不在 [0,1](含 NaN)直接抛错;这里只抓传进去的关键帧
const fakeChild = () => {
  const calls: Keyframe[][] = []
  const el = { animate: (k: Keyframe[]) => { calls.push(k); return {} as Animation } } as unknown as HTMLElement
  return { el, calls }
}
const mid = (time: number, duration: number): unknown => {
  const c = fakeChild()
  fadePanelContentOut([c.el], [1], time, duration)
  return c.calls[0][1].offset
}

describe('fadePanelContentOut 的关键帧 offset', () => {
  it('正常进度按 0.65 比例', () => expect(mid(200, 400)).toBeCloseTo(0.325))
  it('刚开就收,进度为负 → 0', () => expect(mid(-16, 420)).toBe(0))
  it('时长为 0 / 进度非数 → 0,不出 NaN', () => {
    expect(mid(0, 0)).toBe(0)
    expect(mid(Number.NaN, 420)).toBe(0)
  })
  it('超过时长 → 不超过 1', () => expect(mid(5000, 420)).toBeLessThanOrEqual(1))
})
