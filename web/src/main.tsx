/**
 * Tangu Web 入口:先装垫片(设 window.tangu)+ 同步挂 Amadeus 云端桥(设 window.amadeus),
 * 再复用 desktop 的启动(主题/i18n/引擎/Root)。用动态 import 保证「垫片/桥 先于 desktop
 * 主模块求值」——静态 import 会被提升到 body 之前执行,而 amadeus/api.ts 在模块求值时就捕获
 * window.amadeus,dbStore/noteViewStore 也在模块级判断 window.amadeus 并订阅事件。
 */
import { getApiBase, getToken, installWebShim, redirectToLogin } from './webShim'
import { createCloudAmadeusBridge, setCloudNotify } from './amadeus/cloudBridge'

if (installWebShim()) {
  // 已登录:同步工厂,不发网络请求;首个 Amadeus/Calendar 视图挂载时经 ensureAmadeusReady →
  // restoreVault 才真正连云(GET /vaults → tree → SSE → asset-token)。
  window.amadeus = createCloudAmadeusBridge({
    apiBase: getApiBase(),
    getToken,
    onAuthError: redirectToLogin,
  })

  // window.tangu / window.amadeus 就位后再加载桌面端启动模块(@ → ../desktop/frontend/src)。
  void import('@/main')
    .then(() => import('@/stores/appStore'))
    .then(({ useApp }) => {
      // 云端桥的提示(保存冲突/仅桌面可用…)接到应用 toast。
      setCloudNotify((text, isError) => useApp.getState().toast(text, isError))
    })
    .catch((e) => console.error('[tangu-web] bootstrap failed:', e))
}
// 未登录:installWebShim 已 location.replace 跳登录,不挂载。
