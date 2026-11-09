import { describe, expect, it } from 'vitest'
import { allocate, minimum, solveLayout, type LayoutNode } from './layoutGeometry'
import { bezier, layoutHints } from './layoutCoordinator'
const leaf = (id: string, loc = 'main', minWidth = 320): LayoutNode => ({ id, loc, visible: true, min: { width: minWidth, height: 180 }, size: { width: 500, height: 700 } })
const branch = (axis: 'width' | 'height', key: string, children: LayoutNode[]): LayoutNode => ({ axis, key, children, size: { width: 1500, height: 900 } })
describe('workspace allocation', () => {
  it('redistributes a clamped share without overwriting the requested ratio', () => {
    expect(allocate(1000, [1, 3], [320, 320])).toEqual([320, 680])
    expect(allocate(1600, [1, 3], [320, 320])).toEqual([400, 1200])
  })
  it('preserves nested horizontal/vertical partitions and keeps every box inside the canvas', () => {
    const tree = branch('width', 'root', [leaf('l','left',220), branch('height','column',[branch('width','documents',[leaf('a'),branch('height','stack',[leaf('b'),leaf('c')])]),leaf('bottom','bottom')]),leaf('r','right',240)])
    const ratios = { documents: [1, 2], stack: [2, 1] }, before = JSON.stringify(ratios)
    for (const width of [600, 900, 1600, 2400]) for (const height of [400, 900]) {
      const {size,boxes} = solveLayout(tree,{width,height},ratios,{left:260,right:280,bottom:200})
      for (const r of boxes.values()) { expect(r.x+r.width).toBeLessThanOrEqual(size.width+0.01); expect(r.y+r.height).toBeLessThanOrEqual(size.height+0.01); expect(r.width).toBeGreaterThanOrEqual(220); expect(r.height).toBeGreaterThanOrEqual(180) }
      expect(boxes.get('a')!.x+boxes.get('a')!.width).toBeCloseTo(boxes.get('b')!.x)
      expect(boxes.get('b')!.y+boxes.get('b')!.height).toBeCloseTo(boxes.get('c')!.y)
      expect(JSON.stringify(ratios)).toBe(before)
    }
  })
  it('hides a region without a leftover allocation and validates untrusted plugin hints', () => {
    const closed = { ...leaf('l','left'), visible:false } as LayoutNode
    const tree = branch('width','root',[closed,leaf('a')])
    expect(minimum(tree)).toEqual({width:320,height:180})
    expect(solveLayout(tree,{width:800,height:600},{},{left:300}).boxes.get('l')!.width).toBe(0)
    expect(layoutHints({minWidth:NaN,minHeight:-1})).toMatchObject({minWidth:320,minHeight:180})
  })
  it('uses the drawer curve monotonically without overshoot', () => {
    const ease=bezier([0.32,0.72,0,1]);let previous=0
    for(let i=0;i<=100;i++){const value=ease(i/100);expect(value).toBeGreaterThanOrEqual(previous);expect(value).toBeLessThanOrEqual(1);previous=value}
  })
})
