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
    tangu: { getConfig(): Promise<{ backendUrl: string; token: string }> }
  }).tangu.getConfig()
  const getToken = (): string => cfg.token

  type Bridge = Record<string, unknown>
  const makeBridge = (side: 'local' | 'cloud'): Bridge =>
    side === 'cloud'
      ? (createCloudAmadeusBridge({
          apiBase: cfg.backendUrl,
          getToken,
          onAuthError: () => {
            void (window as unknown as { tangu?: { forsionLogout?: () => Promise<void> } }).tangu?.forsionLogout?.()
          },
        }) as unknown as Bridge)
      : // 本地 Capacitor vault;cfg 供 fetchLinkMeta(书签卡 server 代理)/searchImages。
        (createMobileAmadeusBridge({ apiBase: () => cfg.backendUrl, getToken }) as unknown as Bridge)

  let side = vaultMode()
  let impl = makeBridge(side)
  // 恒定壳:`in` 也要转发 —— 渲染层多处用 `'x' in window.amadeus` 探能力(云/本地两桥方法集不同)。
  ;(window as unknown as { amadeus: unknown }).amadeus = new Proxy({} as Bridge, {
    get: (_t, k) => impl[k as string],
    has: (_t, k) => k in impl,
    ownKeys: () => Reflect.ownKeys(impl),
    // configurable 必须为 true:目标是个空对象,报一个不可配置的属性会被 Proxy 不变式判非法直接抛。
    getOwnPropertyDescriptor: (_t, k) => {
      const d = Reflect.getOwnPropertyDescriptor(impl, k)
      return d ? { ...d, configurable: true } : undefined
    },
  })

  let collabInstalled = false
  const ensureCollab = (): void => {
    if (collabInstalled) return
    collabInstalled = true
    installCloudCollab({ apiBase: cfg.backendUrl, getToken })
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
