import { describe, expect, it } from 'vitest'
import { cellDraftValue, nextGridCellIndex } from './cellInteraction'

describe('database keyboard navigation', () => {
  it('keeps arrow navigation on its row and wraps Tab in both directions', () => {
    expect(nextGridCellIndex(2, 9, 3, 'right')).toBe(2)
    expect(nextGridCellIndex(3, 9, 3, 'left')).toBe(3)
    expect(nextGridCellIndex(2, 9, 3, 'next')).toBe(3)
    expect(nextGridCellIndex(3, 9, 3, 'previous')).toBe(2)
  })
  it('moves vertically in the visible column and retains selection at boundaries', () => {
    expect(nextGridCellIndex(1, 9, 3, 'down')).toBe(4)
    expect(nextGridCellIndex(4, 9, 3, 'up')).toBe(1)
    expect(nextGridCellIndex(0, 9, 3, 'up')).toBe(0)
    expect(nextGridCellIndex(8, 9, 3, 'next')).toBe(8)
    expect(nextGridCellIndex(-1, 9, 3, 'next')).toBe(-1)
  })
})
describe('cell draft commit', () => {
  it('accepts completed decimals and clears intentional empty numbers, retaining invalid drafts', () => {
    expect(cellDraftValue('number', '-12.50', 3)).toBe(-12.5)
    expect(cellDraftValue('number', '', 3)).toBeUndefined()
    expect(cellDraftValue('number', '-', 3)).toBe(3)
    expect(cellDraftValue('number', 'Infinity', 3)).toBe(3)
    expect(cellDraftValue('number', '1e', 3)).toBe(3)
  })
  it('normalizes typed links without altering ordinary text or clearing blank note names', () => {
    expect(cellDraftValue('text', '看【【笔记】】', '')).toBe('看[[笔记]]')
    expect(cellDraftValue('text', '  hello  ', '')).toBe('  hello  ')
    expect(cellDraftValue('url', 'example.com/path', '')).toBe('https://example.com/path')
    expect(cellDraftValue('page', '  ', 'Existing')).toBe('Existing')
  })
})
