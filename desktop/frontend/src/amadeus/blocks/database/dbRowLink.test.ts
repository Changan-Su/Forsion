// @vitest-environment happy-dom
/** 关联表多值 + 反向引用 + 建行盖章:真挂 DatabaseEmbed(dbStore 直接喂数据,不过 IPC)。
 *  钉住的都是「静默」那类坏法:数组值被显示成「空」/ 反向 rollup 因目标库没进 refPaths 恒空 /
 *  新行没盖章 / 按 id 串而非标题排序 / 关联列筛选值控件是空下拉。
 *  ponytail: 用 createElement 而非 JSX,免为一个用例把 vitest include 扩到 .tsx。 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { setLocaleGlobal } from '../../../i18n'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DbFile, DbView } from '@amadeus-shared/db/schema'

vi.mock('../../api', () => ({ amadeus: {} }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const ORDERS = '订单.db'
const PARTS = '配件.db'

const partsDb = (): DbFile => ({
  version: 1, name: '配件',
  columns: [
    { id: 'n', name: '名称', type: 'text' },
    { id: 'p', name: '单价', type: 'number' },
    { id: 'ord', name: '订单', type: 'rowlink', refDb: ORDERS },
  ],
  rows: [
    { id: 'p1', cells: { n: 'CPU', p: 100, ord: 'o1' } },
    { id: 'p2', cells: { n: '显卡', p: 300, ord: ['o1', 'o2'] } },
    { id: 'p3', cells: { n: '内存', p: 50 } },
  ],
})
const ordersDb = (views?: DbView[]): DbFile => ({
  version: 1, name: '订单',
  columns: [
    { id: 't', name: '标题', type: 'text' },
    { id: 'rel', name: '配件', type: 'rowlink', refDb: PARTS, multiple: true },
    { id: 'sum', name: '合计', type: 'lookup', lookupRel: 'rel', lookupCol: 'p', lookupAgg: 'sum' },
    { id: 'back', name: '出库行', type: 'lookup', refDb: PARTS, lookupBackCol: 'ord', lookupCol: 'n', lookupAgg: 'join' },
    { id: 'no', name: '编号', type: 'autonumber', prefix: 'ORD-' },
    { id: 'at', name: '创建时间', type: 'created' },
  ],
  rows: [
    { id: 'o1', cells: { t: '甲', rel: ['p1', 'p3'], no: 1, at: '2026-09-01T09:00' } },
    { id: 'o2', cells: { t: '乙', rel: 'p2', no: 5 } },
    { id: 'o3', cells: { t: '丙' } },
  ],
  ...(views ? { views } : {}),
})

let root: Root | null = null
const host = (): HTMLElement => document.getElementById('host')!

async function mount(db: DbFile = ordersDb(), parts: DbFile = partsDb(), files: string[] = [ORDERS, PARTS]): Promise<void> {
  const { DatabaseEmbed } = await import('./DatabaseEmbed')
  const { useDbStore } = await import('../../store/dbStore')
  const { usePageStore } = await import('../../store/pageStore')
  useDbStore.setState({ entries: {
    [ORDERS]: { status: 'ok', path: ORDERS, data: db },
    [PARTS]: { status: 'ok', path: PARTS, data: parts },
  } })
  usePageStore.setState({ pages: [], files })
  document.body.innerHTML = '<div id="host"></div>'
  root = createRoot(host())
  await act(async () => { root!.render(createElement(DatabaseEmbed, { target: ORDERS, pagePath: 'n.md' })) })
}
afterEach(async () => { if (root) await act(async () => { root!.unmount() }); root = null })

/** 第 i 行(0 起)某列的单元格元素;列按表头名找。 */
const cellOf = (rowIdx: number, colName: string): HTMLElement => {
  const heads = [...host().querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent)
  const ci = heads.indexOf(colName)
  return dataRows()[rowIdx].querySelectorAll<HTMLElement>('.amx-db-cell')[ci]
}
const dataRows = (): HTMLElement[] => [...host().querySelectorAll<HTMLElement>('.amx-db-row:not(.amx-db-hrow):not(.amx-db-statsrow)')]
/** 首列(text)渲染的是 <input>,标题得读 value。 */
const firstCol = (): string[] => dataRows().map((r) => r.querySelector<HTMLInputElement>('.amx-db-cell input')?.value ?? '')
const dbNow = async (): Promise<DbFile> => (await import('../../store/dbStore')).useDbStore.getState().entries[ORDERS].data as DbFile

describe('关联表多值 / 反向引用 / 盖章', () => {
  it('多选 cell(string[])渲染多枚 chip,单值仍一枚;缺失 id 标「已失联」而不是把整格当空', async () => {
    await mount()
    const chips = (i: number): string[] => [...cellOf(i, '配件').querySelectorAll('.amx-db-chip')].map((e) => e.textContent ?? '')
    expect(chips(0)).toEqual(['CPU', '内存'])
    expect(chips(1)).toEqual(['显卡'])
    expect(cellOf(2, '配件').textContent).toContain('空')
  })

  it('正向多值 lookup 逐目标行聚合;反向 lookup 扫目标表(目标库经 refPaths 加载/订阅)', async () => {
    await mount()
    expect(cellOf(0, '合计').textContent).toBe('150') // 100 + 50
    expect(cellOf(0, '出库行').textContent).toBe('CPU、显卡') // p1.ord='o1', p2.ord 含 'o1'
    expect(cellOf(1, '出库行').textContent).toBe('显卡')
    expect(cellOf(2, '出库行').textContent).toBe('–') // 没人指回 o3
  })

  it('目标库**只**被反向 lookup 引用(本表没有指向它的 rowlink)时也会被加载/订阅 —— 否则 rollup 恒空', async () => {
    // 夹具:把 rel 关联到另一张不存在的表,PARTS 只剩 back 列在引用它
    const db = ordersDb()
    db.columns = db.columns.map((c) => (c.id === 'rel' ? { ...c, refDb: '别的.db' } : c))
    await mount(db)
    expect(cellOf(0, '出库行').textContent).toBe('CPU、显卡')
  })

  it('目标表改了 → 反向 rollup 跟着刷新(窄订阅真的订到了反向列的目标库)', async () => {
    await mount()
    const { useDbStore } = await import('../../store/dbStore')
    await act(async () => {
      const parts = partsDb()
      parts.rows[2].cells.ord = 'o3'
      useDbStore.setState((s) => ({ entries: { ...s.entries, [PARTS]: { status: 'ok', path: PARTS, data: parts } } }))
    })
    expect(cellOf(2, '出库行').textContent).toBe('内存')
  })

  it('点「＋ 新行」→ 自动编号 = max+1(不是行数+1)、创建时间已盖章;编号列显示前缀', async () => {
    await mount()
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-addrow')!.click() })
    const db = await dbNow()
    expect(db.rows).toHaveLength(4)
    const nr = db.rows[3]
    expect(nr.cells.no).toBe(6) // max(1,5)+1,不是 rows.length+1 = 4
    expect(nr.cells.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(cellOf(3, '编号').textContent).toBe('ORD-6')
    expect(cellOf(0, '编号').textContent).toBe('ORD-1')
  })

  it('多选选择器:点一项是切换、不关弹层;写回是新数组(不共享引用)', async () => {
    await mount()
    const before = ((await dbNow()).rows[0].cells.rel as string[])
    await act(async () => { cellOf(0, '配件').querySelector<HTMLElement>('.amx-db-cellbtn')!.click() })
    const pop = host().querySelector('.amx-db-pop')!
    expect(pop).toBeTruthy()
    const opt = (title: string): HTMLElement => [...pop.querySelectorAll<HTMLElement>('.amx-db-opt')].find((e) => e.textContent?.startsWith(title))!
    expect(opt('CPU').getAttribute('aria-pressed')).toBe('true') // 已选打勾
    await act(async () => { opt('显卡').click() })
    expect(host().querySelector('.amx-db-pop')).toBeTruthy() // 没关
    const after = (await dbNow()).rows[0].cells.rel as string[]
    expect(after).toEqual(['p1', 'p3', 'p2'])
    expect(after).not.toBe(before)
    expect(before).toEqual(['p1', 'p3']) // 原数组没被原地改
    await act(async () => { opt('CPU').click() }) // 再点已选项 = 取消
    expect((await dbNow()).rows[0].cells.rel).toEqual(['p3', 'p2'])
  })

  it('按关联列排序 = 按目标行标题(不是 id 串)', async () => {
    // 夹具让 id 序与标题序**不同向**,否则「按 id 串排」也能假绿。
    const db = ordersDb([{ id: 'v', name: '表', type: 'table', sorts: [{ colId: 'rel', dir: 'asc' }] }])
    db.rows = [
      { id: 'o1', cells: { t: '甲', rel: 'p1' } }, // 标题 CPU;id p1
      { id: 'o2', cells: { t: '乙', rel: 'p3' } }, // 标题 内存;id p3
      { id: 'o3', cells: { t: '丙', rel: 'p2' } }, // 标题 显卡;id p2
    ]
    await mount(db)
    // applySorts 用 localeCompare('zh'):CLDR zh 把汉字排在拉丁字母前(拼音序)→ 内存 < 显卡 < CPU → 乙 丙 甲;
    // 若按 id 串排则 p1 < p2 < p3 → 甲 丙 乙(不同序,能区分)
    expect(firstCol()).toEqual(['乙', '丙', '甲'])
  })

  it('目标表改了标题 → 按关联列的排序跟着重排(rows useMemo 依赖里有 refDbs,不是陈旧序)', async () => {
    const db = ordersDb([{ id: 'v', name: '表', type: 'table', sorts: [{ colId: 'rel', dir: 'asc' }] }])
    // ⚠️ 去掉 lookup/formula 列:有它们时 compRows 本来就随 refDbs 重算、顺带把 rows 也重算了,
    // 只有「纯 rowlink 表」才暴露 rows useMemo 自己缺 refDbs 依赖的陈旧序。
    db.columns = db.columns.filter((c) => c.type !== 'lookup')
    db.rows = [
      { id: 'o1', cells: { t: '甲', rel: 'p1' } }, // CPU
      { id: 'o2', cells: { t: '乙', rel: 'p3' } }, // 内存
    ]
    await mount(db)
    expect(firstCol()).toEqual(['乙', '甲']) // 内存 < CPU(zh 排序汉字在前)
    const { useDbStore } = await import('../../store/dbStore')
    await act(async () => {
      const parts = partsDb()
      parts.rows[2].cells.n = 'RAM' // 内存 → RAM:现在 CPU < RAM
      useDbStore.setState((s) => ({ entries: { ...s.entries, [PARTS]: { status: 'ok', path: PARTS, data: parts } } }))
    })
    expect(firstCol()).toEqual(['甲', '乙'])
  })

  it('created 列按日期口径筛选(after)—— 它是 isDateish 的一员', async () => {
    await mount(ordersDb([{ id: 'v', name: '表', type: 'table', filters: [{ colId: 'at', op: 'after', value: '2026-08-31' }] }]))
    expect(firstCol()).toEqual(['甲'])
  })

  it('多选 picker:有搜索词时不把已选项置顶(Enter 取第一项 = 搜到的那个,不是把已选的取消)', async () => {
    await mount()
    // 让搜索词「显」同时命中 未选的 显卡(p2,表序在前)与 已选的 显示器(p3):置顶的话 items[0] 会变成已选项
    const { useDbStore } = await import('../../store/dbStore')
    await act(async () => {
      const parts = partsDb()
      parts.rows[2].cells.n = '显示器'
      useDbStore.setState((s) => ({ entries: { ...s.entries, [PARTS]: { status: 'ok', path: PARTS, data: parts } } }))
    })
    await act(async () => { cellOf(0, '配件').querySelector<HTMLElement>('.amx-db-cellbtn')!.click() })
    const search = host().querySelector<HTMLInputElement>('.amx-db-pop .amx-db-pop-input')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(search, '显'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect((await dbNow()).rows[0].cells.rel).toEqual(['p1', 'p3', 'p2']) // 选中了显卡,没动已选的
  })

  /** 列菜单:点表头打开,按按钮文本取项。 */
  const openColMenu = async (name: string): Promise<void> => {
    const th = [...host().querySelectorAll<HTMLElement>('.amx-db-hrow .amx-db-thbtn')].find((b) => b.textContent?.includes(name))!
    await act(async () => { th.click() })
  }
  const popText = (): string => host().querySelector('.amx-db-pop')?.textContent ?? ''
  const clickOpt = async (text: string): Promise<void> => {
    const b = [...host().querySelectorAll<HTMLElement>('.amx-db-pop .amx-db-opt')].find((e) => e.textContent?.startsWith(text))
    if (!b) throw new Error(`没有「${text}」选项;弹层:${popText()}`)
    await act(async () => { b.click() })
  }
  const colNow = async (id: string) => (await dbNow()).columns.find((c) => c.id === id)!

  it('列菜单·关联表:「允许多选」开关翻转 column.multiple(true → 删键 → true)', async () => {
    await mount()
    await openColMenu('配件')
    await clickOpt('允许多选')
    expect((await colNow('rel')).multiple).toBeUndefined()
    await clickOpt('允许多选')
    expect((await colNow('rel')).multiple).toBe(true)
  })

  it('列菜单·引用列反向模式:显示指回列(标「→ 本表」);切正向清掉反向字段;再切回反向可从头配完', async () => {
    await mount()
    await openColMenu('出库行')
    expect(popText()).toContain('目标表的哪一列指回本表')
    expect([...host().querySelectorAll<HTMLElement>('.amx-db-pop .amx-db-opt')].find((e) => e.textContent?.startsWith('订单'))?.textContent).toContain('→ 本表')
    await clickOpt('正向')
    const cleared = await colNow('back')
    expect(cleared.refDb).toBeUndefined()
    expect(cleared.lookupBackCol).toBeUndefined()
    expect(cleared.lookupCol).toBeUndefined()
    expect(cleared.lookupRel).toBeUndefined()
    expect(cellOf(0, '出库行').textContent).toBe('–') // 配置清了,值也空了
    await clickOpt('反向')
    await clickOpt('配件') // 目标表(dbFiles 里除本表外的 .db)
    expect((await colNow('back')).refDb).toBe(PARTS)
    await clickOpt('订单') // 指回列
    expect((await colNow('back')).lookupBackCol).toBe('ord')
    await clickOpt('名称') // 引用目标表的哪一列
    const done = await colNow('back')
    expect(done.lookupCol).toBe('n')
    expect(done.lookupRel).toBeUndefined() // 反向不带正向字段
    expect(cellOf(0, '出库行').textContent).toBe('CPU、显卡') // 配完即活
  })

  it('关联列筛选:kind 折算成 multiselect,has=目标行 id;筛选值控件列出目标行标题(不是空下拉)', async () => {
    await mount(ordersDb([{ id: 'v', name: '表', type: 'table', filters: [{ colId: 'rel', op: 'has', value: 'p3' }] }]))
    expect(firstCol()).toEqual(['甲'])
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-filterbtn')!.click() })
    const sels = [...host().querySelectorAll<HTMLSelectElement>('.amx-db-pop .amx-db-fltrow .amx-db-fltsel')]
    expect(sels).toHaveLength(3) // 列 / op / 值
    expect([...sels[1].options].map((o) => o.value)).toEqual(['has', 'nothas', 'empty', 'notempty']) // multiselect 口径
    expect([...sels[2].options].map((o) => o.textContent)).toEqual(['…', 'CPU', '显卡', '内存']) // 目标行标题,不是空下拉
    expect(sels[2].value).toBe('p3')
  })
})

/** 关联三件(P1-1 titleCol / P1-2 refFilter / P1-5 清理):同一套挂载,钉的仍是「静默」坏法 ——
 *  芯片显示列被忽略 / picker 不限定 / 删行留自引用 / 关联列失效后 lookup 装作还配着 / 不指回本表的列还能点。 */
describe('关联三件:titleCol / refFilter / 清理', () => {
  // linkLabel 的空值文案已 i18n 化 → 显式钉住语言
  beforeEach(() => { setLocaleGlobal('zh') })

  const chips = (i: number, colName: string): string[] => [...cellOf(i, colName).querySelectorAll('.amx-db-chip')].map((e) => e.textContent ?? '')
  const openColMenu = async (name: string): Promise<void> => {
    const th = [...host().querySelectorAll<HTMLElement>('.amx-db-hrow .amx-db-thbtn')].find((b) => b.textContent?.includes(name))!
    await act(async () => { th.click() })
  }
  const popText = (): string => host().querySelector('.amx-db-pop')?.textContent ?? ''
  const opts = (scope = '.amx-db-pop'): HTMLButtonElement[] => [...host().querySelectorAll<HTMLButtonElement>(`${scope} .amx-db-opt`)]
  const clickOpt = async (text: string, scope = '.amx-db-pop'): Promise<void> => {
    const b = opts(scope).find((e) => e.textContent?.startsWith(text))
    if (!b) throw new Error(`没有「${text}」选项;弹层:${popText()}`)
    await act(async () => { b.click() })
  }
  const colNow = async (id: string) => (await dbNow()).columns.find((c) => c.id === id)
  /** 带自动编号 + 公式列 + 指向别表的 rowlink 的配件表(芯片显示列 / 反向段禁用 用)。 */
  const richParts = (): DbFile => {
    const p = partsDb()
    p.columns.push({ id: 'sku', name: '编号', type: 'autonumber', prefix: 'SKU-' }, { id: 'f', name: '双倍', type: 'formula', formula: '{单价}*2' }, { id: 'sup', name: '供应商', type: 'rowlink', refDb: '供应商.db' })
    p.rows[0].cells.sku = 1
    p.rows[2].cells.sku = 3
    return p
  }

  it('titleCol:芯片按指定列显示(自动编号带前缀);指向计算列/不存在列回落首列;picker 与筛选值下拉同源', async () => {
    const db = ordersDb()
    db.columns = db.columns.map((c) => (c.id === 'rel' ? { ...c, titleCol: 'sku' } : c))
    await mount(db, richParts())
    expect(chips(0, '配件')).toEqual(['SKU-1', 'SKU-3']) // 不是 CPU/内存,也不是裸 1/3
    await act(async () => { cellOf(0, '配件').querySelector<HTMLElement>('.amx-db-cellbtn')!.click() })
    expect(opts().filter((b) => !b.classList.contains('amx-db-opt-clear')).map((b) => b.textContent?.replace('✓', ''))).toEqual(['SKU-1', 'SKU-3', '未命名'])
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-popwrap')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    // 回落:titleCol 指向公式列 → 首列
    const { useDbStore } = await import('../../store/dbStore')
    await act(async () => { useDbStore.getState().mutate(ORDERS, (d) => ({ ...d, columns: d.columns.map((c) => (c.id === 'rel' ? { ...c, titleCol: 'f' } : c)) })) })
    expect(chips(0, '配件')).toEqual(['CPU', '内存'])
  })

  it('列菜单·芯片显示列:候选 = 目标表非计算列,缺省 ✓ 在首列;选「编号」→ titleCol 落盘、芯片即变', async () => {
    await mount(ordersDb(), richParts())
    await openColMenu('配件')
    const sec = '.amx-db-pop [data-sec="titlecol"]'
    expect(opts(sec).map((b) => b.textContent?.replace('✓', ''))).toEqual(['名称', '单价', '订单', '编号', '供应商']) // 无「双倍」(公式列)
    expect(opts(sec).find((b) => b.textContent?.includes('✓'))?.textContent).toContain('名称')
    await clickOpt('编号', sec)
    expect((await colNow('rel'))?.titleCol).toBe('sku')
    expect(chips(0, '配件')).toEqual(['SKU-1', 'SKU-3'])
  })

  it('refFilter:picker 先按列的限定条件筛目标表行(单价 > 60 → 内存 50 不在候选),chip 不受影响;or 模式生效', async () => {
    const db = ordersDb()
    db.columns = db.columns.map((c) => (c.id === 'rel' ? { ...c, refFilter: [{ colId: 'p', op: 'gt', value: 60 }] } : c))
    await mount(db)
    expect(chips(0, '配件')).toEqual(['CPU', '内存']) // 已选的内存仍显示
    await act(async () => { cellOf(0, '配件').querySelector<HTMLElement>('.amx-db-cellbtn')!.click() })
    const titles = (): string[] => opts().filter((b) => !b.classList.contains('amx-db-opt-clear')).map((b) => b.textContent?.replace('✓', '') ?? '')
    expect(titles()).toEqual(['CPU', '显卡']) // 无 内存;已选 CPU 置顶
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-popwrap')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    const { useDbStore } = await import('../../store/dbStore')
    await act(async () => {
      useDbStore.getState().mutate(ORDERS, (d) => ({ ...d, columns: d.columns.map((c) => (c.id === 'rel' ? { ...c, refFilter: [{ colId: 'p', op: 'gt', value: 200 }, { colId: 'n', op: 'eq', value: '内存' }], refFilterMode: 'or' } : c)) }))
    })
    await act(async () => { cellOf(0, '配件').querySelector<HTMLElement>('.amx-db-cellbtn')!.click() })
    expect(titles()).toEqual(['内存', '显卡']) // or:单价>200 的显卡 ∪ 名称=内存;已选内存置顶
  })

  it('列菜单·限定候选:复用条件行编辑器(列源 = 目标表列),加条件落到 column.refFilter', async () => {
    await mount()
    await openColMenu('配件')
    await clickOpt('＋ 添加条件')
    expect((await colNow('rel'))?.refFilter).toEqual([{ colId: 'n', op: 'contains' }]) // 目标表首列 名称 + text 首个 op
    const sels = [...host().querySelectorAll<HTMLSelectElement>('.amx-db-pop .amx-db-fltrow .amx-db-fltsel')]
    expect([...sels[0].options].map((o) => o.textContent)).toEqual(['名称', '单价', '订单']) // 目标表列,不是本表列
    await clickOpt('清除全部')
    expect((await colNow('rel'))?.refFilter).toBeUndefined()
  })

  it('删行只清同文件自引用:父任务列(refDb=本表)摘掉被删行;指向别表的 rowlink 与别表指回本表的 cell 都不动', async () => {
    const db = ordersDb()
    db.columns.push({ id: 'parent', name: '父单', type: 'rowlink', refDb: ORDERS }, { id: 'kids', name: '子单', type: 'rowlink', refDb: './订单.db', multiple: true })
    db.rows[1].cells.parent = 'o1'
    db.rows[2].cells.kids = ['o1', 'o2']
    await mount(db)
    await act(async () => { dataRows()[0].querySelector<HTMLElement>('.amx-db-rowdel')!.click() })
    const d = await dbNow()
    expect(d.rows.map((r) => r.id)).toEqual(['o2', 'o3'])
    expect(d.rows[0].cells.parent).toBeUndefined()
    expect(d.rows[1].cells.kids).toEqual(['o2'])
    expect(d.rows[0].cells.rel).toBe('p2') // 指向别表的关联不动
    const { useDbStore } = await import('../../store/dbStore')
    expect((useDbStore.getState().entries[PARTS].data as DbFile).rows[0].cells.ord).toBe('o1') // 跨文件悬空刻意不级联(check:rowlink 报)
  })

  it('换目标表 → 沿它取值的正向 lookup 待重新配置(lookupRel/lookupCol 清空),本列 titleCol/refFilter 一并清;反向 lookup 不动', async () => {
    const db = ordersDb()
    db.columns = db.columns.map((c) => (c.id === 'rel' ? { ...c, titleCol: 'n', refFilter: [{ colId: 'p', op: 'gt', value: 1 }], refFilterMode: 'or' } : c))
    await mount(db, partsDb(), [ORDERS, PARTS, '别的.db'])
    expect(cellOf(0, '合计').textContent).toBe('150')
    await openColMenu('配件')
    await clickOpt('别的')
    const rel = (await colNow('rel'))!
    expect(rel.refDb).toBe('别的.db')
    expect(rel.titleCol).toBeUndefined()
    expect(rel.refFilter).toBeUndefined()
    expect(rel.refFilterMode).toBeUndefined()
    const sum = (await colNow('sum'))!
    expect(sum.lookupRel).toBeUndefined()
    expect(sum.lookupCol).toBeUndefined()
    expect(sum.type).toBe('lookup')
    expect((await colNow('back'))?.lookupBackCol).toBe('ord') // 反向 lookup 与它无关
    expect(cellOf(0, '合计').textContent).toBe('0') // 配置清了 → 命中空集;sum 聚合空集 = 0(lookup.ts 口径),不再是 150
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-popwrap')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await openColMenu('合计')
    expect(popText()).toContain('待重新配置')
    expect(popText()).not.toContain('引用目标表的哪一列') // 显式未选态:不再回落 relCols[0] 装作已选
  })

  it('关联列改类型 → 依赖它的 lookup **休眠不清**(lookupRel/lookupCol 原样、值空、菜单提示原关联列已失效);改回关联表即恢复;只有删列才清', async () => {
    await mount()
    expect(cellOf(0, '合计').textContent).toBe('150')
    await openColMenu('配件')
    await clickOpt('文本')
    const dormant = (await colNow('sum'))!
    expect(dormant.lookupRel).toBe('rel') // 不清:改类型可逆,配置跟着可逆
    expect(dormant.lookupCol).toBe('p')
    expect((await colNow('rel'))?.refDb).toBe(PARTS) // 非破坏式切类型:列自己的配置留着
    expect(cellOf(0, '合计').textContent).toBe('0') // 休眠期:lookup.ts 只沿 rowlink 列取值 → 空集,sum 聚合空集 = 0
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-popwrap')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await openColMenu('合计')
    expect(popText()).toContain('原关联列已失效') // 休眠提示(lookupRel 还在、但它已不是关联表列)
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-popwrap')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await openColMenu('配件')
    await clickOpt('关联表')
    expect((await colNow('sum'))?.lookupRel).toBe('rel')
    expect(cellOf(0, '合计').textContent).toBe('150') // 改回即原样恢复,用户一个配置都不用重做
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-popwrap')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await mount()
    await openColMenu('配件')
    await clickOpt('删除列')
    expect((await dbNow()).columns.some((c) => c.id === 'rel')).toBe(false)
    expect((await colNow('sum'))?.lookupRel).toBeUndefined() // 删列才真 detach(列没了,休眠也无从恢复)
    expect((await colNow('sum'))?.lookupCol).toBeUndefined()
  })

  it('反向段:不指回本表的关联列**禁用**(不是灰显可点),指回的仍可点', async () => {
    await mount(ordersDb(), richParts())
    await openColMenu('出库行')
    const sup = opts().find((b) => b.textContent?.startsWith('供应商'))!
    expect(sup.disabled).toBe(true)
    await act(async () => { sup.click() })
    expect((await colNow('back'))?.lookupBackCol).toBe('ord') // 没被改成 sup
    const ord = opts().find((b) => b.textContent?.startsWith('订单'))!
    expect(ord.disabled).toBe(false)
  })
})

/** W2-A 可编辑投影列(lookup + lookupKind='links'):真双向关联的反向侧 —— 渲 chip + picker 改**目标表**的 rowlink cell;
 *  本表磁盘永无投影 cell、mutate 零次。钉的仍是「静默」坏法:投影渲成拼接文本 / 写口写到本表 / 普通 lookup 被放行 / 半配置装作配好。 */
describe('可编辑投影列(lookupKind=links)', () => {
  const chips = (i: number, colName: string): string[] => [...cellOf(i, colName).querySelectorAll('.amx-db-chip')].map((e) => e.textContent ?? '')
  /** ordersDb 的反向列 back(扫 PARTS.ord)改成投影列(lookupCol/lookupAgg 对它无意义,一并去掉)。 */
  const projDb = (): DbFile => {
    const db = ordersDb()
    db.columns = db.columns.map((c) => (c.id === 'back' ? { ...c, lookupKind: 'links' as const, lookupCol: undefined, lookupAgg: undefined } : c))
    return db
  }
  const partsNow = async (): Promise<DbFile> => (await import('../../store/dbStore')).useDbStore.getState().entries[PARTS].data as DbFile
  const openColMenu = async (name: string): Promise<void> => {
    const th = [...host().querySelectorAll<HTMLElement>('.amx-db-hrow .amx-db-thbtn')].find((b) => b.textContent?.includes(name))!
    await act(async () => { th.click() })
  }
  const popText = (): string => host().querySelector('.amx-db-pop')?.textContent ?? ''
  const opts = (): HTMLButtonElement[] => [...host().querySelectorAll<HTMLButtonElement>('.amx-db-pop .amx-db-opt')]
  const clickOpt = async (text: string): Promise<void> => {
    const b = opts().find((e) => e.textContent?.startsWith(text))
    if (!b) throw new Error(`没有「${text}」选项;弹层:${popText()}`)
    await act(async () => { b.click() })
  }
  const colNow = async (id: string) => (await dbNow()).columns.find((c) => c.id === id)!
  /** 包一层 store.mutate 计数:本表(ORDERS)必须零次 —— 投影写只落目标表。 */
  const countOrdersMut = async (): Promise<() => number> => {
    const { useDbStore } = await import('../../store/dbStore')
    let n = 0
    const orig = useDbStore.getState().mutate
    useDbStore.setState({ mutate: (ref, fn) => { if (ref === ORDERS) n++; return orig(ref, fn) } })
    return () => n
  }

  it('投影列渲 chip(文案 = 目标表 titleCol/首列,不是顿号拼接文本);store 里本表无投影 cell', async () => {
    await mount(projDb())
    expect(chips(0, '出库行')).toEqual(['CPU', '显卡']) // p1.ord='o1', p2.ord 含 'o1'
    expect(chips(1, '出库行')).toEqual(['显卡'])
    expect(cellOf(2, '出库行').textContent).toContain('空')
    expect(cellOf(0, '出库行').querySelector('[data-backlink] .amx-db-cellbtn')).toBeTruthy()
    expect(cellOf(0, '合计').querySelector('.amx-db-cellbtn')).toBeNull() // 普通 lookup 没有写入口
    expect((await dbNow()).rows.every((r) => !('back' in r.cells))).toBe(true)
  })

  it('picker 列目标表的行(多选切换、不关弹层);点一行 → 目标表 rowlink cell 变(单值列 = 覆盖),本表 mutate 零次、无 cell;再点 = 摘掉', async () => {
    await mount(projDb())
    const muts = await countOrdersMut()
    await act(async () => { cellOf(2, '出库行').querySelector<HTMLElement>('.amx-db-cellbtn')!.click() }) // 丙(o3):没人指回
    const opt = (title: string): HTMLElement => [...host().querySelectorAll<HTMLElement>('.amx-db-pop .amx-db-opt')].find((e) => e.textContent?.startsWith(title))!
    expect(opts().filter((b) => !b.classList.contains('amx-db-opt-clear')).map((b) => b.textContent?.replace('✓', ''))).toEqual(['CPU', '显卡', '内存']) // 目标表的行
    await act(async () => { opt('内存').click() }) // p3.ord 缺 → 'o3'
    expect((await partsNow()).rows[2].cells.ord).toBe('o3')
    expect(host().querySelector('.amx-db-pop')).toBeTruthy() // 多选:不关
    expect(chips(2, '出库行')).toEqual(['内存'])
    expect(opt('内存').getAttribute('aria-pressed')).toBe('true')
    await act(async () => { opt('CPU').click() }) // p1.ord 'o1' → 'o3':单值列覆盖,甲失去 CPU
    expect((await partsNow()).rows[0].cells.ord).toBe('o3')
    expect(chips(0, '出库行')).toEqual(['显卡'])
    expect(chips(2, '出库行')).toEqual(['CPU', '内存'])
    await act(async () => { opt('CPU').click() }) // 再点 = 摘掉 → 删键
    expect('ord' in (await partsNow()).rows[0].cells).toBe(false)
    expect(muts()).toBe(0)
    expect((await dbNow()).rows.every((r) => !('back' in r.cells))).toBe(true)
  })

  it('「清空关联」走 setCell(undefined)→ 专用写口全摘(目标表多值 cell 摘一项、单值删键);本表仍零 mutate', async () => {
    await mount(projDb())
    const muts = await countOrdersMut()
    await act(async () => { cellOf(0, '出库行').querySelector<HTMLElement>('.amx-db-cellbtn')!.click() }) // 甲(o1)← p1(单值) / p2(数组)
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-pop .amx-db-opt-clear')!.click() })
    const parts = await partsNow()
    expect('ord' in parts.rows[0].cells).toBe(false)
    expect(parts.rows[1].cells.ord).toEqual(['o2'])
    expect(chips(0, '出库行')).toEqual([])
    expect(chips(1, '出库行')).toEqual(['显卡']) // 乙(o2)不受影响
    expect(muts()).toBe(0)
  })

  it('列菜单·反向段「作为可编辑关联(投影)」开关设/清 lookupKind;开着时不显示引用列/聚合段;切正向一并清', async () => {
    await mount() // back 仍是普通 join lookup
    await openColMenu('出库行')
    expect(popText()).toContain('作为可编辑关联')
    expect(popText()).toContain('引用目标表的哪一列')
    await clickOpt('作为可编辑关联')
    expect((await colNow('back')).lookupKind).toBe('links')
    expect(popText()).not.toContain('引用目标表的哪一列')
    expect(chips(0, '出库行')).toEqual(['CPU', '显卡']) // 配好即渲 chip(lookupCol 留着也无妨)
    await clickOpt('作为可编辑关联')
    expect((await colNow('back')).lookupKind).toBeUndefined()
    expect(cellOf(0, '出库行').textContent).toBe('CPU、显卡') // 回到 join 文本
    await clickOpt('作为可编辑关联')
    await clickOpt('正向')
    expect((await colNow('back')).lookupKind).toBeUndefined()
    expect((await colNow('back')).lookupBackCol).toBeUndefined()
  })

  it('配置坏(指回列不是 rowlink)→ 「待配置」提示、不渲 chip 不可点;半配置(缺 lookupBackCol)按普通 lookup 走;表单字段集不含投影列', async () => {
    const bad = projDb()
    bad.columns = bad.columns.map((c) => (c.id === 'back' ? { ...c, lookupBackCol: 'n' } : c))
    await mount(bad)
    expect(cellOf(0, '出库行').textContent).toBe('待配置')
    expect(cellOf(0, '出库行').querySelector('.amx-db-cellbtn')).toBeNull()
    const { formFields } = await import('./formLogic')
    expect(formFields(projDb().columns, {}).map((c) => c.id)).not.toContain('back')
    await act(async () => { root!.unmount() }); root = null
    const half = projDb()
    half.columns = half.columns.map((c) => (c.id === 'back' ? { ...c, lookupBackCol: undefined } : c))
    await mount(half)
    expect(cellOf(0, '出库行').textContent).toBe('–') // isLinksProjection 不成立 → 普通(空)lookup
  })
})
