/**
 * Tangu Mobile 垫片:把 WebView 伪装成极简「外部后端」host,让复用的 desktop 渲染层零改云连。
 *
 * 两条路(installMobileShim 异步):
 * - **native(Capacitor/Android)**:token 走 @capacitor/preferences 安全存储;无 token → 系统浏览器开
 *   Forsion 登录页,深链 tangu://auth-callback?token=… 回跳(见 capacitorAuth.ts)。API 基址缺省烤入
 *   生产网关(location.origin=https://localhost 不能同源),VITE_API_ORIGIN 覆盖。
 * - **web(dev/preview)**:localStorage token + 同源/代理 /auth 跳转(等价 webShim),便于不出包快速联调。
 *
 * 其余 host 能力(文件系统/providers/mcp/market/更新…)缺省 → 共享组件 `window.tangu?.X` 可选链自然隐藏。
 */
import { Browser } from '@capacitor/browser'
import { InAppBrowser, ToolbarPosition, iOSViewStyle, iOSAnimation } from '@capacitor/inappbrowser'
import { translate } from '@/i18n'
import { isNative, apiBase, forsionWebOrigin, getStoredToken, clearStoredToken, startNativeLogin, bindDeepLinkAuth, refreshStoredToken } from './capacitorAuth'

const TOKEN_KEY = 'forsion_token'
// 本机偏好(默认模型 / 生图模型 / 上次审批档与思考档…)。移动端没有引擎的 ~/.tangu/config.json,
// 缺了这份落盘,设置页每一项都是「点了有勾、重启回默认」的假保存(mobileEntry 的丝滑光标同款病)。
const PREFS_KEY = 'forsion_mobile_config'
// 连接身份一律由垫片现算,永不接受落盘覆盖:native 的 token 刻意住 Capacitor Preferences,
// 放任 `{token}` 的 patch 镜像进 localStorage 等于自己开一道后门。
const IDENTITY_KEYS = ['mode', 'backendUrl', 'token', 'cloudUrl', 'sandbox']

function readPrefs(): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch { return {} }
}

function readWebToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}
function gotoWebLogin(): void {
  const ret = location.origin + (import.meta.env.BASE_URL || '/')
  location.replace('/auth?redirect=' + encodeURIComponent(ret) + '&app=tangu-mobile')
}

/** 用 token + 后端基址装 window.tangu(两条路共用)。login/logout 落点按 native/web 分。 */
function setWindowTangu(backendUrl: string, token: string, native: boolean): void {
  const origFetch = window.fetch.bind(window)

  const authStatus = async (): Promise<Record<string, unknown>> => {
    const base = { cloudUrl: backendUrl, tokenSource: 'config' as const }
    if (!token) return { ...base, loggedIn: false, tokenValid: null, username: null, tokenSource: null }
    try {
      const r = await origFetch(`${backendUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      if (r.status === 401 || r.status === 403) return { ...base, loggedIn: false, tokenValid: false, username: null }
      if (!r.ok) return { ...base, loggedIn: true, tokenValid: null, username: null }
      const u = await r.json().catch(() => ({} as Record<string, unknown>))
      return { ...base, loggedIn: true, tokenValid: true, username: u.username ?? null, nickname: u.nickname ?? null, avatar: u.avatar ?? null, membershipTier: (u as { membershipTier?: unknown }).membershipTier ?? null }
    } catch {
      return { ...base, loggedIn: true, tokenValid: null, username: null }
    }
  }

  const login = async (): Promise<void> => { if (native) await startNativeLogin(); else gotoWebLogin() }
  const logout = async (): Promise<void> => {
    if (native) await clearStoredToken()
    else { try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ } }
    // 云端痕迹一并清(与 webShim.forsionLogout 同款;树快照是全局键,换号会看到上一位用户的树)。
    try {
      localStorage.removeItem('amadeus_tree_snap')
      localStorage.removeItem('amadeus.cloudVaultId')
      for (const k of Object.keys(localStorage)) if (k.startsWith('amadeus_last_page:')) localStorage.removeItem(k)
    } catch { /* ignore */ }
    await login()
  }

  // /account 与 /pay 是 Forsion 站点的**网页**(与登录页 /auth 同一处),不在 `/api` 下 ——
  // 拿 backendUrl 拼会得到 /api/account = 404 =「个人中心无法跳转」。用网页源。
  const webOrigin = forsionWebOrigin()
  // 外开页面:native 走系统浏览器(Capacitor Browser),web 新标签。带 token 是账号中心的登录交接方式(桌面同款)。
  const openExternal = async (url: string): Promise<{ ok: boolean }> => {
    if (native) { try { await Browser.open({ url }) } catch { /* ignore */ } }
    else window.open(url, '_blank', 'noopener')
    return { ok: true }
  }

  /** 设备页(Forsion Unit)专用:开在**本 app 内的 WebView**,不是系统浏览器。
   *
   *  与 openExternal 分家的理由:账号中心 / 付费页是 Forsion 自己的网页,交给系统浏览器天经地义;
   *  而设备页是「用另一台设备的 Forsion」——被弹进 Chrome 自定义标签页(带 ✕ ∨ 分享 翻译 那条壳)
   *  观感上就是**离开了 App**,与桌面端「整个主区切过去」(UnitRemoteSurface)完全不是一回事,
   *  用户 2026-09-03 实报。
   *
   *  为什么必须是插件而不是 iframe:app 自己跑在 `https://localhost`(androidScheme),LAN 页是
   *  `http://<ip>:<port>` → mixed content 直接被拦;中转那侧的隧道 cookie 是 `SameSite=Lax`,
   *  跨站 iframe 根本不发 → 框里恒 401。插件开的是**顶级导航**,两条路都天然成立。
   *
   *  ⚠️ clearCache / clearSessionCache 必须为 false:中转是靠引导页换来的 HttpOnly cookie 进隧道的,
   *     清了 = 每次开都退回「请先登录」。
   *  ⚠️ android.hardwareBack:true —— 返回键先在 WebView 历史里后退,没得退了才关掉。这是原生视图、
   *     不是 DOM 浮层,`forsion:mobile-back` 那条契约管不到它。 */
  const openUnitPage = async (url: string): Promise<{ ok: boolean }> => {
    if (!native) { window.open(url, '_blank', 'noopener'); return { ok: true } }
    // ⚠️ 地址栏(showURL)只对**我们自己的中转页**关:那条 URL 带 `#token=`,显出来等于把登录态
    //    摆在屏幕上。LAN 直连 / 手输地址是**明文 http 的第三方来源**,名册里的 lanUrl 是对方设备
    //    自报的、手输的更是用户现敲的 —— 把它们塞进一个没有地址栏的 Forsion 外壳里,等于替一个
    //    来源不明的页面背书(Codex 评审 medium)。这两种一律露出 scheme + host。
    await InAppBrowser.openInWebView({
      url,
      options: {
        showURL: !url.startsWith(backendUrl),
        showToolbar: true,       // 只为那枚关闭钮:全屏无出口 = 只能杀进程
        clearCache: false,
        clearSessionCache: false,
        mediaPlaybackRequiresUserAction: false,
        closeButtonText: translate('common.close'),
        toolbarPosition: ToolbarPosition.TOP,
        showNavigationButtons: false, // 设备页自带导航;前进/后退钮只会和它打架
        leftToRight: false,
        android: { allowZoom: false, hardwareBack: true, pauseMedia: true },
        iOS: {
          allowOverScroll: false,
          enableViewportScale: false,
          allowInLineMediaPlayback: true,
          surpressIncrementalRendering: false,
          viewStyle: iOSViewStyle.FULL_SCREEN,
          animationEffect: iOSAnimation.COVER_VERTICAL,
          allowsBackForwardNavigationGestures: true,
        },
      },
    })
    return { ok: true }
  }
  // 账号菜单的云端调用(电文形状对齐 electron 的 account:quota / account:useResetCard —— AccountCard 靠
  // `window.tangu?.accountQuota` 探测本能力,此前移动端缺席 → 点头像走 openAccountCenter 也缺席 = 点了没反应)。
  // ⚠️ backendUrl 已经含 `/api`(= apiBase()),path 一律从 `/api` **之后**写起。
  //    写成 '/api/token-quota/my' 会拼出 /api/api/… = 404 =「额度加载失败」(2026-08-08 实翻)。
  const cloudJson = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    if (!token) return { status: 401, json: null }
    try {
      const r = await origFetch(`${backendUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    } catch (e) {
      return { status: 0, json: { detail: String((e as Error)?.message || e) } }
    }
  }

  // 身份字段压在最后:落盘偏好(可能是旧号 / 被人改过的 localStorage)绝不该盖掉连接与鉴权。
  const config = (): Record<string, unknown> => ({
    modelId: '', ...readPrefs(),
    mode: 'external', backendUrl, token, cloudUrl: backendUrl, sandbox: 'none',
  })

  ;(window as unknown as { tangu: unknown }).tangu = {
    cloudWeb: true,
    mobile: true,
    getConfig: async () => config(),
    // 契约同 electron 的 config:set —— 并入并回全份快照。共享渲染层的 patchConfig / rememberDefaults /
    // setDefaultModel 都打这里,移动端此前整个缺席(可选链不短路 → 直接 TypeError,见 e2e:settingscfg)。
    setConfig: async (patch: Record<string, unknown>) => {
      const next = { ...readPrefs(), ...(patch || {}) }
      for (const k of IDENTITY_KEYS) delete next[k]
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* private mode:本次会期内仍生效 */ }
      return config()
    },
    authStatus,
    forsionLogin: login,
    forsionLogout: logout,
    accountQuota: () => cloudJson('GET', '/token-quota/my'),
    openExternal,
    openUnitPage,
    // 账号名下设备名册(Forsion Unit):互联入口 UnitsSheet 的数据面;与桌面 units:list IPC 同形 {status,json}。
    unitsList: () => cloudJson('GET', '/units'),
    accountUseResetCard: (type?: string) => {
      if (type !== undefined && type !== 'both' && type !== 'weekly') {
        return Promise.resolve({ status: 400, json: { error: 'invalid_type', detail: `invalid reset card type: ${type}` } })
      }
      return cloudJson('POST', '/token-quota/reset-card/use', { type: type ?? 'both' })
    },
    openAccountCenter: (section?: string) => {
      const hash = section && /^[a-z0-9-]+$/i.test(section) ? `#${section}` : ''
      return openExternal(`${webOrigin}/account${token ? `?token=${encodeURIComponent(token)}` : ''}${hash}`)
    },
    openPayCenter: () =>
      openExternal(`${webOrigin}/pay?tab=membership${token ? `&token=${encodeURIComponent(token)}` : ''}&redirect=${encodeURIComponent(`${webOrigin}/account`)}`),
  }

  // 401 兜底:/api/agent/* 鉴权失败 → 清 token 重新登录。
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await origFetch(input, init)
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (res.status === 401 && url.includes('/api/agent/')) { void logout() }
    } catch { /* ignore */ }
    return res
  }
}

/** 装垫片。返回 true=已就绪可挂载;false=未登录(已发起登录/跳转),调用方停止挂载。 */
export async function installMobileShim(): Promise<boolean> {
  if (isNative()) {
    // 深链回跳:拿到 token 后 reload,本函数再跑一遍即带 token 挂载。
    bindDeepLinkAuth(() => { location.reload() })
    const token = await getStoredToken()
    if (!token) { await startNativeLogin(); return false }
    // 滑动续期(2 周窗口):不阻塞启动——本次仍用手上这枚(还有效,续期不吊销旧的),换来的下次启动吃到。
    void refreshStoredToken()
    setWindowTangu(apiBase(), token, true)
    return true
  }

  // web(dev/preview):捕获 /auth 回跳的 ?token=,落 localStorage。
  try {
    const u = new URL(location.href)
    const tok = u.searchParams.get('token')
    if (tok) { localStorage.setItem(TOKEN_KEY, tok); u.searchParams.delete('token'); history.replaceState(null, '', u.toString()) }
  } catch { /* private mode */ }
  const token = readWebToken()
  if (!token) { gotoWebLogin(); return false }
  setWindowTangu(apiBase(), token, false)
  return true
}
