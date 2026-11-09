import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCalendarConfig, memberOf, isMigrated, colorForDb, colorsSeeded, planAutoColors, EVENT_PALETTE as P } from './calendarConfigStore'

const V = '/vault'
const st = () => useCalendarConfig.getState()
const bv = () => useCalendarConfig.getState().byVault

beforeEach(() => useCalendarConfig.setState({ byVault: {} }))

describe('calendarConfigStore 成员制 + 迁移', () => {
  it('addMember / memberOf round-trip(checkbox 可选)', () => {
    st().addMember(V, 'a.db', 'dcol', 'ccol')
    expect(memberOf(V, bv(), 'a.db')).toEqual({ dateCol: 'dcol', checkboxCol: 'ccol' })
    st().addMember(V, 'b.db', 'd2')
    expect(memberOf(V, bv(), 'b.db')).toEqual({ dateCol: 'd2' })
  })

  it('removeMember 撤成员(不动别的库)', () => {
    st().addMember(V, 'a.db', 'd')
    st().addMember(V, 'b.db', 'd')
    st().removeMember(V, 'a.db')
    expect(memberOf(V, bv(), 'a.db')).toBeUndefined()
    expect(memberOf(V, bv(), 'b.db')).toEqual({ dateCol: 'd' })
  })

  it('migrate:补缺失 + 不覆盖显式成员 + 幂等置 flag', () => {
    st().addMember(V, 'explicit.db', 'chosen') // 用户已显式配好
    st().migrate(V, [
      { dbPath: 'explicit.db', dateCol: 'auto', checkboxCol: 'x' }, // 不该覆盖用户选择
      { dbPath: 'legacy.db', dateCol: 'ld', checkboxCol: 'lc' },
    ])
    expect(memberOf(V, bv(), 'explicit.db')).toEqual({ dateCol: 'chosen' })
    expect(memberOf(V, bv(), 'legacy.db')).toEqual({ dateCol: 'ld', checkboxCol: 'lc' })
    expect(isMigrated(V, bv())).toBe(true)
    // 二次迁移 no-op:新库不再自动收编(之后全靠显式添加)
    st().migrate(V, [{ dbPath: 'late.db', dateCol: 'x' }])
    expect(memberOf(V, bv(), 'late.db')).toBeUndefined()
  })

  it('migratePath 迁移成员键(改名不丢配置)', () => {
    st().addMember(V, 'old.db', 'd', 'c')
    st().migratePath(V, 'old.db', 'new.db')
    expect(memberOf(V, bv(), 'old.db')).toBeUndefined()
    expect(memberOf(V, bv(), 'new.db')).toEqual({ dateCol: 'd', checkboxCol: 'c' })
  })

  it('旧持久数据无 members 键不崩', () => {
    useCalendarConfig.setState({ byVault: { [V]: { colors: {}, hidden: [], defaultDbPath: null } as never } })
    expect(memberOf(V, bv(), 'x.db')).toBeUndefined()
    st().addMember(V, 'x.db', 'd')
    expect(memberOf(V, bv(), 'x.db')).toEqual({ dateCol: 'd' })
  })
})

/** 来源的颜色定下来就不动(2026-11-09)。老规则:没手选过的来源,颜色 = 调色板里「排第几个」的那个色 ——
 *  排在前面的来源多一个少一个,后面的全部换色。
 *  负对照(11-09 实跑红,一次只撤一处):colorForDb 不读 autoColors → 「顺序变」「清除手选色」「改名」「老形状」红;
 *  planAutoColors 播种后也按序号取 → 「取最少用」红;没到齐也播种 → 「升级播种」「只写一次」红;
 *  ensureColors 没有新来源也换引用 → 「原样返回」红;migratePath 不迁 autoColors → 「改名」红;
 *  slashCfg 不管 autoColors / 照换合成路径 → 「Windows」红;读不出来、原文没另存也照写 → 「一个字都不写」红;
 *  ensureColors 不看盘 / 整份落盘不带盘上的自动色(改名时不摘旧名字)→ 「别的窗口」红。 */
describe('来源颜色:定下来就不动', () => {
  /** 老规则在这一列上的结果(升级播种要和它一模一样)。 */
  const legacy = (paths: string[]): Record<string, string> => Object.fromEntries(paths.map((p, i) => [p, P[i % P.length]]))
  const shown = (paths: string[]): Record<string, string> => Object.fromEntries(paths.map((p, i) => [p, colorForDb(V, bv(), p, i)]))
  const ICS1 = 'ics://s1', ICS2 = 'ics://s2', AG = 'agent://muse/SCHEDULE.db'

  it('升级播种:存下的就是老规则此刻的结果;没到齐(seed=false)不播、照旧按序号', () => {
    const list = ['human://CALENDAR.db', 'a.db', 'b.db', AG, ICS1, ICS2]
    st().ensureColors(V, list, false)
    expect(colorsSeeded(V, bv())).toBe(false)
    expect(bv()[V]).toBeUndefined() // 一个字都没写
    expect(shown(list)).toEqual(legacy(list))
    st().ensureColors(V, list, true)
    expect(bv()[V].autoColors).toEqual(legacy(list))
    expect(shown(list)).toEqual(legacy(list)) // 屏幕上的颜色没变
    // 超过 8 个来源照老规则转回来
    const many = Array.from({ length: 11 }, (_, i) => `t${i}.db`)
    st().ensureColors('/big', many, true)
    expect(bv()['/big'].autoColors).toEqual(legacy(many))
  })

  it('顺序变了 / 中间少了一个 / 前面多了一个,其余来源颜色不变', () => {
    const list = ['a.db', 'b.db', AG, ICS1, ICS2]
    st().ensureColors(V, list, true)
    const before = shown(list)
    // 移除排在前面的 b.db(方案页里复现的那一步):两个订阅不许换色
    const fewer = ['a.db', AG, ICS1, ICS2]
    st().ensureColors(V, fewer, false)
    expect(shown(fewer)).toEqual(Object.fromEntries(fewer.map((p) => [p, before[p]])))
    // 冷启动:来源一个个到齐(订阅先到、表后到),每一步都是存下的那个色
    for (const partial of [[ICS1, ICS2], ['a.db', ICS1, ICS2], ['a.db', 'b.db', ICS1, ICS2], list]) {
      st().ensureColors(V, partial, false)
      expect(shown(partial)).toEqual(Object.fromEntries(partial.map((p) => [p, before[p]])))
    }
    // 前面插进一个新来源、顺序整个倒过来
    const more = ['new.db', ...[...list].reverse()]
    st().ensureColors(V, more, false)
    expect(shown(list)).toEqual(before)
    // 移除的来源留着它的色:加回来还是原来的
    expect(colorForDb(V, bv(), 'b.db', 99)).toBe(before['b.db'])
  })

  it('新来源取这一列里用得最少的色,并列按调色板顺序;已有的不动', () => {
    st().ensureColors(V, ['a.db', 'b.db', 'c.db'], true) // P0 P1 P2
    st().ensureColors(V, ['x.db', 'a.db', 'b.db', 'c.db'], false)
    expect(bv()[V].autoColors!['x.db']).toBe(P[3]) // 排第 0 个,老规则会给 P0(和 a.db 撞色)
    // 不在这一列里的来源不占名额:只剩 a(P0) 在场 → 最少用里按调色板顺序第一个是 P1
    st().ensureColors(V, ['a.db', 'y.db'], false)
    expect(bv()[V].autoColors!['y.db']).toBe(P[1])
    // 手选的调色板色也算在用
    st().setColor(V, 'a.db', P[4].toUpperCase())
    st().ensureColors(V, ['a.db', 'z.db'], false)
    expect(bv()[V].autoColors!['z.db']).toBe(P[0]) // a 现在显示 P4,P0 空出来了
    // 八个色都用过一轮之后,下一个从用得最少的里按顺序取
    const eight = Array.from({ length: 8 }, (_, i) => `e${i}.db`)
    st().ensureColors('/w', eight, true)
    st().ensureColors('/w', [...eight, 'n1.db', 'n2.db'], false)
    expect([bv()['/w'].autoColors!['n1.db'], bv()['/w'].autoColors!['n2.db']]).toEqual([P[0], P[1]])
    expect(bv()['/w'].autoColors).toMatchObject(legacy(eight))
  })

  it('没有新来源时原样返回(不换引用):调用方挂在 store 订阅上,不幂等就是死循环', () => {
    st().ensureColors(V, ['a.db', 'b.db'], true)
    const ref = bv()
    let fired = 0
    const off = useCalendarConfig.subscribe(() => { fired++ })
    st().ensureColors(V, ['b.db', 'a.db'], true)
    st().ensureColors(V, ['a.db'], false)
    st().ensureColors(V, [], true)
    off()
    expect(bv()).toBe(ref)
    expect(fired).toBe(0)
    expect(planAutoColors(bv()[V], ['a.db', 'b.db'], true)).toBeNull()
  })

  it('手选色永远优先、定色不碰它;清除手选色回到自动定下的那个色,不是重新按序号取', () => {
    st().setColor(V, 'b.db', '#123456')
    const list = ['a.db', 'b.db', 'c.db']
    st().ensureColors(V, list, true)
    expect(bv()[V].colors).toEqual({ 'b.db': '#123456' })
    expect(colorForDb(V, bv(), 'b.db', 1)).toBe('#123456')
    st().ensureColors(V, ['n.db', ...list], false)
    expect(bv()[V].colors).toEqual({ 'b.db': '#123456' })
    st().clearColor(V, 'b.db')
    expect(colorForDb(V, bv(), 'b.db', 5)).toBe(P[1]) // 播种时它排第 1 个;现在传进来的序号是 5 也不管
    // 定色之后才手选、再清除:同样回到定下的色
    st().setColor(V, 'c.db', '#abcdef')
    st().clearColor(V, 'c.db')
    expect(colorForDb(V, bv(), 'c.db', 0)).toBe(P[2])
  })

  it('migratePath:自动色跟着改名走;没播种过的库不凭空多出 autoColors', () => {
    st().ensureColors(V, ['a.db', 'old.db', 'c.db'], true)
    st().migratePath(V, 'old.db', 'new.db')
    expect(bv()[V].autoColors).toEqual({ 'a.db': P[0], 'new.db': P[1], 'c.db': P[2] })
    expect(colorForDb(V, bv(), 'new.db', 7)).toBe(P[1])
    st().addMember('/fresh', 'old.db', 'd')
    st().migratePath('/fresh', 'old.db', 'new.db')
    expect(colorsSeeded('/fresh', bv())).toBe(false)
  })

  it('老形状(没有 autoColors / 连 colors 都没有)不崩', () => {
    useCalendarConfig.setState({ byVault: { [V]: { hidden: [], defaultDbPath: null } as never } })
    expect(colorForDb(V, bv(), 'a.db', 2)).toBe(P[2])
    st().ensureColors(V, ['a.db'], true)
    expect(colorForDb(V, bv(), 'a.db', 2)).toBe(P[0])
  })
})

describe('来源颜色:落盘', () => {
  const KEY = 'amadeus.calendar.cfg'
  const WIN = 'C:\\Users\\me\\Vault'
  let data = new Map<string, string>()
  let failWrites = false
  beforeEach(() => {
    data = new Map<string, string>()
    failWrites = false
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { if (failWrites) throw new Error('QuotaExceededError'); data.set(key, value) },
      removeItem: (key: string) => data.delete(key),
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const boot = async () => (await import('./calendarConfigStore')).useCalendarConfig
  const disk = (): Record<string, Record<string, unknown>> => JSON.parse(data.get(KEY) ?? '{}')

  it('只在出现新路径时写一次;重启后读回同一套颜色;旧字段原样', async () => {
    const old = { colors: { 'b.db': '#123456' }, hidden: ['a.db'], defaultDbPath: 'a.db', members: { 'a.db': { dateCol: 'd' } }, migrated: true }
    data.set(KEY, JSON.stringify({ [V]: old }))
    let cfg = await boot()
    let writes = 0
    const real = localStorage.setItem
    localStorage.setItem = (k: string, v: string) => { writes++; real(k, v) }
    cfg.getState().ensureColors(V, ['a.db', 'b.db', 'ics://s1'], false) // 没到齐:不写
    expect(writes).toBe(0)
    cfg.getState().ensureColors(V, ['a.db', 'b.db', 'ics://s1'], true)
    cfg.getState().ensureColors(V, ['a.db', 'b.db', 'ics://s1'], true)
    cfg.getState().ensureColors(V, ['ics://s1', 'a.db'], false)
    expect(writes).toBe(1)
    expect(disk()[V]).toEqual({ ...old, autoColors: { 'a.db': P[0], 'b.db': P[1], 'ics://s1': P[2] } })
    vi.resetModules()
    cfg = await boot()
    expect(cfg.getState().byVault[V]).toEqual({ ...old, autoColors: { 'a.db': P[0], 'b.db': P[1], 'ics://s1': P[2] } })
  })

  it('Windows 老配置:autoColors 里库内路径的 `\\` 换成 `/`,合成路径(另一侧的绝对根)原样;没播种的不造键', async () => {
    const other = 'otherside:D:\\Cloud\\Vault/日程/任务.db'
    data.set(KEY, JSON.stringify({
      [WIN]: { colors: { [other]: '#f00000' }, hidden: [other], defaultDbPath: null, members: {}, autoColors: { '日程\\任务.db': P[3], [other]: P[5], 'ics://s1': P[6] } },
      'D:\\Unseeded': { colors: {}, hidden: [], defaultDbPath: null, members: {} },
    }))
    const { byVault } = (await boot()).getState()
    expect(byVault[WIN].autoColors).toEqual({ '日程/任务.db': P[3], [other]: P[5], 'ics://s1': P[6] })
    expect(byVault[WIN].colors).toEqual({ [other]: '#f00000' })
    expect(byVault[WIN].hidden).toEqual([other])
    expect('autoColors' in byVault['D:\\Unseeded']).toBe(false)
  })

  it('读不出来 ≠ 空:原文另存后才照常落盘,用户原来那份还在', async () => {
    data.set(KEY, '{"/vault":{"colors":{"a.db":"#123456"}') // 截断的 JSON
    const cfg = await boot()
    expect(cfg.getState().byVault).toEqual({})
    expect(data.get(`${KEY}.unreadable`)).toBe('{"/vault":{"colors":{"a.db":"#123456"}')
    cfg.getState().ensureColors(V, ['a.db'], true)
    expect(disk()[V].autoColors).toEqual({ 'a.db': P[0] })
    expect(data.get(`${KEY}.unreadable`)).toBe('{"/vault":{"colors":{"a.db":"#123456"}')
  })

  it('读不出来、原文也另存不了(配额满 / 不是对象同理):这一程一个字都不写,不拿「读失败当成的空」盖掉原来那份', async () => {
    for (const raw of ['{"/vault":{"colors":{"a.db":"#123456"}', '[1,2]', 'null']) {
      vi.resetModules()
      data = new Map([[KEY, raw]])
      failWrites = true
      const cfg = await boot()
      failWrites = false // 之后存储恢复了也不写:这一程内存里那份是「不知道」,不是用户的设置
      cfg.getState().ensureColors(V, ['a.db'], true)
      cfg.getState().setColor(V, 'a.db', '#000000')
      cfg.getState().addMember(V, 'a.db', 'd')
      cfg.getState().migrate(V, [])
      expect(data.get(KEY)).toBe(raw)
      expect(cfg.getState().byVault[V].autoColors).toEqual({ 'a.db': P[0] }) // 内存里照常定色,这一程颜色是稳的
    }
  })

  it('别的窗口(同一份 localStorage)先定过色 / 刚改过设置:自动定色以盘上的为准,不盖掉那边的改动', async () => {
    data.set(KEY, JSON.stringify({ [V]: { colors: {}, hidden: [], defaultDbPath: null, members: {} } }))
    const cfg = await boot() // 这个窗口启动时盘上还没播种
    // 另一个窗口:播了种(顺序和这边不一样)、用户还在那边给 a.db 选了色、加了成员
    data.set(KEY, JSON.stringify({ [V]: { colors: { 'a.db': '#123456' }, hidden: ['b.db'], defaultDbPath: null, members: { 'a.db': { dateCol: 'd' } }, autoColors: { 'b.db': P[0], 'a.db': P[1] } } }))
    cfg.getState().ensureColors(V, ['a.db', 'b.db', 'ics://s1'], true)
    // 盘上已有的两个照用(不按这边的顺序重播),只补盘上也没有的那个
    expect(cfg.getState().byVault[V].autoColors).toEqual({ 'b.db': P[0], 'a.db': P[1], 'ics://s1': P[2] })
    expect(disk()[V]).toEqual({ colors: { 'a.db': '#123456' }, hidden: ['b.db'], defaultDbPath: null, members: { 'a.db': { dateCol: 'd' } }, autoColors: { 'b.db': P[0], 'a.db': P[1], 'ics://s1': P[2] } })
    // 反过来:这个窗口里用户手势触发的整份落盘,不把别的窗口后来定的自动色冲掉
    const d = disk()
    ;(d[V].autoColors as Record<string, string>)['ics://s2'] = P[3]
    data.set(KEY, JSON.stringify(d))
    cfg.getState().toggleHidden(V, 'x.db')
    expect((disk()[V].autoColors as Record<string, string>)['ics://s2']).toBe(P[3])
    // 改名:盘上旧名字的自动色不被这一步又带回来
    cfg.getState().migratePath(V, 'b.db', 'renamed.db')
    expect(disk()[V].autoColors).toEqual({ 'renamed.db': P[0], 'a.db': P[1], 'ics://s1': P[2], 'ics://s2': P[3] })
  })
})
