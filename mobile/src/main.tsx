/**
 * Tangu Mobile 入口:先装垫片(异步:native 读 Preferences token / web 读 localStorage),就绪后再
 * 动态 import 移动启动模块。动态 import 保证「垫片先于渲染层求值」。
 * 注意:不 import '@/main'(那是 desktop 的 Dockview 外壳启动);移动端走自己的 mobileEntry。
 *
 * Amadeus 桥按持久化模式二选一(本地 Capacitor vault / 云端 vault 直连,后者复用 web 的
 * cloudBridge 全管道:SSE 实时/回收站/白板合并/presence)。
 *
 * `window.amadeus` 是一个**恒定的转发壳**(Proxy → 当前 impl):渲染层的 amadeus/api.ts 在模块求值时
 * 就把它捕获走了,换实现只换壳里的那一层,捕获到的引用照样指向新桥。切库因此不再需要 location.reload()
 * (旧做法整页重刷:白屏一瞬 + 引擎重连 + 丢当前 tab/滚动位置)。
 * 切换 = 旧桥落盘 → 换 impl → 作废各面板编辑器状态 → restoreVault() 重拉新库(与桌面 switchVaultSide 同构)。
 */
import { installMobileShim } from './mobileShim'
import { createMobileAmadeusBridge } from './amadeus/mobileAmadeusBridge'
import { createCloudAmadeusBridge, setCloudNotify } from '@webamadeus/cloudBridge'
import { installCloudCollab } from '@webamadeus/cloudCollab'
import { cloudApiBaseOf } from '@/services/engine/cloudBase'
import { installMobilePlugins } from './plugins/installMobilePlugins'

const VAULT_MODE_KEY = 'amadeus_vault_mode' // 'cloud'(缺省,移动端主打云客户端) | 'local'(显式选过才本地)
const vaultMode = (): 'local' | 'cloud' => {
  try {
    return localStorage.getItem(VAULT_MODE_KEY) === 'local' ? 'local' : 'cloud'
  } catch {
    return 'cloud'
  }
}

void installMobileShim().then(async (ok) => {
  if (!ok) return // 未就绪:已发起登录(native 开系统浏览器 / web 跳 /auth),不挂载。
  const cfg = await (window as unknown as {
    tangu: { getConfig(): Promise<{ backendUrl: string; token: string; cloudApiBase?: string; cloudUrl?: string }> }
  }).tangu.getConfig()
  const getToken = (): string => cfg.token
  // Amadeus 云桥 / 协作打的是**云端 API**,不是引擎:读 cloudApiBase(P1-K6 S1)。今天两者同值,
  // 手机把引擎切到「我的电脑」后 backendUrl 就变成隧道地址了,云桥不能跟着走。
  const cloudApi = cloudApiBaseOf(cfg)

  type Bridge = Record<string, unknown>
  const makeBridge = (side: 'local' | 'cloud'): Bridge =>
    side === 'cloud'
      ? (createCloudAmadeusBridge({
          apiBase: cloudApi,
          getToken,
          onAuthError: () => {
            void (window as unknown as { tangu?: { forsionLogout?: () => Promise<void> } }).tangu?.forsionLogout?.()
          },
        }) as unknown as Bridge)
      : // 本地 Capacitor vault;cfg 供 fetchLinkMeta(书签卡 server 代理)/searchImages。
        (createMobileAmadeusBridge({ apiBase: () => cloudApi, getToken }) as unknown as Bridge)

  // Forsion 插件宿主 + 应用市场(2026-10-02):插件住在应用私有目录、不属于任何库 —— 叠在下面的转发壳上,
  // 云端库 / 本地库两种模式(以及切库之后)同一份,不往两座库桥里各抄一遍。市场桥挂到 window.tangu,
  // 必须早于 import('./mobileEntry')(bootstrapEngine 按 window.tangu?.marketList 注册入口)。
  const plugins = installMobilePlugins({ cloudApiBase: () => cloudApi })
  const pluginHost: Record<string, unknown> = {
    listPlugins: plugins.host.listPlugins,
    uninstallPlugin: plugins.host.uninstallPlugin,
    readPluginData: plugins.host.readPluginData,
    writePluginData: plugins.host.writePluginData,
  }

  let side = vaultMode()
  let impl = makeBridge(side)
  window.tangu?.onAuthChanged?.(() => {
    // The bridge and collaboration callbacks close over cfg; revoke that credential immediately.
    cfg.token = ''
    window.amadeusCollab?.stopHeartbeat?.()
    if (side !== 'cloud') return
    impl = makeBridge('cloud')
    void import('@/amadeus/store/pageStore').then((ps) => {
      ps.resetAllScopeDocs()
      ps.usePageStore.setState({ vaultRoot: null, pages: [], folders: [], files: [], icons: {} })
    })
  })
  // 恒定壳:`in` 也要转发 —— 渲染层多处用 `'x' in window.amadeus` 探能力(云/本地两桥方法集不同)。
  // 插件宿主四件(pluginHost)压在库桥之上;hostCaps 是**合并**不是替换:库桥自己的 revealInFileManager:false 等
  // 必须保留,只叠一条 pluginsFolder:false(插件页不渲染「打开插件文件夹 / 创建示例插件」)。
  // 自有键判断(别用 `in`:pluginHost 是普通对象,'toString' / 'constructor' 也会命中原型链)
  const hostKey = (k: string | symbol): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(pluginHost, k)
  const view = (k: string | symbol): unknown => {
    if (hostKey(k)) return pluginHost[k as string]
    if (k === 'hostCaps') return { ...((impl.hostCaps as Record<string, unknown> | undefined) ?? {}), pluginsFolder: false }
    return impl[k as string]
  }
  const keys = (): Array<string | symbol> => [...new Set([...Reflect.ownKeys(impl), ...Object.keys(pluginHost), 'hostCaps'])]
  ;(window as unknown as { amadeus: unknown }).amadeus = new Proxy({} as Bridge, {
    get: (_t, k) => view(k),
    has: (_t, k) => k === 'hostCaps' || hostKey(k) || k in impl,
    ownKeys: () => keys(),
    // configurable 必须为 true:目标是个空对象,报一个不可配置的属性会被 Proxy 不变式判非法直接抛。
    getOwnPropertyDescriptor: (_t, k) => {
      if (k === 'hostCaps' || hostKey(k)) return { value: view(k), writable: true, enumerable: true, configurable: true }
      const d = Reflect.getOwnPropertyDescriptor(impl, k)
      return d ? { ...d, configurable: true } : undefined
    },
  })

  let collabInstalled = false
  const ensureCollab = (): void => {
    if (collabInstalled) return
    collabInstalled = true
    installCloudCollab({ apiBase: cloudApi, getToken })
  }
  if (side === 'cloud') ensureCollab()

  let switching = false
  ;(window as unknown as { amadeusVaultMode?: unknown }).amadeusVaultMode = {
    get side() {
      return side
    },
    async switch(next: 'local' | 'cloud'): Promise<void> {
      if (switching || next === side) return
      switching = true
      try {
        const ps = await import('@/amadeus/store/pageStore')
        // ① 待存内容先在【旧桥】落盘 —— 换完桥再写就是写进另一个库(桌面同款泄漏,见 pageStore 注释)。
        await ps.flushAllScopes()
        impl = makeBridge(next)
        // amadeusCloudVaults 由云桥挂在 window 上(侧栏据它判「这是云端库」并切分同步 Vault 分区)。
        // 切回本地必须撤掉,否则本地树会被当云端树渲染出幽灵分区。切回云端时 makeBridge 会重挂。
        if (next === 'local') delete (window as unknown as { amadeusCloudVaults?: unknown }).amadeusCloudVaults
        side = next
        try {
          localStorage.setItem(VAULT_MODE_KEY, next)
        } catch {
          /* private mode */
        }
        if (next === 'cloud') ensureCollab()
        // ② 各面板编辑器状态作废 + 清掉旧库的树,再重拉新库(restoreVault 两桥都实现)。
        ps.resetAllScopeDocs()
        ps.usePageStore.setState({ vaultSide: next, vaultRoot: null, pages: [], folders: [], files: [], icons: {} })
        await ps.usePageStore.getState().restoreVault()
      } finally {
        switching = false
      }
    },
  }

  await import('./mobileEntry')
  // 云端桥提示(保存冲突/仅桌面可用…)接应用 toast(web main 同款,appStore 到位后)。
  const { useApp } = await import('@/stores/appStore')
  setCloudNotify((text, isError) => useApp.getState().toast(text, isError))
  // 胶囊滑块读 pageStore.vaultSide(与桌面同一个真源),启动时对齐一次。
  const { usePageStore } = await import('@/amadeus/store/pageStore')
  usePageStore.setState({ vaultSide: side })
})
