// @vitest-environment happy-dom
/** 日历来源的颜色看守(calendarColors.ts):什么时候、拿哪一列来源去定色。取色本身的规则在 calendarConfigStore.test.ts。
 *  要钉的是老用户升级那一下:冷启动时来源分批到(表 → 默认日历 → Agent 日程;订阅一开始就在),
 *  播种必须等到齐,存下的才是升级前稳定下来的那套颜色,而不是半路上的过渡色。
 *  负对照(11-09 实跑红,一次只撤一处):播种不等引擎(去掉 engineAnswered 那一段)→ 「分批到齐」「宽限」红;
 *  不等 Agent 日程拉过 → 「没人拉过」红;没有宽限 → 「宽限」红;不等另一侧 → 「另一侧」红;
 *  calendarSourcePaths 不核对 loadedFor → 「换库」红;colorForDb 不读 autoColors → 「分批到齐」后半(移除成员)红。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import type { AgentScheduleInfo } from '../../types'

let human: DbFile | null = null
vi.mock('./humanCalendarIo', () => ({
  HUMAN_CAL: 'human://CALENDAR.db', humanCalLegacy: () => null,
  readHumanCal: async () => (human ? { status: 'ok' as const, path: 'human://CALENDAR.db', data: structuredClone(human), version: 'h0' } : { status: 'missing' as const }),
  writeHumanCalCas: async () => ({ ok: true as const, version: 'h1' }),
}))
const disk: Record<string, DbFile> = {}
vi.mock('../api', () => ({
  amadeus: {
    readDatabase: async (p: string) => (disk[p] ? { status: 'ok' as const, path: p, data: structuredClone(disk[p]), version: 'v0' } : { status: 'missing' as const }),
    writeDatabaseCas: async () => ({ ok: true, version: 'v1' }),
    writeDatabase: async () => {},
    listMarks: async () => [],
    onDbExternalChange: undefined,
  },
}))
vi.mock('./automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))
vi.mock('../../amadeusPlugins', () => ({ ensureAmadeusReady: () => {} }))
vi.mock('../../services/backendService', () => ({ getAgentSchedules: async () => [] }))

const { useDbStore } = await import('./dbStore')
const { usePageStore } = await import('./pageStore')
const { useCalendarConfig, colorForDb, EVENT_PALETTE: P } = await import('./calendarConfigStore')
const { useMdMarkStore } = await import('./mdMarkStore')
const { useAgentSchedules } = await import('../../stores/agentScheduleStore')
const { useIcsCalendars } = await import('../../stores/icsCalendarStore')
const { useOtherSideCal } = await import('../../stores/otherVaultCalStore')
const { acquireCalendarColors, GRACE_MS } = await import('./calendarColors')

const HUMAN = 'human://CALENDAR.db'
const AGENT = 'agent://muse/SCHEDULE.db'
const cols: DbFile['columns'] = [{ id: 'c1', name: '名称', type: 'text' }, { id: 'd1', name: '日期', type: 'calendarDate' }]
const table = (name: string): DbFile => ({ version: 1, name, columns: cols, rows: [] })
const agent: AgentScheduleInfo = { slug: 'muse', name: 'Muse', db: { version: 1, name: 'S', columns: cols, rows: [] }, entries: [] }
const otherDb = (root: string) => ({ path: `otherside:${root}/Work.db`, name: 'Work', isNoteView: false, readonly: true, columns: cols, rows: [] })
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0) }
const auto = (v = '/V'): Record<string, string> | undefined => useCalendarConfig.getState().byVault[v]?.autoColors
/** 老规则在这一列上的结果。 */
const legacy = (paths: string[]): Record<string, string> => Object.fromEntries(paths.map((p, i) => [p, P[i % P.length]]))
const shown = (paths: string[]): Record<string, string> => Object.fromEntries(paths.map((p, i) => [p, colorForDb('/V', useCalendarConfig.getState().byVault, p, i)]))
const engineUp = async (schedules: AgentScheduleInfo[] = [agent]): Promise<void> => {
  human = table('我的日历')
  await useDbStore.getState().load(HUMAN, HUMAN)
  useAgentSchedules.setState({ schedules, loaded: true, ok: true })
}

const offs: Array<() => void> = []
const watch = (): void => { offs.push(acquireCalendarColors()) }

beforeEach(async () => {
  vi.useFakeTimers()
  localStorage.clear()
  human = null
  for (const k of Object.keys(disk)) delete disk[k]
  disk['T.db'] = table('T'); disk['U.db'] = table('U')
  useDbStore.setState({ entries: {} })
  useCalendarConfig.setState({ byVault: {} })
  useMdMarkStore.setState({ marks: [], overlay: {} })
  // 冷启动的起点:引擎还没起来(默认日历读不到、Agent 日程拉失败留空),另一侧还没拉,订阅从 localStorage 里读出来就在
  useAgentSchedules.setState({ schedules: [], loaded: false, ok: false })
  useOtherSideCal.setState({ dbs: [], loadedFor: null })
  useIcsCalendars.setState({ subs: [{ id: 's1', name: '工作', url: '' }, { id: 's2', name: '节假日', url: '' }], events: {}, errors: {}, loading: {} })
  usePageStore.setState({ vaultRoot: '/V', vaultSide: 'local', files: ['T.db', 'U.db'], filesPendingFor: null })
})
afterEach(() => { for (const off of offs.splice(0)) off(); vi.useRealTimers() })

describe('日历来源颜色的看守', () => {
  it('老用户升级,来源分批到齐:没到齐不写(照旧按序号);到齐那一刻存下的就是老规则稳定后的那套;之后移除成员,订阅不换色', async () => {
    watch()
    await flush() // 表读完了
    await useDbStore.getState().load(HUMAN, HUMAN) // 默认日历:引擎没起来,读不到
    useAgentSchedules.setState({ schedules: [], loaded: true, ok: false }) // Agent 日程:拉失败
    useOtherSideCal.setState({ dbs: [], loadedFor: 'local:/V' })
    const early = ['T.db', 'U.db', 'ics://s1', 'ics://s2']
    expect(auto()).toBeUndefined() // 半路上的这一列不存
    expect(shown(early)).toEqual(legacy(early))
    // 引擎起来了:默认日历插到最前、Agent 日程排在订阅前面 —— 这才是用户升级前看惯的那一列
    await engineUp()
    const full = [HUMAN, 'T.db', 'U.db', AGENT, 'ics://s1', 'ics://s2']
    expect(auto()).toEqual(legacy(full))
    expect(JSON.parse(localStorage.getItem('amadeus.calendar.cfg')!)['/V'].autoColors).toEqual(legacy(full))
    // 方案页里复现的那一步:从日历里移除排在前面的一张表,后面两个订阅不许换色
    const before = shown(full)
    useCalendarConfig.getState().migrate('/V', [{ dbPath: 'T.db', dateCol: 'd1' }, { dbPath: 'U.db', dateCol: 'd1' }])
    useCalendarConfig.getState().removeMember('/V', 'T.db')
    const fewer = [HUMAN, 'U.db', AGENT, 'ics://s1', 'ics://s2']
    expect(shown(fewer)).toEqual(Object.fromEntries(fewer.map((p) => [p, before[p]])))
    expect(shown(fewer)).not.toEqual(legacy(fewer)) // 老规则这里会整体往前挪一格
    // Agent 日程没了(那个 Agent 被删)也一样
    useAgentSchedules.setState({ schedules: [], loaded: true, ok: true })
    expect(colorForDb('/V', useCalendarConfig.getState().byVault, 'ics://s1', 2)).toBe(before['ics://s1'])
  })

  it('引擎一直不答(旧引擎 / 不在本机):等满宽限再播,不会永远不播', async () => {
    watch()
    await flush()
    await useDbStore.getState().load(HUMAN, HUMAN)
    useAgentSchedules.setState({ schedules: [], loaded: true, ok: false })
    useOtherSideCal.setState({ dbs: [], loadedFor: 'local:/V' })
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1000)
    expect(auto()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2000)
    expect(auto()).toEqual(legacy(['T.db', 'U.db', 'ics://s1', 'ics://s2']))
  })

  it('没人拉过 Agent 日程(只开着待办 / 主页日程卡):等多久都不播种;有人拉了才播', async () => {
    watch()
    await flush()
    human = table('我的日历')
    await useDbStore.getState().load(HUMAN, HUMAN)
    useOtherSideCal.setState({ dbs: [], loadedFor: 'local:/V' })
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3)
    expect(auto()).toBeUndefined()
    useAgentSchedules.setState({ schedules: [agent], loaded: true, ok: true })
    expect(auto()).toEqual(legacy([HUMAN, 'T.db', 'U.db', AGENT, 'ics://s1', 'ics://s2']))
  })

  it('另一侧库没拉完不播种(它排在订阅前面);拉完就播', async () => {
    watch()
    await flush()
    await engineUp([])
    expect(auto()).toBeUndefined()
    useOtherSideCal.setState({ dbs: [otherDb('/Cloud')], loadedFor: 'local:/V' })
    expect(auto()).toEqual(legacy([HUMAN, 'T.db', 'U.db', 'otherside:/Cloud/Work.db', 'ics://s1', 'ics://s2']))
  })

  it('播种之后的新来源:不等叠加源,成员到齐就定,取用得最少的色;原来的都不动', async () => {
    watch()
    await flush()
    useOtherSideCal.setState({ dbs: [], loadedFor: 'local:/V' })
    await engineUp()
    const seeded = { ...auto() }
    // 下一次冷启动:引擎还没起来、另一侧没拉;这时新加了一个订阅
    useDbStore.setState((s) => ({ entries: { ...s.entries, [HUMAN]: { status: 'missing', path: null, data: null } } }))
    useAgentSchedules.setState({ schedules: [], loaded: false, ok: false })
    useOtherSideCal.setState({ dbs: [], loadedFor: null })
    useIcsCalendars.setState((s) => ({ subs: [...s.subs, { id: 's3', name: '新订阅', url: '' }] }))
    // 在场的是 T(P1) U(P2) s1(P4) s2(P5) → 最少用里按调色板顺序第一个是 P0
    expect(auto()).toEqual({ ...seeded, 'ics://s3': P[0] })
    // 笔记里第一次出现 `@` 日程 → 「笔记」这个来源也定色
    useMdMarkStore.setState({ marks: [{ path: 'a.md', line: 1, raw: '', text: '开会', due: '2026-11-10', isTask: false, title: 'a' } as never] })
    expect(auto()).toEqual({ ...seeded, 'ics://s3': P[0], 'mdnote://vault-notes': P[3] })
  })

  it('刚换库那一拍:另一侧 store 里还是上一个库的来源,不记到新库名下', async () => {
    watch()
    await flush()
    useOtherSideCal.setState({ dbs: [otherDb('/Cloud')], loadedFor: 'local:/V' })
    await engineUp([])
    expect(Object.keys(auto()!)).toContain('otherside:/Cloud/Work.db')
    useCalendarConfig.setState((s) => ({ byVault: { ...s.byVault, '/W': { colors: {}, hidden: [], defaultDbPath: null, members: {}, autoColors: {} } } })) // 新库播过种
    usePageStore.setState({ vaultRoot: '/W', vaultSide: 'local', files: ['T.db'], filesPendingFor: null })
    await flush()
    await useDbStore.getState().load(HUMAN, HUMAN) // 换库时 dbStore 整片作废,默认日历由 watchHumanCal 重读(看守不管加载)
    expect(auto('/W')).toEqual({ [HUMAN]: P[0], 'T.db': P[1], 'ics://s1': P[2], 'ics://s2': P[3] }) // 没有 otherside:/Cloud/…
  })

  it('多处共用一份订阅:最后一个使用者走了才停,重复释放不多减', async () => {
    const a = acquireCalendarColors(), b = acquireCalendarColors()
    await flush()
    useOtherSideCal.setState({ dbs: [], loadedFor: 'local:/V' })
    a(); a()
    await engineUp()
    expect(auto()).toBeDefined() // b 还在岗
    b()
    useIcsCalendars.setState((s) => ({ subs: [...s.subs, { id: 's9', name: '', url: '' }] }))
    expect(auto()!['ics://s9']).toBeUndefined()
  })
})
