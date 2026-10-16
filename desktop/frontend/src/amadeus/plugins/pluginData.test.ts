// @vitest-environment happy-dom
/** ctx.databases / ctx.noteTasks:订阅不引发重读风暴(一张坏表)、ready 区分「还在加载」与「真没有表」、
 *  写口的信任边界(未知列 / 盖章列 / 非法值一律 false)、删除的撤销只生效一次且不跨库、笔记任务改动的校验。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import type { MdMark } from '@amadeus-shared/mdMarks'

let disk: DbFile
let version = 'v0'
const readDatabase = vi.fn(async (p: string) => (p === 'T.db'
  ? { status: 'ok' as const, path: 'T.db', data: structuredClone(disk), version }
  : { status: 'missing' as const }))
const writeDatabaseCas = vi.fn(async (_p: string, d: DbFile) => { disk = structuredClone(d); version += '+'; return { ok: true, version } })
const patchMarkIpc = vi.fn(async () => true)
vi.mock('../api', () => ({
  amadeus: {
    get readDatabase() { return readDatabase },
    get writeDatabaseCas() { return writeDatabaseCas },
    writeDatabase: async () => {},
    listMarks: async () => [],
    get patchMark() { return patchMarkIpc },
    onDbExternalChange: undefined,
  },
}))
vi.mock('../store/automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))
vi.mock('../../amadeusPlugins', () => ({ ensureAmadeusReady: () => {} }))

const { useDbStore } = await import('../store/dbStore')
const { usePageStore } = await import('../store/pageStore')
const { useMdMarkStore } = await import('../store/mdMarkStore')
const { createDatabasesApi, createNoteTasksApi } = await import('./pluginData')

const base = (): DbFile => ({
  version: 1,
  name: 'T',
  columns: [
    { id: 'c1', name: '名称', type: 'text' },
    { id: 'd1', name: '日期', type: 'calendarDate' },
    { id: 'no', name: '编号', type: 'autonumber', prefix: 'E-' },
  ],
  rows: [{ id: 'r1', cells: { c1: '甲', d1: '2026-09-01', no: 3 } }],
})
const scope = { alive: () => true, own: (off: () => void) => off }
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const rowsNow = (): DbFile['rows'] => (useDbStore.getState().entries['T.db'].data as DbFile).rows

describe('ctx.databases', () => {
  beforeEach(() => {
    disk = base()
    version = 'v0'
    vi.clearAllMocks()
    useDbStore.setState({ entries: {} })
    usePageStore.setState({ vaultRoot: '/V', vaultSide: 'local', files: ['T.db', 'Broken.db'], filesPendingFor: null })
  })
  afterEach(async () => { await useDbStore.getState().flushAll() })

  it('一张坏表(missing)只读一次,不跟着每次 store 变化重读;ready 在两张都落定后才为真', async () => {
    const api = createDatabasesApi(scope)
    const seen: Array<{ ready: boolean; n: number }> = []
    const off = api.subscribe((s) => seen.push({ ready: s.ready, n: s.databases.length }))
    await flush(); await flush()
    expect(readDatabase.mock.calls.filter((c) => c[0] === 'Broken.db')).toHaveLength(1)
    expect(seen[0]).toEqual({ ready: false, n: 0 })
    expect(seen.at(-1)).toEqual({ ready: true, n: 1 })
    // 再改一格:触发回调,但不会再去读那张坏表
    api.setCell('T.db', 'r1', 'c1', '乙')
    await flush()
    expect(readDatabase.mock.calls.filter((c) => c[0] === 'Broken.db')).toHaveLength(1)
    off()
  })

  it('库里真没有表:ready 为真、列表为空', async () => {
    usePageStore.setState({ files: ['a.md'] })
    const seen: boolean[] = []
    createDatabasesApi(scope).subscribe((s) => seen.push(s.ready))()
    expect(seen).toEqual([true])
  })

  it('setCell 的信任边界:未知表 / 行 / 列、盖章列、非法值都不写', async () => {
    await useDbStore.getState().reload('T.db', 'T.db')
    const api = createDatabasesApi(scope)
    expect(api.setCell('Nope.db', 'r1', 'c1', 'x')).toBe(false)
    expect(api.setCell('T.db', 'rX', 'c1', 'x')).toBe(false)
    expect(api.setCell('T.db', 'r1', 'zz', 'x')).toBe(false)
    expect(api.setCell('T.db', 'r1', 'no', 9)).toBe(false)
    expect(api.setCell('T.db', 'r1', 'c1', { evil: 1 } as never)).toBe(false)
    expect(api.setCell('/T.db', 'r1', 'd1', '2026-10-20')).toBe(true) // 路径归一
    expect(rowsNow()[0].cells).toMatchObject({ c1: '甲', d1: '2026-10-20', no: 3 })
  })

  it('addRow 只收已有列;删除给一次性撤销,换了库不撤', async () => {
    await useDbStore.getState().reload('T.db', 'T.db')
    const api = createDatabasesApi(scope)
    const id = await api.addRow('T.db', { d1: '2026-10-21', ghost: 'x' }, '新行')
    expect(rowsNow().find((r) => r.id === id)?.cells).toMatchObject({ c1: '新行', d1: '2026-10-21', no: 4 })
    expect(rowsNow().find((r) => r.id === id)?.cells).not.toHaveProperty('ghost')

    const undo = api.deleteRow('T.db', 'r1')!
    expect(rowsNow().some((r) => r.id === 'r1')).toBe(false)
    undo(); undo()
    expect(rowsNow().filter((r) => r.id === 'r1')).toHaveLength(1)

    const undo2 = api.deleteRow('T.db', 'r1')!
    usePageStore.setState({ vaultSide: 'cloud' }) // 换到另一侧的库(同一份内存表还在,撤了就会写进去)
    undo2()
    expect(rowsNow().some((r) => r.id === 'r1')).toBe(false)
  })
})

describe('ctx.noteTasks.update', () => {
  const mark = (over: Partial<MdMark> = {}): MdMark => ({ path: 'n.md', title: 'n', heading: '', text: '交周报', isTask: true, checked: false, due: '2026-10-20', line: 3, raw: '- [ ] 交周报 @2026-10-20', occ: 0, ...over })
  beforeEach(() => { useMdMarkStore.setState({ marks: [mark(), mark({ line: 5, isTask: false, raw: '交周报 @2026-10-20' })], overlay: {}, ready: true }) })

  it('只认得到的 id、真任务才能勾、日期必须是真实存在的日子', () => {
    const api = createNoteTasksApi(scope)
    expect(api.update('n.md:9', { checked: true })).toBe(false)
    expect(api.update('n.md:5', { checked: true })).toBe(false)
    expect(api.update('n.md:3', { due: '2026-02-30' })).toBe(false)
    expect(api.update('n.md:3', { due: '2026-10-20/oops' })).toBe(false)
    expect(api.update('n.md:3', {})).toBe(false)
    expect(api.update('n.md:3', { checked: true, due: '2026-10-21T09:00' })).toBe(true)
    expect(useMdMarkStore.getState().overlay['n.md:3']).toEqual({ checked: true, due: '2026-10-21T09:00' })
  })
})
