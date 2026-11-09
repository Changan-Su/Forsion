// @vitest-environment happy-dom
// 从收纳把瓷砖拖进主页(11-08 方案 B)的判定:只按量下的格子矩形命中,满了就放不了(11-08 用户定,不做「放在卡上换下」)。
// 几何按 110% × 1512 宽窗口的真主页量的(方案页 instrument/recon.cjs):左栏浮层在中列左边、右栏在右边;数值是视口 px(已乘 110%)。
import { describe, expect, it } from 'vitest'
import { applyLibraryDrop, forgetLibraryDrop, hitLibraryDrop, recordLibraryDrop, spendLibraryUndo, undoLibraryDrop, type Box, type HomeGeometry } from './homeLibraryDrag'
import { DEFAULT_HOME_LAYOUT, STATUS_CARD, isOnHome, moveOnHome, readHomeLayout, saveHomeLayout, type HomeLayout } from './homeWidgets'

const Z = 1.1
const b = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h })
/** 栏:ids 是卡,不满 3 张时末尾补一个空位。 */
const rail = (x: number, ids: string[]): NonNullable<HomeGeometry['rails']['left']> => {
  const slots = ids.map((id, i) => ({ id, r: b(x, 60 + i * 180, 282, 170), empty: false }))
  if (ids.length < 3) slots.push({ id: '', r: b(x, 60 + ids.length * 180, 282, 106), empty: true })
  return { r: b(x, 60, 282, 540), slots }
}
const ROW = b(330, 470, 924, 152)
const GAP = 11
const cellW = (ROW.w - 3 * GAP) / 4
const row = (cells: { id: string; w: number }[]): NonNullable<HomeGeometry['row']> => {
  let at = 0
  const out = cells.map((c) => { const r = b(ROW.x + at * (cellW + GAP), ROW.y, c.w * cellW + (c.w - 1) * GAP, ROW.h); at += c.w; return { id: c.id, r, empty: false } })
  if (at < 4) out.push({ id: '', r: b(ROW.x + at * (cellW + GAP), ROW.y, (4 - at) * cellW + (3 - at) * GAP, ROW.h), empty: true })
  return { r: ROW, gap: GAP, cells: out }
}
const geo = (l: HomeLayout): HomeGeometry => ({
  rails: { left: rail(18, l.left), right: rail(1290, l.right) },
  row: row(l.row),
  stack: b(330, 120, 924, 700),
  parts: [
    { part: 'clock', r: b(330, 120, 924, 150) },
    { part: 'composer', r: b(330, 300, 924, 140) },
    { part: 'row', r: b(330, 470, 924, 152) },
    { part: 'dock', r: b(330, 650, 924, 170) },
  ],
  zoom: Z,
})
const W = (id: string) => ({ kind: 'widget' as const, id })
const NOTES = 'builtin:notes'

describe('hitLibraryDrop · 缺省摆放(右栏满、下排被近况卡占满)', () => {
  const l = DEFAULT_HOME_LAYOUT
  const g = geo(l)
  it('左栏空位 = 框住空位', () => {
    const h = hitLibraryDrop(g, l, W(NOTES), 150, 100)
    expect(h).toMatchObject({ type: 'rail', side: 'left', index: 0, mark: { shape: 'zone' } })
  })
  it('右栏满了:放不下,小签说右栏满了,不画落点', () => {
    const h = hitLibraryDrop(g, l, W(NOTES), 1400, 300)
    expect(h).toEqual({ type: 'no', key: 'no:full:right', note: 'home.drop.full.right' })
  })
  it('下排被近况卡占着:放不下,说的是近况卡', () => {
    expect(hitLibraryDrop(g, l, W(NOTES), 600, 540)).toMatchObject({ type: 'no', note: 'home.drop.rowStatus' })
  })
  it('时钟 / 输入框上方:只指路,不算放不下', () => {
    expect(hitLibraryDrop(g, l, W(NOTES), 700, 200)).toMatchObject({ type: 'hint', note: 'home.drop.hintSides' })
    expect(hitLibraryDrop(g, l, W(NOTES), 700, 360)).toMatchObject({ type: 'hint' })
  })
  it('哪儿都不是:null(松手 = 取消)', () => {
    expect(hitLibraryDrop(g, l, W(NOTES), 300, 900)).toBeNull()
  })
  it('左栏点完成后会收成图标条:悬停时就提前说', () => {
    const h = hitLibraryDrop(g, l, W(NOTES), 150, 100, { left: true, right: false })
    expect(h).toMatchObject({ type: 'rail', side: 'left', note: 'home.drop.folds.left' })
  })
  it('近况卡拖到栏:只能放下排', () => {
    expect(hitLibraryDrop(g, l, W(STATUS_CARD), 150, 100)).toMatchObject({ type: 'no', note: 'home.drop.statusRail' })
  })
})

describe('hitLibraryDrop · 留了空位', () => {
  const l: HomeLayout = { ...DEFAULT_HOME_LAYOUT, right: ['builtin:inbox', 'builtin:sessions'], row: [{ id: 'builtin:muse', w: 2 }] }
  const g = geo(l)
  it('栏里卡之间 = 缝正中一条横线,插在第二张前面', () => {
    const y = 60 + 180 + 20 // 第二张卡的上半
    const h = hitLibraryDrop(g, l, W(NOTES), 1400, y)
    expect(h).toMatchObject({ type: 'rail', side: 'right', index: 1, mark: { shape: 'line', axis: 'h' } })
    const ly = (h as { mark: { r: Box } }).mark.r.y + 1.5 * Z
    expect(ly).toBeCloseTo((60 + 170 + 60 + 180) / 2, 5) // 第一张底边与第二张顶边的正中
  })
  it('下排空格 = 框住新卡要占的 2 格(同「点一下」)', () => {
    const h = hitLibraryDrop(g, l, W(NOTES), 1100, 540)
    expect(h).toMatchObject({ type: 'row', index: 1, w: 2, mark: { shape: 'zone' } })
    const r = (h as { mark: { r: Box } }).mark.r
    expect(r.w).toBeCloseTo(2 * cellW + GAP, 5)
  })
  it('下排卡的左半 = 竖线插在它前面', () => {
    expect(hitLibraryDrop(g, l, W(NOTES), 360, 540)).toMatchObject({ type: 'row', index: 0, w: 2, mark: { shape: 'line', axis: 'v' } })
  })
  it('近况卡拖到有卡的下排:要先拿掉下排的卡', () => {
    expect(hitLibraryDrop(g, l, W(STATUS_CARD), 1100, 540)).toMatchObject({ type: 'no', note: 'home.drop.statusBusy' })
  })
  it('只剩 1 格:新卡占 1 格', () => {
    const l3: HomeLayout = { ...l, row: [{ id: 'builtin:muse', w: 2 }, { id: 'builtin:inbox', w: 1 }] }
    expect(hitLibraryDrop(geo(l3), l3, W(NOTES), 1200, 540)).toMatchObject({ type: 'row', w: 1 })
  })
  it('下排 4 格满(没有近况卡):说下排满了', () => {
    const l4: HomeLayout = { ...l, row: [{ id: 'builtin:muse', w: 2 }, { id: 'builtin:inbox', w: 2 }] }
    expect(hitLibraryDrop(geo(l4), l4, W(NOTES), 600, 540)).toMatchObject({ type: 'no', note: 'home.drop.rowFull' })
  })
})

describe('hitLibraryDrop · 主页组件(时钟 / Space 坞)', () => {
  const l: HomeLayout = { ...DEFAULT_HOME_LAYOUT, center: ['composer', 'row', 'dock'] }
  const g: HomeGeometry = { ...geo(l), parts: geo(l).parts.filter((p) => p.part !== 'clock') }
  const clock = { kind: 'part' as const, part: 'clock' as const, name: 'Clock' }
  it('中列最上面:横线在输入框上方,放在它前面', () => {
    expect(hitLibraryDrop(g, l, clock, 700, 310)).toMatchObject({ type: 'part', before: 'composer', mark: { shape: 'line' } })
  })
  it('中列最下面:放在最后', () => {
    expect(hitLibraryDrop(g, l, clock, 700, 800)).toMatchObject({ type: 'part', before: null })
  })
  it('拖到两栏:只放中间这一列', () => {
    expect(hitLibraryDrop(g, l, clock, 150, 100)).toMatchObject({ type: 'no', note: 'home.drop.partCenter' })
  })
})

describe('applyLibraryDrop', () => {
  it('放进左栏空位', () => {
    const l = DEFAULT_HOME_LAYOUT
    const h = hitLibraryDrop(geo(l), l, W(NOTES), 150, 100)!
    expect(applyLibraryDrop(l, W(NOTES), h)?.left).toEqual([NOTES])
  })
  it('放进下排:按判定给的宽度', () => {
    const l: HomeLayout = { ...DEFAULT_HOME_LAYOUT, row: [{ id: 'builtin:muse', w: 2 }] }
    const h = hitLibraryDrop(geo(l), l, W(NOTES), 1100, 540)!
    expect(applyLibraryDrop(l, W(NOTES), h)?.row).toEqual([{ id: 'builtin:muse', w: 2 }, { id: NOTES, w: 2 }])
  })
  it('放不下 / 指路 / 已经在主页上的:不改', () => {
    const l = DEFAULT_HOME_LAYOUT
    expect(applyLibraryDrop(l, W(NOTES), { type: 'no', key: 'x', note: 'home.drop.full.right' })).toBeNull()
    expect(applyLibraryDrop(l, W(NOTES), { type: 'hint', key: 'x', note: 'home.drop.hintSides' })).toBeNull()
    expect(applyLibraryDrop(l, W('builtin:muse'), { type: 'rail', side: 'left', index: 0, key: 'left:0', mark: { shape: 'zone', r: b(0, 0, 1, 1) } })).toBeNull()
  })
  it('时钟放回中列指定位置', () => {
    const l: HomeLayout = { ...DEFAULT_HOME_LAYOUT, center: ['composer', 'row', 'dock'] }
    const next = applyLibraryDrop(l, { kind: 'part', part: 'clock', name: 'Clock' }, { type: 'part', before: 'dock', key: 'part:dock', mark: { shape: 'line', axis: 'h', r: b(0, 0, 1, 0) } })
    expect(next?.center).toEqual(['composer', 'row', 'clock', 'dock'])
  })
})

describe('moveOnHome 的新卡宽度', () => {
  it('新进下排的卡按给的宽度;已在下排的保留原宽;近况卡恒 4 格', () => {
    const l: HomeLayout = { ...DEFAULT_HOME_LAYOUT, row: [{ id: 'builtin:muse', w: 1 }] }
    expect(moveOnHome(l, NOTES, { area: 'row', index: 1 }, 2)?.row[1]).toEqual({ id: NOTES, w: 2 })
    expect(moveOnHome(l, NOTES, { area: 'row', index: 1 })?.row[1]).toEqual({ id: NOTES, w: 1 })
    expect(moveOnHome(l, 'builtin:muse', { area: 'row', index: 0 }, 2)?.row[0]).toEqual({ id: 'builtin:muse', w: 1 })
  })
})

describe('撤销凭证(右上角「撤销」与 ⌘Z 共用一次)', () => {
  const put = (l: HomeLayout): void => saveHomeLayout(l)
  const withNotes = (): HomeLayout => ({ ...DEFAULT_HOME_LAYOUT, left: [NOTES] })
  it('⌘Z 用掉之后,旧通知的「撤销」不再删重新放进来的那张', () => {
    put(withNotes())
    const u = recordLibraryDrop(W(NOTES))
    expect(undoLibraryDrop()).toBe(true)
    expect(readHomeLayout().left).toEqual([])
    put(withNotes()) // 用户又点瓷砖放了回来
    expect(spendLibraryUndo(u)).toBe(false)
    expect(readHomeLayout().left).toEqual([NOTES])
  })
  it('那张被「−」拿掉过再放回来:旧凭证作废', () => {
    put(withNotes())
    const u = recordLibraryDrop(W(NOTES))
    put(DEFAULT_HOME_LAYOUT)
    put(withNotes())
    expect(spendLibraryUndo(u)).toBe(false)
    expect(undoLibraryDrop()).toBe(false)
    expect(readHomeLayout().left).toEqual([NOTES])
  })
  it('之后又挪了位置照样能撤;撤一次就用完', () => {
    put(withNotes())
    const u = recordLibraryDrop(W(NOTES))
    put({ ...DEFAULT_HOME_LAYOUT, right: ['builtin:inbox', NOTES] })
    expect(spendLibraryUndo(u)).toBe(true)
    expect(isOnHome(readHomeLayout(), NOTES)).toBe(false)
    expect(spendLibraryUndo(u)).toBe(false)
  })
  it('退出编辑态:⌘Z 不再撤,通知里的凭证照旧能用', () => {
    put(withNotes())
    const u = recordLibraryDrop(W(NOTES))
    forgetLibraryDrop()
    expect(undoLibraryDrop()).toBe(false)
    expect(spendLibraryUndo(u)).toBe(true)
  })
})
