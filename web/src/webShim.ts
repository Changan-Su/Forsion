/**
 * Tangu Web 垫片:把浏览器伪装成极简「外部后端」host,让被复用的 desktop 渲染层零改即可云连。
 *
 * - 提供 window.tangu.getConfig() → appStore.boot() 直连同源 Forsion 网关(/api);
 * - cloudWeb 标志供共享组件解闸「云端可用」特性(技能等);
 * - 无 token → 跳现有 Forsion 登录页(/auth)并带回;
 * - /api/agent/* 收到 401 → 清 token 重新登录(浏览器无主进程刷新通道)。
 *
 * 其余所有 host 能力(文件系统/providers/mcp/market/特殊Agent/更新…)在 window.tangu 上缺省,
 * 共享组件的 `window.tangu?.X` 可选链自然 no-op / 隐藏。
 */
const TOKEN_KEY = 'forsion_token'

function readToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

function gotoLogin(): void {
  const ret = location.origin + (import.meta.env.BASE_URL || '/')
  location.replace('/auth?redirect=' + encodeURIComponent(ret) + '&app=tangu-web')
}

// —— 供 Amadeus 云端桥(src/amadeus/*)复用的三件套:同一 token 键、同一 API 基址、同一登录跳转。 ——

/** 当前登录 token(localStorage forsion_token;无 = '')。 */
export function getToken(): string {
  return readToken()
}

/** API 基址(与 installWebShim 内部一致):VITE_API_URL 覆盖,否则同源 origin+/api,无尾斜杠。 */
export function getApiBase(): string {
  return String(import.meta.env.VITE_API_URL || (location.origin + '/api')).replace(/\/$/, '')
}

/** 清 token 并跳 Forsion 登录页(带回跳)。 */
export function redirectToLogin(): void {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
  gotoLogin()
}

/**
 * 装垫片。返回 true=已就绪可挂载;false=未登录已跳转,调用方应停止挂载。
 */
export function installWebShim(): boolean {
  // 1) 捕获 /auth 回跳的 ?token=,落盘到与 account/admin 共享的键并清理 URL。
  try {
    const u = new URL(location.href)
    const tok = u.searchParams.get('token')
    if (tok) {
      localStorage.setItem(TOKEN_KEY, tok)
      u.searchParams.delete('token')
      history.replaceState(null, '', u.toString())
    }
  } catch { /* private mode / 老浏览器 */ }

  const token = readToken()
  if (!token) { gotoLogin(); return false }

  // 2) API 基址(同 AI Studio 约定):VITE_API_URL 覆盖,否则同源 location.origin+/api
  //    —— dev 经 vite proxy、prod 经本 app 自己的 nginx 把 /api 代理到 Forsion server(→ tangu worker)。
  const backendUrl = String(import.meta.env.VITE_API_URL || (location.origin + '/api')).replace(/\/$/, '')

  const origFetch = window.fetch.bind(window)

  // 登录态:桌面端由 electron 的 window.tangu.authStatus() 提供;web 无主进程 → 用共享 token 打 Forsion
  // /auth/me(200=有效、401/403=过期、无 token=未登录),映射成 AccountCard 认的 AuthStatusInfo。
  // 缺了它 AccountCard 恒显「未登录」、forsionLogin 缺失则登录按钮点了没反应(见 components/AccountCard)。
  const authStatus = async (): Promise<Record<string, unknown>> => {
    const tok = readToken()
    const base = { cloudUrl: backendUrl, tokenSource: 'config' as const }
    if (!tok) return { ...base, loggedIn: false, tokenValid: null, username: null, tokenSource: null }
    try {
      const r = await origFetch(`${backendUrl}/auth/me`, { headers: { Authorization: `Bearer ${tok}` } })
      if (r.status === 401 || r.status === 403) return { ...base, loggedIn: false, tokenValid: false, username: null }
      if (!r.ok) return { ...base, loggedIn: true, tokenValid: null, username: null } // 网络/5xx:不确定,别误判过期
      const u = await r.json().catch(() => ({} as any))
      return { ...base, loggedIn: true, tokenValid: true, username: u.username ?? null, nickname: u.nickname ?? null, avatar: u.avatar ?? null, membershipTier: null }
    } catch {
      return { ...base, loggedIn: true, tokenValid: null, username: null } // 离线:保守当已登录、待过期检测校准
    }
  }

  // 3) host 垫片:getConfig + cloudWeb + 账号能力(登录/登出/账号中心跳 Forsion 页,复用共享 token)。
  ;(window as unknown as { tangu: unknown }).tangu = {
    cloudWeb: true,
    getConfig: async () => ({
      mode: 'external', backendUrl, token, modelId: '',
      cloudUrl: backendUrl, cloudToken: token, sandbox: 'none',
    }),
    authStatus,
    forsionLogin: async () => { gotoLogin() },
    forsionLogout: async () => { try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ } gotoLogin() },
    openAccountCenter: () => { window.open('/account/', '_blank', 'noopener') },
  }

  // 4) 401 兜底:任一 /api/agent/* 或 /api/amadeus/*(Amadeus 云端桥)鉴权失败 → 清 token 重新登录。
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await origFetch(input, init)
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (res.status === 401 && (url.includes('/api/agent/') || url.includes('/api/amadeus/'))) {
        try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
        gotoLogin()
      }
    } catch { /* ignore */ }
    return res
  }

  return true
}
