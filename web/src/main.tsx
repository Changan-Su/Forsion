/**
 * Tangu Web 入口:先装垫片(设 window.tangu)+ 同步挂 Amadeus 云端桥(设 window.amadeus),
 * 再复用 desktop 的启动(主题/i18n/引擎/Root)。用动态 import 保证「垫片/桥 先于 desktop
 * 主模块求值」——静态 import 会被提升到 body 之前执行,而 amadeus/api.ts 在模块求值时就捕获
 * window.amadeus,dbStore/noteViewStore 也在模块级判断 window.amadeus 并订阅事件。
 */
import { getApiBase, getToken, installWebShim, redirectToLogin, requireLoginForPage } from './webShim'
import { createCloudAmadeusBridge, setCloudNotify } from './amadeus/cloudBridge'
import { installCloudCollab } from './amadeus/cloudCollab'
import { showUnitBootError } from './unitBootError'
import { unitProjectionRoute } from './unitProjectionRoute'
import type { UnitCloudCapabilities } from './unitCloudTransport'

const wireToast = (): Promise<void> => import('@/stores/appStore').then(({ useApp }) => {
  setCloudNotify((text, isError) => useApp.getState().toast(text, isError))
})

async function bootstrap(): Promise<void> {
  const path = location.pathname

  if ((window as unknown as { __FORSION_UNIT_PAGE__?: unknown }).__FORSION_UNIT_PAGE__) {
    const meta = (window as unknown as { __FORSION_UNIT_PAGE__: {
      instanceId: string; capabilities?: UnitCloudCapabilities; account?: { apiBase: string; loginPath: string }
    } }).__FORSION_UNIT_PAGE__
    const projectionBase = new URL('.', document.baseURI)
    const route = unitProjectionRoute(new URL(location.href), projectionBase)
    if (route && meta.capabilities?.amadeus) {
      const apiBase = new URL(meta.capabilities.amadeus.apiBase, location.origin).href.replace(/\/+$/, '')
      if (route.kind === 'share') {
        const { mountSharePage } = await import('./sharePage')
        mountSharePage(route.token, { apiBase })
      } else {
        if (!meta.account) throw new Error('Invitations require an account provider')
        const { installUnitAccount } = await import('./unitAccount')
        const visitor = await installUnitAccount({ instanceId: meta.instanceId, account: meta.account }, projectionBase)
        if (!visitor.account.getIdentity()) { await visitor.login(); return }
        const { mountInvitePage } = await import('./invitePage')
        mountInvitePage(route.token, { apiBase, getToken: visitor.account.getToken,
          request: visitor.capability.request, appBase: projectionBase.href })
      }
      return
    }
    // Unit 自己装配访客身份与插件能力,必须先于普通 Web 的全局账户路径。
    void import('./unitShim')
      .then(async (m) => {
        if (!(await m.installUnitShim())) return
        // 手机开设备页装 Mobile 壳(与下方 web 主线同一判定:index 内联脚本按视口写 lcl.uiMode,
        // ?ui= 可强制)—— 与移动 App 同源码,小屏体验对齐(2026-08-25 用户拍板);桌面视口照旧。
        let uiMobile = false
        try {
          uiMobile = (new URLSearchParams(location.search).get('ui') || localStorage.getItem('lcl.uiMode')) === 'mobile'
        } catch { /* private mode → 桌面布局 */ }
        await (uiMobile ? import('@mobile/mobileEntry') : import('@/main'))
        if (meta.capabilities?.amadeus) await wireToast()
      })
      .catch((e) => { console.error('[unit-page] bootstrap failed:', e); showUnitBootError() })
  } else if (path.startsWith('/share/')) {
    // P3 公开分享 viewer:无鉴权、不加载主应用(轻量独立页)。
    void import('./sharePage')
      .then((m) => m.mountSharePage(decodeURIComponent(path.slice('/share/'.length)).replace(/\/+$/, '')))
      .catch((e) => console.error('[tangu-web] share page failed:', e))
  } else if (path.startsWith('/invite/')) {
    // P2 邀请接受页:需登录(回跳回本页),不加载主应用。
    if (await requireLoginForPage()) {
      void import('./invitePage')
        .then((m) => m.mountInvitePage(decodeURIComponent(path.slice('/invite/'.length)).replace(/\/+$/, '')))
        .catch((e) => console.error('[tangu-web] invite page failed:', e))
    }
  } else if (await installWebShim()) {
    // 已登录:同步工厂,不发网络请求;首个 Amadeus/Calendar 视图挂载时经 ensureAmadeusReady →
    // restoreVault 才真正连云(GET /vaults → tree → SSE → asset-token)。
    window.amadeus = createCloudAmadeusBridge({
      apiBase: getApiBase(),
      getToken,
      onAuthError: redirectToLogin,
    })
    // P2/P3 协同与分享面(web 专属;共享 UI 据 window.amadeusCollab 解闸)。
    installCloudCollab({ apiBase: getApiBase(), getToken })

    // window.tangu / window.amadeus 就位后再加载启动模块。手机单列(lcl.uiMode=mobile,index.html
    // 内联脚本在模块求值前已写好键)装载 Mobile 壳(@mobile/mobileEntry,与移动 App 同源码 —— 显示
    // 与 Mobile 全量对齐);桌面视口照旧走 desktop 启动(@ → ../desktop/frontend/src)。
    let uiMobile = false
    try {
      uiMobile = (new URLSearchParams(location.search).get('ui') || localStorage.getItem('lcl.uiMode')) === 'mobile'
    } catch { /* private mode → 桌面布局 */ }
    void (uiMobile ? import('@mobile/mobileEntry') : import('@/main'))
      .then(wireToast)
      .catch((e) => console.error('[tangu-web] bootstrap failed:', e))
  }
  // 未登录:installWebShim 已 location.replace 跳登录,不挂载。

}
void bootstrap().catch((error) => {
  console.error('[tangu-web] Account bootstrap failed:', error)
  if ((window as unknown as { __FORSION_UNIT_PAGE__?: unknown }).__FORSION_UNIT_PAGE__) showUnitBootError()
})
