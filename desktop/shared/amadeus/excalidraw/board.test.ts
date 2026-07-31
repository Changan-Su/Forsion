import { describe, expect, it } from 'vitest'
import { blankDrawing, BLANK_SCENE_JSON, parseDrawing } from './format'
import {
  clampViewport,
  elementBounds,
  pageRange,
  pageRect,
  paperSize,
  reflowPoint,
  stripRect,
  writeBoard,
  readBoard,
  DEFAULT_BOARD,
  MARGIN,
  PAGE_GAP,
  type BoardSettings,
  type Viewport,
} from './board'

const src = blankDrawing(BLANK_SCENE_JSON)
const set = (p: Partial<BoardSettings>): BoardSettings => ({ ...DEFAULT_BOARD, ...p })

describe('board settings', () => {
  it('缺省 = 无限画布无网格,round-trip 稳定', () => {
    expect(readBoard(src)).toEqual(DEFAULT_BOARD)
    const s = set({ gridH: 24, gridV: 16, paper: 'A4', landscape: true })
    expect(readBoard(writeBoard(src, s))).toEqual(s)
  })

  it('写设置绝不动 Drawing 段(否则就是在 Obsidian 那边毁档)', () => {
    const out = writeBoard(src, set({ paper: 'B5', gridH: 20 }))
    expect(parseDrawing(out)?.sceneJson).toBe(BLANK_SCENE_JSON)
    expect(out).toContain('excalidraw-plugin: parsed')
    expect(out).toContain('tags: [excalidraw]')
  })

  it('改回缺省要把键删干净,不留 `: 0`', () => {
    const on = writeBoard(src, set({ gridH: 20, gridV: 20, paper: 'A5', landscape: true }))
    const off = writeBoard(on, DEFAULT_BOARD)
    expect(off).not.toMatch(/forsion-/)
    expect(off).toBe(src)
  })

  it('没有 frontmatter 的源原样返回,读则回缺省', () => {
    const naked = '## Drawing\n```json\n{}\n```\n'
    expect(writeBoard(naked, set({ paper: 'A4' }))).toBe(naked)
    expect(readBoard(naked)).toEqual(DEFAULT_BOARD)
  })

  it('手写的多行值被整块换掉,不留孤儿缩进行(留了 frontmatter 就废了)', () => {
    const multi = src.replace('tags: [excalidraw]', 'forsion-paper:\n  A4\nother: keep')
    const out = writeBoard(multi, set({ paper: 'B4' }))
    expect(out).not.toMatch(/^ {2}A4$/m)
    expect(out).toContain('forsion-paper: B4')
    expect(out).toContain('other: keep')
    // 删键同理:标题行连带续行一起走
    expect(writeBoard(multi, DEFAULT_BOARD)).not.toMatch(/forsion-paper|^ {2}A4$/m)
    expect(writeBoard(multi, DEFAULT_BOARD)).toContain('other: keep')
  })

  it('坏值不认:非法纸张名 / 过小间距 → 缺省', () => {
    const bad = writeBoard(src, DEFAULT_BOARD).replace(/^---\n/, '---\nforsion-paper: A3\nforsion-grid-h: 1\n')
    expect(readBoard(bad)).toEqual(DEFAULT_BOARD)
  })

  it('A4 = 794×1123 @96dpi,横向即交换', () => {
    expect(paperSize(set({ paper: 'A4' }))).toEqual({ w: 794, h: 1123 })
    expect(paperSize(set({ paper: 'A4', landscape: true }))).toEqual({ w: 1123, h: 794 })
    expect(paperSize(DEFAULT_BOARD)).toBeNull()
  })
})

describe('clampViewport(纸张硬边界)', () => {
  const a4 = set({ paper: 'A4' })
  const paper = paperSize(a4)!
  const view = (p: Partial<Viewport>): Viewport => ({ scrollX: 0, scrollY: 0, zoom: 1, width: 900, height: 700, ...p })

  it('无限画布永远不纠偏', () => {
    expect(clampViewport(DEFAULT_BOARD, view({ scrollX: -99999 }))).toBeNull()
  })

  it('已在范围内 → null(不返回等值对象,否则 updateScene 自激)', () => {
    const fit = clampViewport(a4, view({ zoom: 0.1 }))! // 先从缩太小的状态纠一次
    expect(clampViewport(a4, view(fit))).toBeNull()
  })

  it('钳住后视口不越出「纸张 + 余量」', () => {
    const mx = paper.w * MARGIN
    for (const v of [view({ scrollX: 5000, zoom: 2 }), view({ scrollX: -5000, zoom: 2 }), view({ scrollY: 9999, zoom: 2 })]) {
      const r = clampViewport(a4, v)!
      // 可视场景区间 [-scrollX, -scrollX + width/zoom] 必须落在 [-mx, paper.w + mx] 内
      expect(-r.scrollX).toBeGreaterThanOrEqual(-mx - 0.01)
      expect(-r.scrollX + v.width / r.zoom).toBeLessThanOrEqual(paper.w + mx + 0.01)
    }
  })

  it('缩放不钳:要能缩到一眼看完整篇(越界不可画靠遮罩,不靠缩放下限)', () => {
    expect(clampViewport(a4, view({ zoom: 0.05 }))?.zoom ?? 0.05).toBe(0.05)
  })

  it('视口比纸还宽的那一轴居中', () => {
    const r = clampViewport(set({ paper: 'A5' }), view({ width: 4000, height: 4000, zoom: 1, scrollX: 3000 }))!
    const a5 = paperSize(set({ paper: 'A5' }))!
    expect(r.scrollX).toBeCloseTo((4000 / r.zoom - a5.w) / 2, 6)
  })

  it('一次纠偏即到不动点(拿结果再算一次不再动)', () => {
    const once = clampViewport(a4, view({ scrollX: 8000, scrollY: -8000, zoom: 3 }))!
    expect(clampViewport(a4, view(once))).toBeNull()
  })

  it('边界覆盖的是整条页带,不是单页', () => {
    const far = { minX: 0, minY: 0, maxX: 100, maxY: paper.h * 3 } // 内容画到第 2 页
    const strip = stripRect(a4, far)!
    // 内容裹到第 2 页 → 页区间 [0, 2] 共 3 页
    expect(strip.h).toBeCloseTo(3 * paper.h + 2 * PAGE_GAP, 6)
    // 钳到页带底部还能继续往下,钳到页带外就不行了
    const bottom = clampViewport(a4, view({ scrollY: -99999, zoom: 1 }), far)!
    expect(-bottom.scrollY + 700).toBeLessThanOrEqual(strip.y + strip.h + paper.h * MARGIN + 0.01)
  })
})

describe('多页', () => {
  const a4 = set({ paper: 'A4' })
  const p = paperSize(a4)!

  it('空白板 = 就一页;页数由用户手动加', () => {
    expect(pageRange(a4, null)).toEqual({ min: 0, max: 0 })
    expect(pageRange(set({ paper: 'A4', pageFirst: -2, pageLast: 1 }), null)).toEqual({ min: -2, max: 1 })
  })

  it('内容永远兜底:页数调小也不会把已画的东西甩到页外', () => {
    const far = { minX: 0, minY: 10, maxX: 10, maxY: p.h * 2.5 } // 内容到第 2 页
    expect(pageRange(a4, far)).toEqual({ min: 0, max: 2 }) // 没手动加页,也得裹住内容
    expect(pageRange(set({ paper: 'A4', pageLast: 1 }), far)).toEqual({ min: 0, max: 2 }) // 手动只加到 1,内容仍兜住
    expect(pageRange(set({ paper: 'A4', pageLast: 5 }), far)).toEqual({ min: 0, max: 5 })
    // 往上画的内容同理
    expect(pageRange(a4, { minX: 0, minY: -p.h * 1.5, maxX: 10, maxY: 20 })).toEqual({ min: -2, max: 0 })
  })

  it('没有页数键的老白板 = 恰好裹住现有内容,不多不少', () => {
    const s = readBoard(src)
    expect(s.pageFirst).toBe(0)
    expect(s.pageLast).toBe(0)
    expect(pageRange({ ...s, paper: 'A4' }, null)).toEqual({ min: 0, max: 0 })
  })

  it('页数进 frontmatter 往返,且缺省不写键', () => {
    const out = writeBoard(src, set({ paper: 'A4', pageFirst: -2, pageLast: 3 }))
    expect(readBoard(out).pageFirst).toBe(-2)
    expect(readBoard(out).pageLast).toBe(3)
    expect(writeBoard(src, set({ paper: 'A4' }))).not.toMatch(/forsion-page-(first|last)/)
  })

  it('第 0 页锚在场景原点;竖向按高排、横向按宽排', () => {
    expect(pageRect(a4, 0)).toEqual({ x: 0, y: 0, w: p.w, h: p.h })
    expect(pageRect(a4, 1)).toEqual({ x: 0, y: p.h + PAGE_GAP, w: p.w, h: p.h })
    expect(pageRect(a4, -1)).toEqual({ x: 0, y: -(p.h + PAGE_GAP), w: p.w, h: p.h })
    expect(pageRect(set({ paper: 'A4', flow: 'h' }), 2)).toEqual({ x: 2 * (p.w + PAGE_GAP), y: 0, w: p.w, h: p.h })
  })

  it('换排布方向:页内偏移一点不动,只换页原点', () => {
    const h = set({ paper: 'A4', flow: 'h' })
    // 第 0 页上的点原地不动
    expect(reflowPoint(a4, 'v', 'h', 30, 40)).toEqual({ x: 30, y: 40 })
    // 第 2 页(竖排在下面)→ 横排搬到右边,页内 (30,40) 不变
    const src = { x: 30, y: 2 * (p.h + PAGE_GAP) + 40 }
    expect(reflowPoint(a4, 'v', 'h', src.x, src.y)).toEqual({ x: 2 * (p.w + PAGE_GAP) + 30, y: 40 })
    // 反着换回来要能还原
    const back = reflowPoint(h, 'h', 'v', 2 * (p.w + PAGE_GAP) + 30, 40)
    expect(back).toEqual(src)
  })

  it('负页也搬得对(往上画的那一页)', () => {
    const src = { x: 30, y: -(p.h + PAGE_GAP) + 40 }
    expect(reflowPoint(a4, 'v', 'h', src.x, src.y)).toEqual({ x: -(p.w + PAGE_GAP) + 30, y: 40 })
  })

  it('elementBounds:忽略已删元素,空集合回 null', () => {
    expect(elementBounds([])).toBeNull()
    expect(elementBounds([{ x: 0, y: 0, width: 10, height: 10, isDeleted: true }])).toBeNull()
    expect(elementBounds([{ x: 5, y: 6, width: 10, height: 20 }, { x: -3, y: 1, width: 2, height: 2 }]))
      .toEqual({ minX: -3, minY: 1, maxX: 15, maxY: 26 })
  })

  it('网格淡浓:往返、夹在 10–100、满值不写键', () => {
    expect(readBoard(writeBoard(src, set({ gridH: 20, gridOpacity: 25 }))).gridOpacity).toBe(25)
    expect(readBoard(writeBoard(src, set({ gridH: 20, gridOpacity: 3 }))).gridOpacity).toBe(10)
    expect(readBoard(writeBoard(src, set({ gridH: 20, gridOpacity: 999 }))).gridOpacity).toBe(100)
    expect(writeBoard(src, set({ gridH: 20, gridOpacity: 100 }))).not.toMatch(/forsion-grid-opacity/)
  })

  it('排布方向进 frontmatter,且无限画布下不写这个键', () => {
    const out = writeBoard(src, set({ paper: 'A5', flow: 'h' }))
    expect(readBoard(out).flow).toBe('h')
    expect(writeBoard(src, set({ flow: 'h' }))).not.toMatch(/forsion-paper-flow/)
  })
})
