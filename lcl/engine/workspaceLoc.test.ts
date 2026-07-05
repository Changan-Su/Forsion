import { describe, it, expect } from 'vitest'
import { locOf, splitDirection, halfRect, tabInsertion } from './dropModel'

// 受控拖放的判定核心(提示与提交共用)。这些纯函数决定「竖线/半屏高亮画在哪 = 松手落在哪」,故重点覆盖。

describe('locOf', () => {
  it('取组内首个 panel 的 __loc', () => {
    expect(locOf({ panels: [{ params: { __loc: 'left' } }] })).toBe('left')
    expect(locOf({ panels: [{ params: { __loc: 'right' } }] })).toBe('right')
  })
  it('缺省 = main(空组 / 无 __loc)', () => {
    expect(locOf({ panels: [] })).toBe('main')
    expect(locOf({ panels: [{ params: {} }] })).toBe('main')
  })
})

describe('splitDirection', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 }
  it('主区:对角线四分 → 四向', () => {
    expect(splitDirection(50, 10, rect, 'main')).toBe('top')
    expect(splitDirection(50, 90, rect, 'main')).toBe('bottom')
    expect(splitDirection(10, 50, rect, 'main')).toBe('left')
    expect(splitDirection(90, 50, rect, 'main')).toBe('right')
  })
  it('侧栏:仅上/下(左右半边也归并到最近的上/下,永不产出 left|right)', () => {
    for (const loc of ['left', 'right'] as const) {
      expect(splitDirection(10, 20, rect, loc)).toBe('top') // 左上 → 归上
      expect(splitDirection(90, 20, rect, loc)).toBe('top') // 右上 → 归上
      expect(splitDirection(10, 80, rect, loc)).toBe('bottom')
      expect(splitDirection(90, 80, rect, loc)).toBe('bottom')
    }
  })
})

describe('halfRect', () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 }
  it('四向半屏矩形', () => {
    expect(halfRect(rect, 'left')).toEqual({ left: 10, top: 20, width: 100, height: 100 })
    expect(halfRect(rect, 'right')).toEqual({ left: 110, top: 20, width: 100, height: 100 })
    expect(halfRect(rect, 'top')).toEqual({ left: 10, top: 20, width: 200, height: 50 })
    expect(halfRect(rect, 'bottom')).toEqual({ left: 10, top: 70, width: 200, height: 50 })
  })
})

describe('tabInsertion', () => {
  // 三个 100px 宽 tab:[0..100][100..200][200..300]
  const tabs = [{ left: 0, right: 100 }, { left: 100, right: 200 }, { left: 200, right: 300 }]
  it('落在某 tab 左半 → 插其前(index=该位),竖线在其左缘', () => {
    expect(tabInsertion(tabs, 20, 0)).toEqual({ index: 0, lineX: 0 })
    expect(tabInsertion(tabs, 120, 0)).toEqual({ index: 1, lineX: 100 })
  })
  it('落在某 tab 右半 → 插其后', () => {
    expect(tabInsertion(tabs, 80, 0)).toEqual({ index: 1, lineX: 100 }) // tab0 右半 → 插到 index1、竖线在 tab0 右缘
  })
  it('末尾(超出最后一个 tab)→ index=末位,竖线在最后 tab 右缘', () => {
    expect(tabInsertion(tabs, 999, 0)).toEqual({ index: 3, lineX: 300 })
  })
  it('空条 → index 0,竖线在 stripLeft', () => {
    expect(tabInsertion([], 50, 12)).toEqual({ index: 0, lineX: 12 })
  })
})
