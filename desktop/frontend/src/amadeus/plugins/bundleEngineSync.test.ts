// 用户关掉的捆绑包 ⇒ 内嵌引擎插件补关(2026-09-25):引擎对捆绑包内嵌插件改为缺省启用后,拨开关那一次级联
// 若没发出去(引擎不在),只能靠 syncDisabledBundleEngines 在装载完 / 就绪边沿补。
// 契约:只认 disabledIds;只 PUT 仍开着的;跳过用户目录同 id 与首方内置;设备页不动对端引擎;后端没就绪 → 边沿重试;
// 与级联同一条按插件串行链、链内现读偏好(不拿旧快照盖掉级联刚写的 true);失败 30s 后补,每次触发各自持有重试。
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

const { usePluginStore, syncDisabledBundleEngines, serialBundleEngines } = await import('./pluginStore')
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
const g = globalThis as unknown as { window?: unknown }

beforeEach(() => {
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

describe('syncDisabledBundleEngines', () => {
  it('只关「被用户关掉的捆绑包」里仍开着的引擎插件;开着的捆绑包、已关的不动', async () => {
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use']), bundle('on', ['other-tool']), bundle('off', ['already-off'])] as never, disabledIds: ['cu', 'off'] })
    calls.engine = [engine('computer-use', true), engine('other-tool', true), engine('already-off', false)]
    await syncDisabledBundleEngines()
    expect(calls.puts).toEqual([['computer-use', false]])
  })

  it('用户目录同 id 覆盖、首方内置同 id 不归捆绑包管', async () => {
    g.window = { tangu: { pluginsUserInstalled: async () => [{ id: 'user-copy' }] } }
    usePluginStore.setState({ plugins: [bundle('b', ['user-copy', 'core-tool', 'x'])] as never, disabledIds: ['b'] })
    calls.engine = [engine('user-copy', true), engine('core-tool', true, 'builtin'), engine('x', true)]
    await syncDisabledBundleEngines()
    expect(calls.puts).toEqual([['x', false]])
  })

  it('设备页不碰对端引擎:连名单都不拉', async () => {
    g.window = { tangu: { unitPage: true } }
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    await syncDisabledBundleEngines()
    expect([calls.lists, calls.puts]).toEqual([0, []])
  })

  it('后端没就绪 → 这次什么都不做;就绪边沿来了补关', async () => {
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    ready = null
    await syncDisabledBundleEngines()
    expect(calls.puts).toEqual([])
    ready = CFG
    readyCb!()
    await vi.waitFor(() => expect(calls.puts).toEqual([['computer-use', false]]))
  })

  it('等名单期间用户又打开了捆绑包 → 不写 false(级联刚写的 true 不能被旧快照盖回)', async () => {
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    calls.onList = () => usePluginStore.setState({ disabledIds: [] })
    await syncDisabledBundleEngines()
    expect(calls.puts).toEqual([])
  })

  it('PUT 失败 → 30s 后补一次(后端一直就绪就没有边沿来救)', async () => {
    vi.useFakeTimers()
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    calls.failPuts = 1
    await syncDisabledBundleEngines()
    expect(calls.puts).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(calls.puts).toEqual([['computer-use', false]]))
  })

  it('补关的 PUT 在飞时用户重新打开 → 级联排在它后面(同一条链),最终是开的', async () => {
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    let release!: () => void
    calls.hold = new Promise<void>((r) => { release = r })
    const sync = syncDisabledBundleEngines()
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
    await syncDisabledBundleEngines()
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(30_000)
    expect([calls.failPuts, calls.puts]).toEqual([0, []])
    calls.failPuts = 1 // 新的一次触发(如就绪边沿):首发失败,仍该补
    await syncDisabledBundleEngines()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(calls.puts).toEqual([['computer-use', false]]))
  })

  it('两次触发交叠、首发都失败 → 各自补一次(不共用一个定时器)', async () => {
    vi.useFakeTimers()
    usePluginStore.setState({ plugins: [bundle('cu', ['computer-use'])] as never, disabledIds: ['cu'] })
    calls.engine = [engine('computer-use', true)]
    calls.failPuts = 2
    await syncDisabledBundleEngines()
    await syncDisabledBundleEngines()
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
