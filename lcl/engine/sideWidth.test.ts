import { describe, it, expect } from 'vitest'
import { computeSideWidth, computeTransientSideWidth } from './sideWidth'

const W = 1600 // 容器宽:1600×0.191 = 305.6 → 钳到 left 的 max=280

describe('computeSideWidth', () => {
  it('非 free 侧 = 黄金分割钳制', () => {
    expect(computeSideWidth(W, 'left', { free: false, saved: null })).toBe(280) // 钳 max
    expect(computeSideWidth(900, 'left', { free: false, saved: null })).toBe(220) // 900×0.191=172 → 钳 min
    expect(computeSideWidth(1200, 'left', { free: false, saved: null })).toBe(229) // 未触钳
  })

  it('⚠️回归:free 侧无记忆、无系数 → 与非 free 同宽(曾因硬编码 ×1.2 让 Amadeus 左栏宽 20%)', () => {
    const pinned = computeSideWidth(W, 'left', { free: false, saved: null })
    expect(computeSideWidth(W, 'left', { free: true, saved: null })).toBe(pinned)
    expect(computeSideWidth(W, 'left', { free: true, saved: null, scale: 1 })).toBe(pinned)
  })

  it('free 侧按 Space 系数放宽(Coding 对话栏 = golden×1.2)', () => {
    expect(computeSideWidth(W, 'left', { free: true, saved: null, scale: 1.2 })).toBe(336)
  })

  it('free 侧有记忆则记忆优先(拖宽持久,不被钉回黄金分割)', () => {
    expect(computeSideWidth(W, 'left', { free: true, saved: 420, scale: 1.2 })).toBe(420)
  })

  it('free 侧记忆仍受上下限钳制', () => {
    expect(computeSideWidth(W, 'left', { free: true, saved: 50 })).toBe(220) // < RESIZABLE_MIN
    expect(computeSideWidth(W, 'left', { free: true, saved: 5000 })).toBe(680) // hardMax = min(680, 1600×0.6=960)
    expect(computeSideWidth(800, 'left', { free: true, saved: 5000 })).toBe(480) // hardMax = 800×0.6
  })

  it('右侧的钳制档与左侧不同', () => {
    expect(computeSideWidth(W, 'right', { free: false, saved: null })).toBe(300) // max=300
    expect(computeSideWidth(900, 'right', { free: false, saved: null })).toBe(240) // min=240
  })

  it('临时二级 View 默认比普通侧栏宽 20%，窄屏不反向缩窄', () => {
    expect(computeTransientSideWidth(W, 300)).toBe(360)
    expect(computeTransientSideWidth(900, 240)).toBe(288)
    expect(computeTransientSideWidth(360, 240)).toBe(240)
  })
})
