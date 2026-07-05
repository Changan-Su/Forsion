/**
 * Tangu Mobile 垫片:把 WebView 伪装成极简「外部后端」host,让复用的 desktop 渲染层零改云连。
 *
 * 两条路(installMobileShim 异步):
 * - **native(Capacitor/Android)**:token 走 @capacitor/preferences 安全存储;无 token → 系统浏览器开
 *   Forsion 登录页,深链 tangu://auth-callback?token=… 回跳(见 capacitorAuth.ts)。API 基址须绝对
 *   (VITE_API_URL,因 location.origin=https://localhost)。
 * - **web(dev/preview)**:localStorage token + 同源/代理 /auth 跳转(等价 webShim),便于不出包快速联调。
 *
 * 其余 host 能力(文件系统/providers/mcp/market/更新…)缺省 → 共享组件 `window.tangu?.X` 可选链自然隐藏。
 */
import { isNative, apiBase, getStoredToken, clearStoredToken, startNativeLogin, bindDeepLinkAuth } from './capacitorAuth'

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
      return { ...base, loggedIn: true, tokenValid: true, username: u.username ?? null, nickname: u.nickname ?? null, avatar: u.avatar ?? null, membershipTier: null }
    } catch {
      return { ...base, loggedIn: true, tokenValid: null, username: null }
    }
  }

  const login = async (): Promise<void> => { if (native) await startNativeLogin(); else gotoWebLogin() }
  const logout = async (): Promise<void> => {
    if (native) await clearStoredToken()
    else { try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ } }
    await login()
  }

  ;(window as unknown as { tangu: unknown }).tangu = {
    cloudWeb: true,
    mobile: true,
    getConfig: async () => ({
      mode: 'external', backendUrl, token, modelId: '',
      cloudUrl: backendUrl, cloudToken: token, sandbox: 'none',
    }),
    authStatus,
    forsionLogin: login,
    forsionLogout: logout,
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
  const backendUrl = String(import.meta.env.VITE_API_URL || (location.origin + '/api')).replace(/\/$/, '')
  setWindowTangu(backendUrl, token, false)
  return true
}
