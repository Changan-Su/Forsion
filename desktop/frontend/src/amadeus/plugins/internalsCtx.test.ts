// ctx.internals 的注入闸与熔断接线(2026-11-16,插件内部接口开放方案 B)。
// 负对照(已实跑红):makeContext 里注入条件去掉 internalsAvailable() → 「不是本机桌面就不给」红;
// setInternalsTrip 的回调里去掉 get().disable(id) → 「熔断停用插件」红。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

let desktop = true
vi.mock('../api', () => ({ get amadeus() { return undefined } }))
// 端判定本身(Electron UA、设备页)在 pluginInternals.test.ts 里测;这里只换掉它,测插件宿主怎么用它
vi.mock('./pluginInternals', async (orig) => ({ ...(await orig<typeof import('./pluginInternals')>()), internalsAvailable: () => desktop }))
vi.mock('../../coreTangu/sharedModules.generated', () => ({ SHARED_MODULES: { 'host:demo.ts': { value: 1 } } }))

const { usePluginStore } = await import('./pluginStore')
const internals = await import('./pluginInternals')
const { useNotifications } = await import('../../stores/notificationStore')
type Ctx = import('./types').PluginContext
type Plugin = import('./types').AmadeusPlugin

function ctxOf(id: string, capabilities?: string[]): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c }, capabilities } as Plugin])
  return ref!
}

beforeEach(() => { desktop = true })
afterEach(() => { vi.restoreAllMocks() })

describe('ctx.internals 的注入闸', () => {
  it('声明了 internals 才有;第二级要一起声明', () => {
    expect(ctxOf('a').internals).toBeUndefined()
    const one = ctxOf('b', ['internals']).internals
    expect(typeof one?.read).toBe('function')
    expect(one?.raw).toBeUndefined()
    expect(typeof ctxOf('c', ['internals', 'internals-raw']).internals?.raw?.import).toBe('function')
    expect(ctxOf('d', ['internals-raw']).internals).toBeUndefined()
  })

  it('不是本机桌面就不给', () => {
    desktop = false
    expect(ctxOf('e', ['internals', 'internals-raw']).internals).toBeUndefined()
  })

  it('能读宿主登记的状态库', () => {
    const k = ctxOf('f', ['internals']).internals!
    expect(k.stores()).toEqual(expect.arrayContaining(['page', 'workspace', 'spaces', 'commands', 'ui']))
    expect(k.read('page')).toBeTypeOf('object')
    expect(k.host.mainWindow).toBe(true)
  })
})

describe('熔断与停用', () => {
  it('当前这一版一分钟内 3 次明确算到它头上的错 → 停用并通知', () => {
    ctxOf('g', ['internals'])
    expect(usePluginStore.getState().activeIds).toContain('g')
    internals.markInternalsLive('g', internals.nextInternalsSourceUrl('g'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) internals.reportInternalsFault('g', new Error(`e${i}`), 1000 + i)
    expect(usePluginStore.getState().activeIds).not.toContain('g')
    expect(usePluginStore.getState().disabledIds).toContain('g')
    expect(useNotifications.getState().items.some((n) => n.dedupeKey === 'internals-fault:g')).toBe(true)
  })

  it('取用过第二级模块的插件停用后提示重载窗口', async () => {
    const k = ctxOf('h', ['internals', 'internals-raw']).internals!
    await k.raw!.import('host:demo.ts')
    usePluginStore.getState().disable('h')
    expect(useNotifications.getState().items.some((n) => n.dedupeKey === 'internals-raw-reload:h')).toBe(true)
  })
})
