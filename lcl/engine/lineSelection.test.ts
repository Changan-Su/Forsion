import { describe, it, expect } from 'vitest'
import { selectionLineRects, type SelectionFragment } from './lineSelection'

const clip = { left: 0, top: 0, right: 1000, bottom: 1000 }
const f = (left: number, top: number, right: number, bottom: number, extra: Partial<SelectionFragment> = {}): SelectionFragment => ({ left, top, right, bottom, group: 'paragraph', lineHeight: 30, clip, ...extra })
describe('continuous selection line geometry', () => {
  it('fractions and superscripts join the text baseline, with one height and no internal holes', () => {
    const rows = selectionLineRects([f(10, 10, 40, 30), f(40, 5, 80, 33, { atomic: true }), f(80, 10, 120, 30), f(10, 40, 70, 60)])
    expect(rows).toEqual([{ left: 10, top: 5.5, right: 120, bottom: 34.5 }, { left: 10, top: 35.5, right: 70, bottom: 64.5 }])
  })
  it('does not join table cells, columns or disjoint visual bidi runs', () => {
    const rows = selectionLineRects([f(10, 10, 30, 30), f(100, 10, 120, 30), f(31, 10, 50, 30, { group: 'next-cell' })])
    expect(rows.map(r => [r.left, r.right])).toEqual([[10, 30], [100, 120], [31, 50]])
  })
  it('clips the entire band at scroll edges and removes invisible/invalid fragments', () => {
    expect(selectionLineRects([f(-10, 10, 40, 30, { clip: { left: 5, top: 15, right: 25, bottom: 25 } })])).toEqual([{ left: 5, top: 15, right: 25, bottom: 25 }])
    expect(selectionLineRects([f(10, 10, 40, 30, { clip: { left: 60, top: 0, right: 90, bottom: 90 } })])).toEqual([])
  })
  it('independent multi-line display math is one full-height unit', () => {
    expect(selectionLineRects([f(20, 10, 400, 100, { atomic: true, display: true })])).toEqual([{ left: 20, top: 9.5, right: 400, bottom: 100.5 }])
  })
})
