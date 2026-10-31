import { describe, expect, it } from 'vitest'
import { slotOf, stackable, turn } from './ImageStack'

describe('ImageStack(多图叠成一摞)', () => {
  it('超过 3 张才叠', () => {
    expect([0, 1, 2, 3].map(stackable)).toEqual([false, false, false, false])
    expect([4, 5, 12].map(stackable)).toEqual([true, true, true])
  })
  it('槽位:最上面 0,右边没看的、左边看过的各露两层,再往后的藏在 ±3', () => {
    expect([0, 1, 2, 3, 4].map((i) => slotOf(i, 0))).toEqual([0, 1, 2, 3, 3])
    expect([0, 1, 2, 3, 4].map((i) => slotOf(i, 2))).toEqual([-2, -1, 0, 1, 2])
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => slotOf(i, 6))).toEqual([-3, -3, -3, -3, -2, -1, 0])
  })
  it('翻页两头不循环', () => {
    expect(turn(0, 1, 5)).toBe(1)
    expect(turn(4, 1, 5)).toBe(4)
    expect(turn(0, -1, 5)).toBe(0)
    expect(turn(3, -1, 5)).toBe(2)
  })
})
