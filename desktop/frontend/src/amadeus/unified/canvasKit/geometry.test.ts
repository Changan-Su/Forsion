/**
 * 画布几何内核的契约(canvasStage 与 DashboardCanvasView 共用这一份实现,所以这里红了两边都坏)。
 * 纯函数层;真 DOM 那一层由 check:canvas / check:dashboard 各自钉。
 */
import { describe, expect, it } from 'vitest'
import { GRID_STEP, boxFromPoints, boxOverlaps, marqueeHit, resizeBox, snapGrid, snapMoveToNeighbors, snapResizeToNeighbors, unionBox } from './geometry'

const B = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

describe('snapGrid', () => {
  it('就近吸到点阵', () => {
    expect(snapGrid(0)).toBe(0)
    expect(snapGrid(11)).toBe(0)
    expect(snapGrid(13)).toBe(GRID_STEP)
    expect(snapGrid(-13)).toBe(-GRID_STEP)
  })
})

describe('resizeBox', () => {
  it('拉右下:对边不动,宽高跟着走', () => {
    expect(resizeBox(B(10, 20, 100, 50), 'se', 30, 40, false, 80, 60)).toEqual(B(10, 20, 130, 90))
  })
  it('拉左上:右下两边钉住不动', () => {
    const r = resizeBox(B(100, 100, 200, 200), 'nw', 40, 60, false, 80, 60)
    expect(r).toEqual(B(140, 160, 160, 140))
    expect(r.x + r.w).toBe(300) // 右边一动没动
    expect(r.y + r.h).toBe(300)
  })
  it('单轴的边只动一个方向', () => {
    expect(resizeBox(B(0, 0, 200, 200), 'n', 999, -40, false, 80, 60)).toEqual(B(0, -40, 200, 240))
    expect(resizeBox(B(0, 0, 200, 200), 'e', 40, 999, false, 80, 60)).toEqual(B(0, 0, 240, 200))
  })
  it('开吸附:只量化正在动的那条边(固定边一定不许被吸走)', () => {
    const r = resizeBox(B(7, 9, 100, 100), 'se', 3, 3, true, 80, 60)
    expect(r.x).toBe(7) // 左边原样
    expect(r.y).toBe(9)
    expect(r.x + r.w).toBe(snapGrid(7 + 100 + 3)) // 量化的是**位移之后**那条边
    expect(r.y + r.h).toBe(snapGrid(9 + 100 + 3))
  })
  it('下限:从西边挤过头时改钉住东边,不许翻成负宽', () => {
    const r = resizeBox(B(0, 0, 100, 100), 'w', 999, 0, false, 80, 60)
    expect(r.w).toBe(80)
    expect(r.x + r.w).toBe(100)
    const r2 = resizeBox(B(0, 0, 100, 100), 'n', 0, 999, false, 80, 60)
    expect(r2.h).toBe(60)
    expect(r2.y + r2.h).toBe(100)
  })
})

describe('框选', () => {
  it('反向拖也得到正的 w/h', () => {
    expect(boxFromPoints(100, 100, 40, 30)).toEqual(B(40, 30, 60, 70))
  })
  it('相交即中(不要求整个包住);边贴边不算', () => {
    expect(boxOverlaps(B(0, 0, 10, 10), B(10, 0, 10, 10))).toBe(false)
    expect(boxOverlaps(B(0, 0, 10, 10), B(9, 9, 10, 10))).toBe(true)
    const hit = marqueeHit(B(0, 0, 50, 50), [['a', B(40, 40, 100, 100)], ['b', B(200, 200, 10, 10)]])
    expect(hit).toEqual(['a'])
  })
})

describe('unionBox', () => {
  it('空集给 null;多个盒子取外接', () => {
    expect(unionBox([])).toBeNull()
    expect(unionBox([B(10, 10, 10, 10), B(50, 0, 20, 100)])).toEqual(B(10, 0, 60, 100))
  })
})

describe('贴邻居边缘吸附', () => {
  const others = [B(0, 0, 300, 180), B(400, 0, 200, 100)]
  it('够得着邻居的边就吸上去(差 5px,容差 7)', () => {
    const r = snapMoveToNeighbors(B(0, 185, 300, 180), others, 7)
    expect(r.dy).toBe(-5) // 185 → 180 = 邻居的下边缘
    expect(r.guides.h).toEqual([180])
  })
  it('够不着就一动不动(差 12px)', () => {
    // x 也得挪开:摆在 x=0 会与邻居的左边缘天然对齐(delta 0 也是「吸中了」),测不出「够不着」。
    const r = snapMoveToNeighbors(B(1000, 192, 300, 180), others, 7)
    expect(r).toEqual({ dx: 0, dy: 0, guides: { v: [], h: [] } })
  })
  it('中线也算对齐位(不只是边)', () => {
    const r = snapMoveToNeighbors(B(1000, 87, 40, 4), others, 7) // 自身中线 89 ↔ 邻居中线 90
    expect(r.dy).toBe(1)
    expect(r.guides.h).toEqual([90])
  })
  it('调整尺寸只吸**动着的边**,固定的对边一步不许挪', () => {
    const r = snapResizeToNeighbors(B(100, 174, 200, 100), 'n', others, 7, 80, 60)
    expect(r.box.y).toBe(180) // 上边吸到邻居底边
    expect(r.box.y + r.box.h).toBe(274) // 下边原地不动
    expect(r.guides.h).toEqual([180])
  })
  it('吸附不许把盒子压到下限以下', () => {
    const r = snapResizeToNeighbors(B(0, 178, 300, 62), 's', [B(0, 0, 300, 180)], 7, 80, 60)
    expect(r.box.h).toBe(62) // 吸到 180 会剩 2px 高 → 拒绝
    expect(r.guides.h).toEqual([])
  })
})
