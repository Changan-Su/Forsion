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
import { isNative, apiBase, forsionWebOrigin, getStoredToken, clearStoredToken, startNativeLogin, bindDeepLinkAuth, refreshStoredToken } from './capacitorAuth'

const TOKEN_KEY = 'forsion_token'

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

  ;(window as unknown as { tangu: unknown }).tangu = {
    cloudWeb: true,
    mobile: true,
    getConfig: async () => ({
      mode: 'external', backendUrl, token, modelId: '',
      cloudUrl: backendUrl, sandbox: 'none',
    }),
    authStatus,
    forsionLogin: login,
    forsionLogout: logout,
    accountQuota: () => cloudJson('GET', '/token-quota/my'),
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
