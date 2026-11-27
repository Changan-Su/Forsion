// ctx.app.pickFolder / ctx.app.vaults(2026-11-27,只桌面):pluginStore 这一层。
// 钉五件事:①桥缺席(web / 手机 / 旧宿主)方法整个不存在;②停用后(含对话框开着时停用)reject plugin-disposed;
// ③vaults 读失败 ≠ 空:桥 reject 原样 reject、回的不是数组也 reject,绝不兜成 [];④pickFolder 取消回 null;
// ⑤pickFolder 走无副作用的那条桥,从不碰 pickDirectory(后者带 purpose:'project' 时会登记本机项目根),插件塞的 purpose 也不透传。
// api.ts 在模块加载时就把 window.amadeus 抓成常量,所以 amadeus 用 mock 模块(同 appTrash.test.ts);window.tangu 走 stubGlobal。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge: { current: Record<string, unknown> | undefined } = { current: undefined }
vi.mock('../api', () => ({
  get amadeus() {
    return bridge.current
  },
}))

const { usePluginStore } = await import('./pluginStore')
type Ctx = import('./types').PluginContext

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

beforeEach(() => {
  bridge.current = undefined
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('ctx.app.pickFolder', () => {
  it('桥缺席:方法整个不存在(有 pickDirectory 也不算)', () => {
    vi.stubGlobal('window', { tangu: {} })
    expect(ctxOf('pf-none').app.pickFolder).toBeUndefined()
    vi.stubGlobal('window', { tangu: { pickDirectory: vi.fn() } })
    expect(ctxOf('pf-old').app.pickFolder).toBeUndefined()
  })

  it('回绝对路径;取消回 null', async () => {
    const pickFolder = vi.fn().mockResolvedValueOnce('/Users/x/Backups').mockResolvedValueOnce(null)
    vi.stubGlobal('window', { tangu: { pickFolder } })
    const ctx = ctxOf('pf-ok')
    await expect(ctx.app.pickFolder!({ title: 'Back up to', defaultPath: '/Users/x' })).resolves.toBe('/Users/x/Backups')
    expect(pickFolder).toHaveBeenLastCalledWith({ title: 'Back up to', defaultPath: '/Users/x' })
    await expect(ctx.app.pickFolder!()).resolves.toBeNull()
  })

  it('⚠️不触发项目根登记:只走 pickFolder 桥,不碰 pickDirectory,插件塞的 purpose 等别的键丢掉', async () => {
    const pickFolder = vi.fn(async () => '/Users/x/Backups')
    const pickDirectory = vi.fn(async () => '/should/not/be/used')
    vi.stubGlobal('window', { tangu: { pickFolder, pickDirectory } })
    const ctx = ctxOf('pf-noreg')
    await ctx.app.pickFolder!({ title: 'T', purpose: 'project', properties: ['openFile'] } as never)
    expect(pickDirectory).not.toHaveBeenCalled()
    expect(pickFolder).toHaveBeenCalledWith({ title: 'T' })
  })

  it('停用后 reject plugin-disposed;对话框开着时被停用:当场 reject,之后选了也不交给插件', async () => {
    const d = deferred<string | null>()
    const pickFolder = vi.fn(() => d.promise)
    vi.stubGlobal('window', { tangu: { pickFolder } })
    const ctx = ctxOf('pf-off')
    const pending = ctx.app.pickFolder!()
    usePluginStore.getState().disable('pf-off')
    await expect(pending).rejects.toThrow('plugin-disposed') // 不等对话框关
    d.resolve('/Users/x/Backups')
    await expect(ctx.app.pickFolder!()).rejects.toThrow('plugin-disposed')
    expect(pickFolder).toHaveBeenCalledTimes(1)
  })
})

describe('ctx.app.vaults', () => {
  beforeEach(() => { vi.stubGlobal('window', { tangu: {} }) })

  it('桥缺席:方法整个不存在(只有菜单那条 listVaults 也不算)', () => {
    expect(ctxOf('v-none').app.vaults).toBeUndefined()
    bridge.current = { listVaults: vi.fn() }
    expect(ctxOf('v-old').app.vaults).toBeUndefined()
  })

  it('只映射 root / name / current / cloud 四个字段', async () => {
    bridge.current = {
      pluginVaults: vi.fn(async () => [
        { root: '/Users/x/Notes', name: 'Notes', current: true, cloud: false, display: '~/Notes', sync: true },
        { root: '/Users/x/.forsion/Amadeus Accounts/abc/Cloud', name: 'Cloud', current: false, cloud: true },
      ]),
    }
    await expect(ctxOf('v-ok').app.vaults!()).resolves.toEqual([
      { root: '/Users/x/Notes', name: 'Notes', current: true, cloud: false },
      { root: '/Users/x/.forsion/Amadeus Accounts/abc/Cloud', name: 'Cloud', current: false, cloud: true },
    ])
  })

  it('真的没有库 → []', async () => {
    bridge.current = { pluginVaults: vi.fn(async () => []) }
    await expect(ctxOf('v-empty').app.vaults!()).resolves.toEqual([])
  })

  it('⚠️读失败 ≠ 空:桥 reject 原样 reject;回的不是数组也 reject', async () => {
    bridge.current = { pluginVaults: vi.fn(async () => { throw new Error('amadeus-config-unreadable') }) }
    await expect(ctxOf('v-fail').app.vaults!()).rejects.toThrow('amadeus-config-unreadable')
    for (const bad of [undefined, null, { vaults: [] }, 'x']) {
      bridge.current = { pluginVaults: vi.fn(async () => bad) }
      await expect(ctxOf('v-bad').app.vaults!()).rejects.toThrow('vault-list-unavailable')
    }
  })

  it('停用后 reject plugin-disposed;请求在途时停用当场 reject,晚到的报错也不交给插件', async () => {
    const d = deferred<unknown>()
    const pluginVaults = vi.fn(() => d.promise)
    bridge.current = { pluginVaults }
    const ctx = ctxOf('v-off')
    const pending = ctx.app.vaults!()
    usePluginStore.getState().disable('v-off')
    await expect(pending).rejects.toThrow('plugin-disposed')
    d.reject(new Error('amadeus-config-unreadable')) // 晚到的 IPC 报错被丢掉,不会变成未处理的拒绝
    await expect(ctx.app.vaults!()).rejects.toThrow('plugin-disposed')
    expect(pluginVaults).toHaveBeenCalledTimes(1)
  })
})
