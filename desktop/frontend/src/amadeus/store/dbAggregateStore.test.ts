// @vitest-environment happy-dom
/** 跨库聚合层的三个建行点与盖章的合并顺序(spec §6.7):
 *  createAggEvent = {...日期/名称, ...盖章}(盖章压最后:created 当日历锚时点击日不得伪造创建时间,codex 抓的;
 *  真日期列与盖章键不重叠,用户值照常保留);duplicateAggRow = {...源行, ...盖章}(盖章压掉
 *  复制来的编号);restoreAggRow 不盖章(撤销 = 原行原样回来)。外加一条 CAS 冲突重放:编号必须按重读后的
 *  最新行算(在 mutate 回调内),否则与引擎刚加的那行撞号。假磁盘/CAS 桩照抄 dbStore.test。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'

let disk: DbFile
let version = 'v0'
const bump = (): void => { version = `v${Number(version.slice(1)) + 1}` }
const readDatabase = vi.fn(async () => ({ status: 'ok' as const, path: 'T.db', data: structuredClone(disk), version }))
const writeDatabase = vi.fn(async (_p: string, d: DbFile) => { disk = structuredClone(d); bump() })
const writeDatabaseCas = vi.fn(async (_p: string, d: DbFile, base: string) => {
  if (base !== version) return { ok: false, version }
  disk = structuredClone(d)
  bump()
  return { ok: true, version }
})
vi.mock('../api', () => ({
  amadeus: {
    get readDatabase() { return readDatabase },
    get writeDatabase() { return writeDatabase },
    get writeDatabaseCas() { return writeDatabaseCas },
    onDbExternalChange: undefined,
  },
}))
vi.mock('./automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))
vi.mock('../../amadeusPlugins', () => ({ ensureAmadeusReady: () => {} }))

const { useDbStore } = await import('./dbStore')
const { createAggEvent, deleteAggRow, duplicateAggRow, restoreAggRow, setAggCell, firstDateCol, isDateCol } = await import('./dbAggregateStore')
type AggDb = import('./dbAggregateStore').AggDb

const base = (): DbFile => ({
  version: 1,
  name: 'T',
  columns: [
    { id: 'c1', name: '名称', type: 'text' },
    { id: 'd1', name: '日期', type: 'calendarDate' },
    { id: 'no', name: '编号', type: 'autonumber', prefix: 'E-' },
    { id: 'at', name: '创建时间', type: 'created' },
  ],
  rows: [{ id: 'r1', cells: { c1: '甲', d1: '2026-09-01', no: 3, at: '2020-01-01T00:00' } }],
})
const agg = (): AggDb => {
  const d = useDbStore.getState().entries['T.db'].data as DbFile
  return { path: 'T.db', name: 'T', isNoteView: false, columns: d.columns, rows: d.rows.map((r) => ({ rowId: r.id, name: String(r.cells.c1 ?? ''), cells: r.cells })) }
}
const rowsNow = (): DbFile['rows'] => (useDbStore.getState().entries['T.db'].data as DbFile).rows
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

describe('聚合层建行的盖章', () => {
  beforeEach(async () => {
    disk = base()
    version = 'v0'
    vi.clearAllMocks()
    useDbStore.setState({ entries: {} })
    await useDbStore.getState().reload('T.db', 'T.db')
  })
  // 每条用例末尾把防抖窗口里的 pendingOps 冲干净,否则会被重放进下一条用例(CAS 那条对此最敏感)
  afterEach(async () => { await useDbStore.getState().flushAll() })

  it('createAggEvent:编号 max+1、创建时间盖章;日期/名称是用户给的值(压过盖章)', async () => {
    const id = await createAggEvent(agg(), 'd1', '2026-09-02T10:00', '新事件')
    const nr = rowsNow().find((r) => r.id === id)!
    expect(nr.cells).toMatchObject({ c1: '新事件', d1: '2026-09-02T10:00', no: 4 })
    expect(nr.cells.at).toMatch(STAMP)
  })

  it('createAggEvent 以 created 列为日历锚:点击日**不能**伪造创建时间,盖章压在最后', async () => {
    const id = await createAggEvent(agg(), 'at', '2020-05-05', '伪造')
    const nr = rowsNow().find((r) => r.id === id)!
    expect(nr.cells.at).toMatch(STAMP)
    expect(nr.cells.at).not.toBe('2020-05-05')
    expect(nr.cells).toMatchObject({ c1: '伪造', no: 4 })
  })

  it('duplicateAggRow:复制全部单元格,但编号/创建时间被**重新**盖章(不是复制来的 3 / 2020)', async () => {
    const id = await duplicateAggRow(agg(), 'r1')
    const nr = rowsNow().find((r) => r.id === id)!
    expect(nr.cells.c1).toBe('甲')
    expect(nr.cells.d1).toBe('2026-09-01')
    expect(nr.cells.no).toBe(4)
    expect(nr.cells.at).toMatch(STAMP)
    expect(nr.cells.at).not.toBe('2020-01-01T00:00')
  })

  it('restoreAggRow:原行原样回来(rowId / 编号 / 创建时间都不变),绝不盖章', async () => {
    const src = agg().rows[0]
    useDbStore.getState().mutate('T.db', (d) => ({ ...d, rows: [] }))
    restoreAggRow(agg(), src)
    expect(rowsNow()).toEqual([{ id: 'r1', cells: { c1: '甲', d1: '2026-09-01', no: 3, at: '2020-01-01T00:00' } }])
  })

  it('CAS 冲突重放:编号按重读后的最新行算 —— 引擎在防抖窗口里加了 5 号,用户的新行落盘后是 6 号不是 4 号', async () => {
    const id = await createAggEvent(agg(), 'd1', '2026-09-02', '用户加的')
    expect(rowsNow().find((r) => r.id === id)!.cells.no).toBe(4) // 内存态先按当时的行算
    // 与此同时引擎往同一张表加了一行(直接改「磁盘」,票据前进)—— 它也盖了章:5
    disk = { ...disk, rows: [...disk.rows, { id: 'r9', cells: { c1: '自动化加的', no: 5 } }] }
    bump()
    await useDbStore.getState().flushAll()
    expect(writeDatabaseCas).toHaveBeenCalledTimes(2) // 第一次撞、重放后第二次成功
    const nums = disk.rows.map((r) => r.cells.no)
    expect(nums).toEqual([3, 5, 6]) // 重放时回调拿到 r9 → max+1 = 6;若在回调外算死就是 [3,5,4](与内存态一样,但下一次就撞 5)
    expect(new Set(nums).size).toBe(nums.length) // 核心断言:没有撞号
  })

  it('setAggCell 对盖章列(autonumber / created)是 no-op,普通列照常写', () => {
    setAggCell(agg(), 'r1', 'no', 99)
    setAggCell(agg(), 'r1', 'at', '2030-01-01T00:00')
    setAggCell(agg(), 'r1', 'c1', '乙')
    expect(rowsNow()[0].cells).toEqual({ c1: '乙', d1: '2026-09-01', no: 3, at: '2020-01-01T00:00' })
  })

  it('isDateCol / firstDateCol:created 算日期列但只当兜底,不抢在真日期列前面', () => {
    const cols = base().columns
    expect(isDateCol(cols[3])).toBe(true)
    // created 排在 calendarDate 前面也不该被选中
    const db: AggDb = { ...agg(), columns: [cols[0], cols[3], cols[1]] }
    expect(firstDateCol(db)?.id).toBe('d1')
    const only: AggDb = { ...agg(), columns: [cols[0], cols[3]] }
    expect(firstDateCol(only)?.id).toBe('at')
  })
})

/** 删行 → 撤销要把同文件自引用一起带回来(deleteAggRow 摘掉的清单交给 restoreAggRow 条件回填)。 */
describe('deleteAggRow / restoreAggRow:同文件自引用随撤销回来', () => {
  const selfRef = (): DbFile => ({
    version: 1,
    name: 'T',
    columns: [
      { id: 'c1', name: '名称', type: 'text' },
      { id: 'parent', name: '父任务', type: 'rowlink', refDb: 'T.db' },
      { id: 'deps', name: '依赖', type: 'rowlink', refDb: './T.db', multiple: true },
      { id: 'proj', name: '项目', type: 'rowlink', refDb: 'P.db' },
    ],
    rows: [
      { id: 'r1', cells: { c1: '甲' } },
      { id: 'r2', cells: { c1: '乙', parent: 'r1', deps: ['r1', 'r3'], proj: 'r1' } },
      { id: 'r3', cells: { c1: '丙', deps: ['r1'] } },
    ],
  })
  beforeEach(async () => {
    disk = selfRef()
    version = 'v0'
    vi.clearAllMocks()
    useDbStore.setState({ entries: {} })
    await useDbStore.getState().reload('T.db', 'T.db')
  })
  afterEach(async () => { await useDbStore.getState().flushAll() })
  const row = (id: string) => rowsNow().find((r) => r.id === id)!

  it('删 r1 → 单值 parent 删键、多值 deps 摘掉 r1;返回的清单记了三格(before/after);指向别表的 proj 不动', () => {
    const removed = deleteAggRow(agg(), 'r1')
    expect(rowsNow().map((r) => r.id)).toEqual(['r2', 'r3'])
    expect(row('r2').cells).toEqual({ c1: '乙', deps: ['r3'], proj: 'r1' })
    expect(row('r3').cells).toEqual({ c1: '丙' })
    expect(removed).toEqual([
      { rowId: 'r2', colId: 'parent', before: 'r1', after: undefined },
      { rowId: 'r2', colId: 'deps', before: ['r1', 'r3'], after: ['r3'] },
      { rowId: 'r3', colId: 'deps', before: ['r1'], after: undefined },
    ])
  })

  it('删 → 撤销:行回来,单值与多值自引用都回来(与删前逐字节相同)', () => {
    const src = agg().rows[0]
    const removed = deleteAggRow(agg(), 'r1')
    restoreAggRow(agg(), src, removed)
    const back = rowsNow()
    expect(back.find((r) => r.id === 'r1')!.cells).toEqual({ c1: '甲' })
    expect(back.find((r) => r.id === 'r2')!.cells).toEqual(selfRef().rows[1].cells)
    expect(back.find((r) => r.id === 'r3')!.cells).toEqual(selfRef().rows[2].cells)
  })

  it('负对照:不带清单撤销(旧行为)→ 行回来了但关联没回来', () => {
    const src = agg().rows[0]
    deleteAggRow(agg(), 'r1')
    restoreAggRow(agg(), src)
    expect(row('r2').cells.parent).toBeUndefined()
    expect(row('r2').cells.deps).toEqual(['r3'])
  })

  it('条件回填:删与撤销之间用户改过那一格 → 保留用户的值,没改的格照常回填', () => {
    const src = agg().rows[0]
    const removed = deleteAggRow(agg(), 'r1')
    setAggCell(agg(), 'r2', 'deps', ['r3', 'r9']) // 用户在撤销前把依赖改成了别的
    restoreAggRow(agg(), src, removed)
    expect(row('r2').cells.deps).toEqual(['r3', 'r9']) // 不吞用户的新编辑
    expect(row('r2').cells.parent).toBe('r1') // 同一行没被改的格照常回来
    expect(row('r3').cells.deps).toEqual(['r1'])
  })

  it('没人引用被删行 → 清单为空;撤销照常只回一行', () => {
    const src = agg().rows[2]
    const removed = deleteAggRow(agg(), 'r3')
    expect(removed).toEqual([{ rowId: 'r2', colId: 'deps', before: ['r1', 'r3'], after: ['r1'] }])
    const removed2 = deleteAggRow(agg(), 'r2')
    expect(removed2).toEqual([])
    restoreAggRow(agg(), src, removed)
    expect(row('r3').cells).toEqual({ c1: '丙', deps: ['r1'] })
  })
})
