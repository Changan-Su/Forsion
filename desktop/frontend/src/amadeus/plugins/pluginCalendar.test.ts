// @vitest-environment happy-dom
/** ctx.calendar 的 'calendar' 能力档(2026-10-17):快照里的成员 / 叠加源 / 颜色和宿主日历一致;叠加源的计时器与日历视图
 *  共用、最后一个使用者走了才停;写口的信任边界(颜色写法、路径只认表或叠加源、成员列类型、叠加源不能当成员 / 默认);
 *  插件停用后订阅不再回调、写口一律 false;设置按 vaultRoot 存(和宿主日历同一个键)。
 *  负对照(10-17 实跑红):释放函数不判 released → 计时器那条红;subscribe 不去重 → 「loading 位」红;
 *  legendPath 不查叠加源 → 改色那条红;setMember 不查列类型 → 成员那条红;vault 键用 `side:root` → 写口五条全红;
 *  回调前不看 scope.alive() → 「停用后」红。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import type { AgentScheduleInfo } from '../../types'

const disk: Record<string, DbFile> = {}
const readDatabase = vi.fn(async (p: string) => (disk[p]
  ? { status: 'ok' as const, path: p, data: structuredClone(disk[p]), version: 'v0' }
  : { status: 'missing' as const }))
vi.mock('../api', () => ({
  amadeus: {
    get readDatabase() { return readDatabase },
    writeDatabaseCas: async () => ({ ok: true, version: 'v1' }),
    writeDatabase: async () => {},
    listMarks: async () => [],
    onDbExternalChange: undefined,
  },
}))
vi.mock('../store/automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))
vi.mock('../../amadeusPlugins', () => ({ ensureAmadeusReady: () => {} }))
const getAgentSchedules = vi.fn(async (): Promise<AgentScheduleInfo[]> => [agent])
vi.mock('../../services/backendService', () => ({ getAgentSchedules: (...a: unknown[]) => getAgentSchedules(...(a as [])) }))

const { useDbStore } = await import('../store/dbStore')
const { usePageStore } = await import('../store/pageStore')
const { useCalendarConfig } = await import('../store/calendarConfigStore')
const { useAgentSchedules, acquireAgentSchedulePolling } = await import('../../stores/agentScheduleStore')
const { useIcsCalendars } = await import('../../stores/icsCalendarStore')
const { useOtherSideCal } = await import('../../stores/otherVaultCalStore')
const { createCalendarApi } = await import('./pluginCalendar')
const { createDatabasesApi } = await import('./pluginData')
type Snap = import('./types').PluginCalendarSnapshot

const table = (name: string, cols: DbFile['columns']): DbFile => ({ version: 1, name, columns: cols, rows: [{ id: 'r1', cells: { c1: '甲', d1: '2026-10-20' } }] })
const agent: AgentScheduleInfo = {
  slug: 'muse', name: 'Muse',
  db: { version: 1, name: 'S', columns: [{ id: 'n', name: '名称', type: 'text' }, { id: 'd', name: '时间', type: 'calendarDate' }], rows: [{ id: 'a1', cells: { n: '复盘', d: '2026-10-21T09:00' } }] },
  entries: [],
}
const AGENT = 'agent://muse/SCHEDULE.db'
const ICS = 'ics://s1'
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 假的插件作用域:own 登记退订,dispose = 插件停用(先置死、再统一退订,同 effectScope 的顺序)。 */
const scopes: Array<{ dispose(): void }> = []
function fakeScope() {
  let alive = true
  const offs = new Set<() => void>()
  const s = {
    alive: () => alive,
    own: (off: () => void) => { offs.add(off); return () => { if (offs.delete(off)) off() } },
    dispose: () => { alive = false; for (const off of [...offs]) { offs.delete(off); off() } },
    /** 只置死、还没轮到退订(effectScope 先置死再逐个退订,中间那一拍) */
    kill: () => { alive = false },
  }
  scopes.push(s)
  return s
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  disk['T.db'] = table('T', [{ id: 'c1', name: '名称', type: 'text' }, { id: 'd1', name: '日期', type: 'calendarDate' }, { id: 'k1', name: '完成', type: 'checkbox' }])
  disk['Plain.db'] = table('Plain', [{ id: 'c1', name: '名称', type: 'text' }])
  useDbStore.setState({ entries: {} })
  usePageStore.setState({ vaultRoot: '/V', vaultSide: 'local', files: ['T.db', 'Plain.db'], filesPendingFor: null })
  useCalendarConfig.setState({ byVault: {} })
  useAgentSchedules.setState({ schedules: [agent], loaded: true })
  useOtherSideCal.setState({ dbs: [] })
  useIcsCalendars.setState({ subs: [{ id: 's1', name: '工作', url: '' }], events: { s1: [{ uid: 'u1', summary: '周会', start: '2026-10-22', allDay: true }] }, errors: {}, loading: {} })
})
afterEach(() => { for (const s of scopes.splice(0)) s.dispose(); vi.useRealTimers() }) // 断言中途失败也别把计时器使用者漏给下一条

describe('ctx.calendar.subscribe', () => {
  it('快照:成员按宿主规则解析,叠加源按图例顺序且带来源,颜色覆盖成员与叠加源', async () => {
    const s = fakeScope()
    const seen: Snap[] = []
    const off = createCalendarApi(s).subscribe((x) => seen.push(x))
    await flush(); await flush()
    const last = seen.at(-1)!
    expect(last.ready).toBe(true)
    // 没迁移过 = 旧行为:有日期列的表就在日历里(首个日期列 + 首个勾选列),没日期列的 Plain 不在
    expect(last.members).toEqual([{ path: 'T.db', dateCol: 'd1', checkboxCol: 'k1' }])
    expect(last.overlays.map((o) => [o.path, o.origin])).toEqual([[AGENT, 'agent'], [ICS, 'ics']])
    expect(last.overlays[0].rows[0]).toMatchObject({ id: 'a1', name: '复盘' })
    expect(Object.keys(last.colors).sort()).toEqual(['T.db', AGENT, ICS].sort())
    expect(last.defaultPath).toBeNull()
    off()
  })

  it('只在输入变了时回调:.ics 的 loading 位不推快照,改设置会推', async () => {
    const s = fakeScope()
    const seen: Snap[] = []
    const api = createCalendarApi(s)
    api.subscribe((x) => seen.push(x))
    await flush(); await flush()
    const n = seen.length
    useIcsCalendars.setState({ loading: { s1: true } })
    expect(seen.length).toBe(n)
    expect(api.setHidden(ICS, true)).toBe(true)
    expect(seen.length).toBe(n + 1)
    expect(seen.at(-1)!.hidden).toEqual([ICS])
    s.dispose()
  })

  it('Agent 日程的计时器与日历视图共用:插件退订不停视图的表,最后一个走了才停;重复退订不多减', async () => {
    vi.useFakeTimers()
    const view = acquireAgentSchedulePolling() // 打开着的日历视图
    expect(getAgentSchedules).toHaveBeenCalledTimes(1)
    const a = fakeScope(), b = fakeScope()
    const offA = createCalendarApi(a).subscribe(() => {})
    createCalendarApi(b).subscribe(() => {})
    expect(getAgentSchedules).toHaveBeenCalledTimes(1) // 不另起一个计时器、不多拉
    offA(); offA() // 重复退订
    b.dispose() // 插件停用
    const raw = acquireAgentSchedulePolling()
    raw(); raw() // 释放函数被调两次(重复清理)也只减一次
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getAgentSchedules).toHaveBeenCalledTimes(2) // 视图还开着,表照走
    view()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(getAgentSchedules).toHaveBeenCalledTimes(2)
  })

  it('插件停用后:订阅不再回调,新订阅是空操作,写口一律 false', async () => {
    const s = fakeScope()
    const seen: Snap[] = []
    const api = createCalendarApi(s)
    api.subscribe((x) => seen.push(x))
    await flush(); await flush()
    const n = seen.length
    s.kill() // 已停用、退订还没轮到:这一拍里的变化也不许回调
    useCalendarConfig.getState().setColor('/V', 'T.db', '#000000')
    expect(seen.length).toBe(n)
    s.dispose()
    useCalendarConfig.getState().setColor('/V', 'T.db', '#111111')
    expect(seen.length).toBe(n)
    const late = vi.fn()
    api.subscribe(late)
    expect(late).not.toHaveBeenCalled()
    expect(api.setColor('T.db', '#112233')).toBe(false)
    expect(api.setHidden('T.db', true)).toBe(false)
    expect(api.setMember('T.db', 'd1')).toBe(false)
    expect(api.setDefault('T.db')).toBe(false)
    expect(api.removeMember('T.db')).toBe(false)
  })
})

describe('ctx.calendar 写口的信任边界', () => {
  beforeEach(async () => {
    await useDbStore.getState().reload('T.db', 'T.db')
    await useDbStore.getState().reload('Plain.db', 'Plain.db')
  })

  it('颜色:只收 #rrggbb;路径只认库里的表或当前叠加源;按 vaultRoot 存', () => {
    const api = createCalendarApi(fakeScope())
    expect(api.setColor('T.db', 'red')).toBe(false)
    expect(api.setColor('T.db', '#abc')).toBe(false)
    expect(api.setColor('T.db', 'url(x)' as string)).toBe(false)
    expect(api.setColor('没有.db', '#112233')).toBe(false)
    expect(api.setColor('ics://别人的', '#112233')).toBe(false)
    expect(api.setColor('T.db', '#AABBCC')).toBe(true)
    expect(api.setColor(ICS, '#112233')).toBe(true)
    expect(api.setColor(AGENT, '#445566')).toBe(true)
    const colors = useCalendarConfig.getState().byVault['/V'].colors // vaultRoot 键,不是 `local:/V`
    expect(colors).toEqual({ 'T.db': '#aabbcc', [ICS]: '#112233', [AGENT]: '#445566' })
    expect(api.setColor('T.db', null)).toBe(true)
    expect(useCalendarConfig.getState().byVault['/V'].colors['T.db']).toBeUndefined()
  })

  it('显隐:设成同一个值不来回翻', () => {
    const api = createCalendarApi(fakeScope())
    expect(api.setHidden('T.db', 'yes' as unknown as boolean)).toBe(false)
    expect(api.setHidden('T.db', true)).toBe(true)
    expect(api.setHidden('T.db', true)).toBe(true)
    expect(useCalendarConfig.getState().byVault['/V'].hidden).toEqual(['T.db'])
    expect(api.setHidden('T.db', false)).toBe(true)
    expect(useCalendarConfig.getState().byVault['/V'].hidden).toEqual([])
  })

  it('成员:日期列须是日期类、勾选列须是勾选类;叠加源 / 不存在的表不收;撤成员只认显式成员', () => {
    const api = createCalendarApi(fakeScope())
    expect(api.setMember('T.db', 'c1')).toBe(false) // 文本列当日期
    expect(api.setMember('T.db', 'd1', 'c1')).toBe(false) // 文本列当勾选
    expect(api.setMember('T.db', 'nope')).toBe(false)
    expect(api.setMember(ICS, 'date')).toBe(false)
    expect(api.setMember(AGENT, 'd')).toBe(false)
    expect(api.removeMember('T.db')).toBe(false) // 还不是显式成员
    expect(api.setMember('T.db', 'd1', 'k1')).toBe(true)
    expect(useCalendarConfig.getState().byVault['/V'].members['T.db']).toEqual({ dateCol: 'd1', checkboxCol: 'k1' })
    expect(api.setMember('T.db', 'd1')).toBe(true) // 会覆盖映射(和 ensureMember 的分工)
    expect(useCalendarConfig.getState().byVault['/V'].members['T.db']).toEqual({ dateCol: 'd1' })
    expect(api.removeMember('T.db')).toBe(true)
    expect(useCalendarConfig.getState().byVault['/V'].members['T.db']).toBeUndefined()
  })

  it('默认表:只认可写的成员;叠加源和不在日历里的表不收', () => {
    const api = createCalendarApi(fakeScope())
    useCalendarConfig.getState().migrate('/V', []) // 迁移过:成员全靠显式登记
    expect(api.setDefault('T.db')).toBe(false) // 不是成员
    expect(api.setDefault(ICS)).toBe(false)
    expect(api.setDefault('Plain.db')).toBe(false)
    expect(api.setMember('T.db', 'd1')).toBe(true)
    expect(api.setDefault('T.db')).toBe(true)
    expect(useCalendarConfig.getState().byVault['/V'].defaultDbPath).toBe('T.db')
  })

  it('没有活动库:写口一律 false', () => {
    usePageStore.setState({ vaultRoot: null })
    const api = createCalendarApi(fakeScope())
    expect(api.setColor('T.db', '#112233')).toBe(false)
    expect(api.setMember('T.db', 'd1')).toBe(false)
  })

  it('叠加源不能借 ctx.databases 的写口改(路径不是库里的表)', () => {
    const db = createDatabasesApi(fakeScope())
    expect(db.setCell(AGENT, 'a1', 'n', '改了')).toBe(false)
    expect(db.setCell(ICS, 'u1', 'name', '改了')).toBe(false)
    expect(db.deleteRow(AGENT, 'a1')).toBeNull()
  })
})
