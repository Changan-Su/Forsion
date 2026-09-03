// ctx.automation.ensure / ctx.calendar.ensureMember 的宿主侧(2026-09-02):
//  ① 闸:探针给不出 waitBackend(台架假探针 / 旧宿主 / 非 Tangu)→ ctx.automation 整个不存在;calendar 不受探针闸;
//  ② 等待:库没恢复就等,超时(60s)整批拒且零下发;库晚到也能发;后端超时整批拒;
//  ③ 单条坏规则只进 errors,其余照发;单条 HTTP 失败只记那一条;
//  ④ 用户禁用插件 → 只把 `plugin:<id>:` 前缀且 enabled 的规则 upsert 成 enabled:false,别家/已停的不动,where 原样带回;
//  ⑤ calendar:已成员 no-op;库晚到延后登记。
// 负对照(已实跑红):闸改成 readTangu() 本身 → ①红;disablePluginRules 去掉前缀过滤 → ④红;
// ensureMember 去掉 memberOf 判断 → ⑤「已成员 no-op」红;waitVaultRoot 超时 resolve('') 也下发 → ②「零下发」红。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { MuseTriggerInfo, MuseTriggerUpsert, TanguDesktopConfig } from '../../types'

const calls = {
  save: [] as MuseTriggerUpsert[],
  list: [] as MuseTriggerInfo[],
  failIds: new Set<string>(),
  /** 给交错用:非空时引擎名册按「已发生的 save」派生,静态 list 量不出下发与停用的先后。 */
  listOf: null as null | (() => MuseTriggerInfo[]),
  /** 给交错用:挂住**第一笔** save(用完即清),模拟 ensure 正发到一半。 */
  hold: null as null | Promise<void>,
}
vi.mock('../../services/backendService', () => ({
  saveMuseTrigger: vi.fn(async (_cfg: unknown, input: MuseTriggerUpsert) => {
    if (calls.failIds.has(String(input.id))) throw new Error('HTTP 400')
    if (calls.hold) { const h = calls.hold; calls.hold = null; await h }
    calls.save.push(input)
    return { ...input }
  }),
  getMuseTriggers: vi.fn(async () => calls.listOf?.() ?? calls.list),
}))

const { usePluginStore, getPluginDisableState } = await import('./pluginStore')
const { usePageStore } = await import('../store/pageStore')
const { setTanguProbe } = await import('./tanguSeam')
const { useCalendarConfig, memberOf } = await import('../store/calendarConfigStore')
type Ctx = import('./types').PluginContext
type Rule = import('./types').PluginAutomationRule

const CFG: TanguDesktopConfig = { backendUrl: 'http://t', token: 'tok', modelId: '' }
const probe = (waitBackend?: (ms: number) => Promise<TanguDesktopConfig | null>, subscribeReady?: (cb: () => void) => () => void) => ({
  activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {},
  ...(waitBackend ? { waitBackend } : {}),
  ...(subscribeReady ? { subscribeReady } : {}),
})

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!
}
const rule = (over: Partial<Rule> = {}): Rule => ({
  key: 'out-added', desc: '出库', cond_type: 'db_changed', path: 'erp/出库.db', event: 'row_added',
  actions: [{ type: 'notify', title: 't' }], ...over,
})

beforeEach(() => {
  calls.save = []
  calls.list = []
  calls.failIds = new Set()
  calls.listOf = null
  calls.hold = null
  usePageStore.setState({ vaultRoot: '/v' })
  useCalendarConfig.setState({ byVault: {} })
  setTanguProbe(probe(async () => CFG))
})
afterEach(() => {
  vi.useRealTimers()
  setTanguProbe(null)
})

describe('ctx.automation 的闸', () => {
  it('探针没有 waitBackend(台架 / 旧宿主)→ ctx.automation 不存在;探针为 null 同样;calendar 不受探针闸', () => {
    setTanguProbe(probe())
    const a = ctxOf('p-old')
    expect(a.automation).toBeUndefined()
    expect(typeof a.calendar?.ensureMember).toBe('function')
    setTanguProbe(null)
    expect(ctxOf('p-none').automation).toBeUndefined()
  })
  it('探针带 waitBackend → 注入', () => {
    expect(typeof ctxOf('p-new').automation?.ensure).toBe('function')
  })
})

describe('ctx.automation.ensure', () => {
  it('id 加 plugin:<id>: 前缀、vault 绑当前库、enabled true;坏规则只进 errors,其余照发', async () => {
    const ctx = ctxOf('pc-erp')
    const r = await ctx.automation!.ensure([rule(), rule({ key: 'Bad Key' })])
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(calls.save.map((u) => [u.id, u.vault, u.enabled])).toEqual([['plugin:pc-erp:out-added', '/v', true]])
    const ok = await ctx.automation!.ensure([rule()])
    expect(ok).toEqual({ ok: true, errors: [] })
  })

  it('库没恢复:等到超时 → 整批拒 "No vault is open",零下发', async () => {
    vi.useFakeTimers()
    usePageStore.setState({ vaultRoot: null })
    const ctx = ctxOf('pc-erp')
    const p = ctx.automation!.ensure([rule()])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await p).toEqual({ ok: false, errors: ['No vault is open'] })
    expect(calls.save).toHaveLength(0)
  })

  it('库晚到(插件 setup 早于 restoreVault)→ 等到再发', async () => {
    vi.useFakeTimers()
    usePageStore.setState({ vaultRoot: null })
    const ctx = ctxOf('pc-erp')
    const p = ctx.automation!.ensure([rule()])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.save).toHaveLength(0)
    usePageStore.setState({ vaultRoot: '/late' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ ok: true, errors: [] })
    expect(calls.save[0].vault).toBe('/late')
  })

  it('等待窗口里用户禁用了插件 → 让位,零下发(否则 ensure 醒来把 disable 刚关的规则开回去)', async () => {
    vi.useFakeTimers()
    usePageStore.setState({ vaultRoot: null })
    const ctx = ctxOf('pc-erp')
    const p = ctx.automation!.ensure([rule()])
    await vi.advanceTimersByTimeAsync(1_000)
    usePluginStore.getState().disable('pc-erp')
    usePageStore.setState({ vaultRoot: '/late' })
    await vi.advanceTimersByTimeAsync(0)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/disabled/)
    expect(calls.save.filter((u) => u.enabled)).toHaveLength(0)
  })

  it('后端等不到(waitBackend → null)→ 整批拒,零下发;单条 HTTP 失败只记那一条', async () => {
    setTanguProbe(probe(async () => null))
    const r = await ctxOf('pc-erp').automation!.ensure([rule()])
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/未就绪/)
    expect(calls.save).toHaveLength(0)

    setTanguProbe(probe(async () => CFG))
    calls.failIds.add('plugin:pc-erp:b')
    const r2 = await ctxOf('pc-erp').automation!.ensure([rule({ key: 'a' }), rule({ key: 'b' }), rule({ key: 'c' })])
    expect(r2.ok).toBe(false)
    expect(r2.errors).toEqual(['plugin:pc-erp:b: HTTP 400'])
    expect(calls.save.map((u) => u.id)).toEqual(['plugin:pc-erp:a', 'plugin:pc-erp:c'])
  })

  it('cfg 是调用时经探针拿的,不是建 context 时捕获的', async () => {
    let cur: TanguDesktopConfig | null = null
    setTanguProbe(probe(async () => cur))
    const ctx = ctxOf('pc-erp')
    cur = { ...CFG, token: 'later' }
    const { saveMuseTrigger } = await import('../../services/backendService')
    await ctx.automation!.ensure([rule()])
    expect(vi.mocked(saveMuseTrigger).mock.calls.at(-1)![0]).toEqual(cur)
  })
})

const tr = (id: string, enabled: boolean): MuseTriggerInfo => ({
  id, desc: id, enabled, cooldownHours: 0, lastFiredAt: null, createdAt: '',
  cond: { type: 'db_changed', path: 'a.db', vault: '/v', event: 'row_added', where: [{ column: 'c', op: 'notempty' }] },
  actions: [{ type: 'notify', title: 't' }],
})

/** 可控探针:waitBackend 按 backendOk 给 CFG 或 null;fireReady() 模拟 !ok→ok 边沿。 */
const readyProbe = () => {
  const cbs = new Set<() => void>()
  const st = { backendOk: false, subs: 0, offs: 0 }
  setTanguProbe(probe(async () => (st.backendOk ? CFG : null), (cb) => { cbs.add(cb); st.subs++; return () => { cbs.delete(cb); st.offs++ } }))
  return { st, fireReady: () => { for (const cb of cbs) cb() } }
}

describe('禁用插件 → 它的规则 enabled=false', () => {
  it('只动 plugin:<id>: 前缀且 enabled 的;别家 / 已停的不动;where 与 cooldown 0 原样带回', async () => {
    calls.list = [tr('plugin:pc-erp:a', true), tr('plugin:pc-erp:b', false), tr('plugin:pc-erp2:a', true), tr('w-user1', true)]
    ctxOf('pc-erp')
    expect(usePluginStore.getState().isActive('pc-erp')).toBe(true)
    usePluginStore.getState().disable('pc-erp')
    await vi.waitFor(() => expect(calls.save).toHaveLength(1))
    expect(calls.save[0]).toMatchObject({ id: 'plugin:pc-erp:a', enabled: false, cooldown_hours: 0, where: [{ column: 'c', op: 'notempty' }] })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.save).toHaveLength(1)
  })
  it('非 Tangu 宿主(无 waitBackend)禁用时不拉列表', async () => {
    setTanguProbe(probe())
    calls.list = [tr('plugin:pc-erp:a', true)]
    ctxOf('pc-erp')
    usePluginStore.getState().disable('pc-erp')
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.save).toHaveLength(0)
  })
})

describe('ctx.calendar.ensureMember', () => {
  it('登记为成员(路径归一);已是成员 no-op(不覆盖用户改过的列映射)', () => {
    const ctx = ctxOf('pc-erp')
    ctx.calendar!.ensureMember('/erp\\任务表.db', 'c-date', 'c-done')
    expect(memberOf('/v', useCalendarConfig.getState().byVault, 'erp/任务表.db')).toEqual({ dateCol: 'c-date', checkboxCol: 'c-done' })
    useCalendarConfig.getState().addMember('/v', 'erp/任务表.db', 'c-user') // 用户改过
    ctx.calendar!.ensureMember('erp/任务表.db', 'c-date')
    expect(memberOf('/v', useCalendarConfig.getState().byVault, 'erp/任务表.db')).toEqual({ dateCol: 'c-user' })
    ctx.calendar!.ensureMember('', 'c') // 空路径 / 空列:无事发生
    ctx.calendar!.ensureMember('x.db', ' ')
    expect(Object.keys(useCalendarConfig.getState().byVault['/v'].members)).toEqual(['erp/任务表.db'])
  })
  it('库晚到 → 延后登记', async () => {
    vi.useFakeTimers()
    usePageStore.setState({ vaultRoot: null })
    const ctx = ctxOf('pc-erp')
    ctx.calendar!.ensureMember('erp/任务表.db', 'c-date')
    expect(useCalendarConfig.getState().byVault['/late']).toBeUndefined()
    usePageStore.setState({ vaultRoot: '/late' })
    await vi.advanceTimersByTimeAsync(0)
    expect(memberOf('/late', useCalendarConfig.getState().byVault, 'erp/任务表.db')).toEqual({ dateCol: 'c-date' })
  })
})

// ── 宿主重放 ensure(2026-09-02):后端 !ok→ok 边沿 → 对上次失败且仍启用的插件重放一次;节流 ≥30s/插件、上限 3 次。
// 负对照(已实跑红):teardown 去掉 lastEnsure.delete → 「禁用后再启用、setup 不再 ensure → 旧规则集不重放」红;
// 去掉节流 → 「30s 内第二个边沿不重放」红;去掉上限 → 「最多 3 次」红;去掉 pending 闸 → 「在飞不叠加」红。
// (replayFailedEnsures 里再判 activeIds 是测不出来的死代码 —— 去掉它全绿,所以没写。)
describe('宿主重放 ensure', () => {
  const T0 = new Date(2026, 8, 2, 9, 0, 0)

  it('上次失败(后端未就绪)→ 就绪边沿重放一次,规则原样、cfg 取重放时的;成功后再来边沿不重发', async () => {
    const { st, fireReady } = readyProbe()
    const ctx = ctxOf('pc-erp')
    // waitBackend 直接给 null(相当于 60s 超时)
    const r = await ctx.automation!.ensure([rule()])
    expect(r.ok).toBe(false)
    expect(calls.save).toHaveLength(0)
    expect(st.subs).toBe(1)
    st.backendOk = true
    fireReady()
    await vi.waitFor(() => expect(calls.save).toHaveLength(1))
    expect(calls.save[0]).toMatchObject({ id: 'plugin:pc-erp:out-added', vault: '/v', enabled: true })
    await new Promise((r) => setTimeout(r, 5))
    fireReady()
    await new Promise((r) => setTimeout(r, 5))
    expect(calls.save).toHaveLength(1) // 已成功的不重发
  })

  it('上次成功 → 边沿不重放;探针没有 subscribeReady(旧宿主 / 台架)→ 没有重放也不崩', async () => {
    const { st, fireReady } = readyProbe()
    st.backendOk = true
    const ctx = ctxOf('pc-erp')
    expect(await ctx.automation!.ensure([rule()])).toEqual({ ok: true, errors: [] })
    fireReady()
    await new Promise((r) => setTimeout(r, 5))
    expect(calls.save).toHaveLength(1)
    setTanguProbe(probe(async () => null))
    const c2 = ctxOf('pc-erp2')
    expect((await c2.automation!.ensure([rule()])).ok).toBe(false)
    expect(calls.save).toHaveLength(1)
  })

  it('禁用即删记录:禁用后再启用、setup 这次不再 ensure(如插件升级去掉了规则)→ 边沿不把旧规则集发出去', async () => {
    const { st, fireReady } = readyProbe()
    let first = true
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    usePluginStore.getState().init([{ id: 'pc-erp', name: 'pc-erp', version: '0', setup: (c) => {
      if (first) { first = false; void c.automation!.ensure([rule()]) }
    } }])
    await new Promise((r) => setTimeout(r, 5)) // 首次 ensure 失败(后端未就绪)已记录
    usePluginStore.getState().disable('pc-erp')
    usePluginStore.getState().enable('pc-erp') // 这次 setup 不 ensure
    st.backendOk = true
    fireReady()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.save.filter((u) => u.enabled)).toHaveLength(0)
  })

  it('节流:同插件两次重放至少隔 30s;上限 3 次;单条 HTTP 失败也算失败会重放', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const { st, fireReady } = readyProbe()
    st.backendOk = true
    calls.failIds.add('plugin:pc-erp:out-added')
    const { saveMuseTrigger } = await import('../../services/backendService')
    vi.mocked(saveMuseTrigger).mockClear() // 失败的 upsert 不进 calls.save,按 mock 调用次数数(跨用例累计,先清)
    const attempts = (): number => vi.mocked(saveMuseTrigger).mock.calls.length
    const ctx = ctxOf('pc-erp')
    const r = await ctx.automation!.ensure([rule()])
    expect(r.ok).toBe(false)
    expect(attempts()).toBe(1)
    fireReady() // 第 1 次重放:离上次重放(从未)不受节流
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    fireReady() // 10s 内第二个边沿 → 节流,不重放
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    fireReady() // 第 2 次
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts()).toBe(3)
    await vi.advanceTimersByTimeAsync(30_000)
    fireReady() // 第 3 次(满)
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts()).toBe(4)
    await vi.advanceTimersByTimeAsync(30_000)
    fireReady() // 第 4 次:上限,不重放
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts()).toBe(4)
    // 插件自己再调 ensure → 计数归零,之后又能重放
    await ctx.automation!.ensure([rule()])
    expect(attempts()).toBe(5)
    await vi.advanceTimersByTimeAsync(30_000)
    fireReady()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts()).toBe(6)
  })

  it('原始 ensure 还在等库(在飞)时来了边沿 → 不叠加一次;探针换了会退掉旧订阅重挂', async () => {
    vi.useFakeTimers()
    const { st, fireReady } = readyProbe()
    st.backendOk = true
    usePageStore.setState({ vaultRoot: null })
    const ctx = ctxOf('pc-erp')
    const p = ctx.automation!.ensure([rule()])
    await vi.advanceTimersByTimeAsync(1_000)
    fireReady()
    await vi.advanceTimersByTimeAsync(0)
    usePageStore.setState({ vaultRoot: '/late' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ ok: true, errors: [] })
    expect(calls.save).toHaveLength(1)
    // 探针换了(重装配):旧订阅退掉、新探针挂上
    const second = readyProbe()
    second.st.backendOk = false
    const c2 = ctxOf('pc-erp')
    expect((await c2.automation!.ensure([rule()])).ok).toBe(false)
    expect(st.offs).toBe(1)
    expect(second.st.subs).toBe(1)
  })
})

// ── 禁用的欠账与串行(2026-09-02,codex 二轮 high):后端不在时 disablePluginRules 原来直接 return,
//    规则在引擎里仍是 enabled —— 后端一恢复照跑数据库动作,而 UI 上插件早已禁用。
// 负对照(已实跑红):
//  · onBackendReadyEdge 去掉 replayPendingDisables → 「就绪边沿发出 enabled:false」红(save 恒 0);
//  · enable() 去掉 pendingDisable.delete → 「重新启用作废」红(边沿把刚开的插件的规则关了);
//  · disablePluginRules 去掉 serialByPlugin(直接跑函数体)→ 「ensure 发到一半禁用」红(名册里还没有那两条,零停用);
//  · 串行段里去掉 activeIds 复查 → 「排队期间又启用」红(把用户刚开的插件的规则关了)。
describe('禁用规则的墓碑 / 就绪边沿重放 / 与 ensure 串行', () => {
  const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))
  /** 引擎名册按「已发生的 save」派生 —— 静态 list 量不出「下发」与「停用」的先后。 */
  const derivedList = (): MuseTriggerInfo[] => {
    const last = new Map<string, MuseTriggerUpsert>()
    for (const u of calls.save) last.set(String(u.id), u)
    return [...last.values()].map((u) => tr(String(u.id), u.enabled !== false))
  }
  const lastSaveOf = (id: string): MuseTriggerUpsert | undefined => calls.save.filter((u) => u.id === id).at(-1)

  it('后端不在 → 落墓碑、零下发;就绪边沿真的发出 enabled:false,成功后墓碑消失', async () => {
    const { st, fireReady } = readyProbe()
    calls.list = [tr('plugin:pc-erp:a', true), tr('w-user1', true)]
    ctxOf('pc-erp')
    usePluginStore.getState().disable('pc-erp')
    await vi.waitFor(() => expect(getPluginDisableState('pc-erp')?.pending).toBe(false))
    expect(calls.save).toHaveLength(0)
    expect(getPluginDisableState('pc-erp')!.errors.join('|')).toMatch(/未就绪/)
    st.backendOk = true
    fireReady()
    await vi.waitFor(() => expect(calls.save).toHaveLength(1))
    expect(calls.save[0]).toMatchObject({ id: 'plugin:pc-erp:a', enabled: false })
    expect(getPluginDisableState('pc-erp')).toBeNull() // 关成了 = 没有欠账
  })

  it('墓碑挂着时用户又把插件启用了 → 墓碑作废,后续边沿不再去关它的规则', async () => {
    const { st, fireReady } = readyProbe()
    calls.list = [tr('plugin:pc-erp:a', true)]
    ctxOf('pc-erp')
    usePluginStore.getState().disable('pc-erp')
    await vi.waitFor(() => expect(getPluginDisableState('pc-erp')?.pending).toBe(false))
    usePluginStore.getState().enable('pc-erp')
    expect(getPluginDisableState('pc-erp')).toBeNull()
    st.backendOk = true
    fireReady()
    await tick(10)
    expect(calls.save).toHaveLength(0)
  })

  it('ensure 正发到一半时用户禁用 → disable 排在下发之后,两条规则最终都是停用的', async () => {
    setTanguProbe(probe(async () => CFG))
    calls.listOf = derivedList
    let release = (): void => {}
    calls.hold = new Promise<void>((r) => { release = r })
    const ctx = ctxOf('pc-erp')
    const p = ctx.automation!.ensure([rule({ key: 'a' }), rule({ key: 'b' })])
    await tick()
    expect(calls.save).toHaveLength(0) // 第一笔 upsert 挂住了 = ensure 正发到一半
    usePluginStore.getState().disable('pc-erp')
    await tick()
    release()
    expect((await p).ok).toBe(true)
    await vi.waitFor(() => expect(calls.save.filter((u) => u.enabled === false)).toHaveLength(2))
    expect(lastSaveOf('plugin:pc-erp:a')!.enabled).toBe(false)
    expect(lastSaveOf('plugin:pc-erp:b')!.enabled).toBe(false)
    expect(getPluginDisableState('pc-erp')).toBeNull()
  })

  it('禁用排队期间用户又启用了 → 串行段里复查活性,不关用户刚开的插件的规则', async () => {
    setTanguProbe(probe(async () => CFG))
    calls.listOf = derivedList
    let release = (): void => {}
    calls.hold = new Promise<void>((r) => { release = r })
    const ctx = ctxOf('pc-erp')
    const p = ctx.automation!.ensure([rule({ key: 'a' })])
    await tick()
    usePluginStore.getState().disable('pc-erp')
    await tick()
    usePluginStore.getState().enable('pc-erp')
    release()
    await p
    await tick(10)
    expect(calls.save.filter((u) => u.enabled === false)).toHaveLength(0)
    expect(lastSaveOf('plugin:pc-erp:a')!.enabled).toBe(true)
  })

  // 停用与 ensure 的不对称:ensure 重放放弃了最坏是「规则没登上」,停用放弃了是「用户以为停了、引擎里照跑」。
  // 负对照:把 replayPendingDisables 的条件改回 `st.replays >= ENSURE_REPLAY_MAX || …` → 本条红(第 4 次边沿不再重试)。
  it('停用重放不封顶:连失败 4 次后,后端好了那次边沿仍然把规则关掉', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 2, 9, 0, 0))
    const { st, fireReady } = readyProbe() // backendOk = false
    calls.list = [tr('plugin:pc-erp:a', true)]
    ctxOf('pc-erp')
    usePluginStore.getState().disable('pc-erp')
    await vi.advanceTimersByTimeAsync(60_000) // waitBackend 等满 → 落墓碑
    expect(getPluginDisableState('pc-erp')?.pending).toBe(false)
    for (let i = 0; i < 4; i++) { // 四次边沿,后端始终不在 → 四次都失败(ensure 的上限是 3)
      fireReady()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls.save).toHaveLength(0)
    }
    expect(getPluginDisableState('pc-erp')!.replays).toBeGreaterThanOrEqual(4)
    st.backendOk = true
    await vi.advanceTimersByTimeAsync(30_000) // 过节流
    fireReady()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.save).toHaveLength(1)
    expect(calls.save[0]).toMatchObject({ id: 'plugin:pc-erp:a', enabled: false })
    expect(getPluginDisableState('pc-erp')).toBeNull()
  })
})
