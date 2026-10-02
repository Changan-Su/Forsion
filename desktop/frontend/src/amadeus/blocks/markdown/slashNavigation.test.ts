import { describe, expect, it } from 'vitest'
import { moveSlash, slashRows } from './slashNavigation'

describe('AI slash capsule keyboard rows', () => {
  const items = [{ aiCapsule: true }, { aiCapsule: true }, { aiCapsule: true }, {}, {}]
  it('uses left and right within AI and wraps without changing the document', () => {
    expect(moveSlash(items, 0, 'ArrowLeft')).toBe(2)
    expect(moveSlash(items, 2, 'ArrowRight')).toBe(0)
    expect(moveSlash(items, 3, 'ArrowRight')).toBeNull()
  })
  it('uses up and down between visual rows', () => {
    expect(slashRows(items)).toEqual([[0, 1, 2], [3], [4]])
    expect(moveSlash(items, 1, 'ArrowDown')).toBe(3)
    expect(moveSlash(items, 3, 'ArrowUp')).toBe(0)
    expect(moveSlash(items, 4, 'ArrowDown')).toBe(4)
  })
  it('handles filtered results and missing active items', () => {
    expect(slashRows([{}, { aiCapsule: true }, {}, { aiCapsule: true }])).toEqual([[0], [1, 3], [2]])
    expect(moveSlash([], 0, 'ArrowDown')).toBeNull()
    expect(moveSlash([{ aiCapsule: true }], 0, 'ArrowLeft')).toBe(0)
  })
})
