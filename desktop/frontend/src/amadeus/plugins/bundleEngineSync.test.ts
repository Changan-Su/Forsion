// 捆绑包内嵌引擎插件跟父插件走(2026-09-25 补关 → 10-02 推广成对齐,只主窗写引擎):前置插件来来去去时依赖方的半身
// 也得跟上 —— 靠 syncBundleEngines 在每次对齐之后 / 就绪边沿补。
// 契约:用户关了 / 在等前置 → 关掉仍开着的并记欠账;父插件在跑 → **只**补开欠账里的(用户在 TUI 关掉的不翻回来,
// Codex 10-02);用户明确打开捆绑包(本窗 enable 或别的窗口的开启戳)= 欠账,开启戳还清掉本窗记着的失败;
// 门禁挡着 / 失败 / 还没装载完 → 不动;跳过用户目录同 id 与首方内置;设备页不动对端引擎;后端没就绪 → 边沿重试;
// 按插件串行链、链内现读期望与名单;失败 30s 后补,每次触发各自持有重试。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { MuseTriggerInfo, TanguDesktopConfig } from '../../types'

const calls = {
  puts: [] as Array<[string, boolean]>, lists: 0, engine: [] as Array<{ id: string; enabled: boolean; source: string }>,
  onList: null as null | (() => void), failPuts: 0, hold: null as null | Promise<void>, holding: false,
  rules: [] as MuseTriggerInfo[], ruleSaves: [] as Array<[string, boolean]>,
}
vi.mock('../../services/backendService', () => ({
  listPlugins: vi.fn(async () => { calls.lists += 1; calls.onList?.(); return calls.engine }),
  setPluginEnabled: vi.fn(async (_cfg: unknown, id: string, enabled: boolean) => {
    if (calls.failPuts > 0) { calls.failPuts -= 1; throw new Error('HTTP 503') }
    if (calls.hold) { const h = calls.hold; calls.hold = null; calls.holding = true; await h }
    calls.puts.push([id, enabled])
    return { ok: true, enabled }
  }),
  getMuseTriggers: vi.fn(async () => calls.rules),
  saveMuseTrigger: vi.fn(async (_cfg: unknown, t: { id: string; enabled: boolean }) => { calls.ruleSaves.push([t.id, t.enabled]); return t }),
}))

const { usePluginStore, syncBundleEngines, serialBundleEngines, applyPluginEnableStamp } = await import('./pluginStore')
const { setTanguProbe } = await import('./tanguSeam')

const CFG: TanguDesktopConfig = { backendUrl: 'http://t', token: 'tok', modelId: '' }
let ready: TanguDesktopConfig | null = CFG
let readyCb: (() => void) | null = null
const probe = () => ({
  activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {},
  waitBackend: async () => ready,
  subscribeReady: (cb: () => void) => { readyCb = cb; return () => { readyCb = null } },
})
const bundle = (id: string, enginePlugins: string[]) => ({ id, name: id, version: '0', bundle: { enginePlugins, agents: [], skills: [], spaces: [] } })
const engine = (id: string, enabled: boolean, source = 'folder') => ({ id, enabled, source })
const g = globalThis as unknown as { window?: unknown; localStorage?: unknown }
const mem = new Map<string, string>() // node 环境没有 localStorage:欠账 / 开关偏好落这里
g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) }
const owed = (): string[] => JSON.parse(mem.get('amadeus.plugins.bundleEngineOwed') ?? '[]')

beforeEach(() => {
  mem.clear()
  usePluginStore.setState({ activeIds: [], lastSetupError: {} })
  calls.puts = []
  calls.lists = 0
  calls.onList = null
  calls.failPuts = 0
  calls.hold = null
  calls.holding = false
  calls.rules = []
  calls.ruleSaves = []
  ready = CFG
  g.window = {}
  setTanguProbe(probe())
})
afterEach(() => {
  vi.useRealTimers()
  setTanguProbe(null)
  delete g.window
})

describe('syncBundleEngines', () => {
  it('只关「被用户关掉的捆绑包」里仍开着的引擎插件;开着的捆绑包、已关的不动', async () => {
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use']), bundle('on', ['other-tool']), bundle('off', ['already-off'])] as never, disabledIds: ['cu', 'off'] })
    calls.engine = [engine('computer-use', true), engine('other-tool', true), engine('already-off', false)]
    await syncBundleEngines()
    expect(calls.puts).toEqual([['computer-use', false]])
  })

  it('父插件在跑、内嵌引擎插件关着:欠着的补开,不欠的(用户在 TUI 关的)不动;没在跑的(还在装载)不动(Codex 10-02)', async () => {
    usePluginStore.setState({ plugins: [bundle('run', ['t-run', 't-user-off']), bundle('loading', ['t-loading'])] as never, activeIds: ['run'], disabledIds: [] })
    calls.engine = [engine('t-run', false), engine('t-user-off', false), engine('t-loading', false)]
    mem.set('amadeus.plugins.bundleEngineOwed', JSON.stringify(['t-run', 't-loading']))
    await syncBundleEngines()
    expect(calls.puts).toEqual([['t-run', true]])
    expect(owed()).toEqual(['t-loading']) // 还清的划掉;父插件没在跑的留着
  })

  it('用户明确打开捆绑包 → 记欠账 → 父插件跑起来就补开(引擎那时不在也不丢)', async () => {
    usePluginStore.setState({ plugins: [{ ...bundle('cu', ['computer-use']), setup: () => {} }] as never, activeIds: [], disabledIds: ['cu'], disposers: {} })
    calls.engine = [engine('computer-use', false)]
    ready = null // 引擎还没就绪:这一下什么都写不了
    usePluginStore.getState().enable('cu')
    expect(owed()).toEqual(['computer-use'])
    ready = CFG
    await syncBundleEngines()
    expect(calls.puts).toEqual([['computer-use', true]])
    expect(owed()).toEqual([])
  })

  it('别的窗口的开启戳:清掉本窗记着的失败、重试,主窗记欠账(Codex 10-02)', async () => {
    let tries = 0
    usePluginStore.setState({
      plugins: [{ ...bundle('cu', ['computer-use']), setup: () => { tries += 1 } }] as never,
      activeIds: [], disabledIds: [], disposers: {}, lastSetupError: { cu: 'boom' },
    })
    applyPluginEnableStamp(JSON.stringify({ id: 'cu', t: 1 }))
    expect([usePluginStore.getState().lastSetupError.cu, tries, usePluginStore.getState().activeIds]).toEqual([undefined, 1, ['cu']])
    expect(owed()).toEqual(['computer-use'])
  })

  it('父插件想开但前置没齐(暂停中)→ 内嵌引擎插件一并关;前置在跑 → 开(负对照)', async () => {
    const dep = { ...bundle('needs', ['t-needs']), requiresPlugins: [{ id: 'base' }] }
    usePluginStore.setState({ plugins: [dep, { id: 'base', name: 'base', version: '1' }] as never, activeIds: [], disabledIds: ['base'] })
    calls.engine = [engine('t-needs', true)]
    await syncBundleEngines()
    expect(calls.puts).toEqual([['t-needs', false]])
    calls.puts = []
    calls.engine = [engine('t-needs', false)]
    usePluginStore.setState({ activeIds: ['base', 'needs'], disabledIds: [] })
    await syncBundleEngines()
    expect(calls.puts).toEqual([['t-needs', true]])
  })

  it('用户目录同 id 覆盖、首方内置同 id 不归捆绑包管', async () => {
    g.window = { tangu: { pluginsUserInstalled: async () => [{ id: 'user-copy' }] } }
    usePluginStore.setState({ plugins: [bundle('b', ['user-copy', 'core-tool', 'x'])] as never, disabledIds: ['b'] })
    calls.engine = [engine('user-copy', true), engine('core-tool', true, 'builtin'), engine('x', true)]
    await syncBundleEngines()
    expect(calls.puts).toEqual([['x', false]])
  })

  it('设备页不碰对端引擎:连名单都不拉', async () => {
    g.window = { tangu: { unitPage: true } }
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    await syncBundleEngines()
    expect([calls.lists, calls.puts]).toEqual([0, []])
  })

  it('后端没就绪 → 这次什么都不做;就绪边沿来了补关', async () => {
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    ready = null
    await syncBundleEngines()
    expect(calls.puts).toEqual([])
    ready = CFG
    readyCb!()
    await vi.waitFor(() => expect(calls.puts).toEqual([['computer-use', false]]))
  })

  it('等名单期间用户又打开了捆绑包 → 不写 false(级联刚写的 true 不能被旧快照盖回)', async () => {
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    calls.onList = () => usePluginStore.setState({ disabledIds: [] })
    await syncBundleEngines()
    expect(calls.puts).toEqual([])
  })

  it('暂停→恢复连着来、暂停那次的 PUT 还在飞 → 恢复那次按落定后的名单比,最终是开的(Codex 10-02)', async () => {
    const dep = { ...bundle('needs', ['t-needs']), requiresPlugins: [{ id: 'base' }] }
    usePluginStore.setState({ plugins: [dep, { id: 'base', name: 'base', version: '1' }] as never, activeIds: [], disabledIds: ['base'] })
    calls.onList = () => { const last = calls.puts.at(-1); calls.engine = [engine('t-needs', last ? last[1] : true)] } // 名单 = 已落定的 PUT
    let release!: () => void
    calls.hold = new Promise<void>((r) => { release = r })
    const paused = syncBundleEngines()
    await vi.waitFor(() => expect(calls.holding).toBe(true))
    usePluginStore.setState({ activeIds: ['base', 'needs'], disabledIds: [] }) // 前置回来,父插件恢复
    const resumed = syncBundleEngines()
    await new Promise((r) => setTimeout(r, 0)) // 让恢复那次走到排队点(旧实现在这之前就拉了名单)
    release()
    await Promise.all([paused, resumed])
    expect(calls.puts).toEqual([['t-needs', false], ['t-needs', true]])
  })

  it('PUT 失败 → 30s 后补一次(后端一直就绪就没有边沿来救)', async () => {
    vi.useFakeTimers()
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    calls.failPuts = 1
    await syncBundleEngines()
    expect(calls.puts).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(calls.puts).toEqual([['computer-use', false]]))
  })

  it('补关的 PUT 在飞时用户重新打开 → 级联排在它后面(同一条链),最终是开的', async () => {
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    let release!: () => void
    calls.hold = new Promise<void>((r) => { release = r })
    const sync = syncBundleEngines()
    await vi.waitFor(() => expect(calls.holding).toBe(true))
    const cascade = serialBundleEngines('cu', async () => { calls.puts.push(['computer-use', true]) }) // 级联的 true
    release()
    await Promise.all([sync, cascade])
    expect(calls.puts).toEqual([['computer-use', false], ['computer-use', true]])
  })

  it('一次触发把重试额度用完,不挡之后新触发的重试', async () => {
    vi.useFakeTimers()
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    calls.failPuts = 4 // 首发 + 3 次重试全失败
    await syncBundleEngines()
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(30_000)
    expect([calls.failPuts, calls.puts]).toEqual([0, []])
    calls.failPuts = 1 // 新的一次触发(如就绪边沿):首发失败,仍该补
    await syncBundleEngines()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(calls.puts).toEqual([['computer-use', false]]))
  })

  it('两次触发交叠、首发都失败 → 各自补一次(不共用一个定时器)', async () => {
    vi.useFakeTimers()
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    calls.failPuts = 2
    await syncBundleEngines()
    await syncBundleEngines()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(calls.puts).toEqual([['computer-use', false], ['computer-use', false]]))
  })

  it('引擎链卡住不挡 Muse 规则停用(两条链分开)', async () => {
    delete g.window // 走真实的 disable():它在 node 环境里本就不碰 window
    calls.rules = [{
      id: 'plugin:stuck:a', desc: 'a', enabled: true, cooldownHours: 0, lastFiredAt: null, createdAt: '',
      cond: { type: 'db_changed', path: 'a.db', vault: '/v', event: 'row_added' }, actions: [{ type: 'notify', title: 't' }],
    } as MuseTriggerInfo]
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    usePluginStore.getState().init([{ id: 'stuck', name: 'stuck', version: '0', setup: () => {} }])
    void serialBundleEngines('stuck', () => new Promise<void>(() => {})) // 引擎 PUT 永远不回
    usePluginStore.getState().disable('stuck')
    await vi.waitFor(() => expect(calls.ruleSaves).toEqual([['plugin:stuck:a', false]]))
  })
})
