/**
 * `window.tangu.cloudFetch` 的手机实现(2026-10-09):插件以当前账号调 Forsion 云端 API 的通用接口。
 * 契约 = 桌面的 `cloud:fetch`(Forsion Extend 主进程半身 src/desktop/index.ts):
 *   · 只收**相对路径**(从 `/api` 之后写起,如 '/meeting/rooms');
 *   · 回 { status, json }(发出去了)或 { status: 0, error }(没发出去:bad_method / bad_path / no_cloud_url / 网络异常原文);
 *     没登录回 { status: 401, error: 'not_signed_in' },同样不出网;
 *   · 永不抛。
 * 此前手机上没有它:通话室(forsion-plugin-callroom)一调就抛 no_seam,活动(forsion-plugin-events)停在「不支持」。
 *
 * 与桌面不同的一点要心里有数:桌面的账号令牌留在主进程、渲染层拿不到;手机的令牌本来就在这一个 JS 环境里
 * (localStorage / getConfig().token),插件自己也读得到。所以这里的路径闸防的不是「插件偷令牌」,而是
 * **写错的调用把令牌带去别的主机** —— 闸照桌面原样保留(resolveCloudApiUrl 逐行移植自 Extend 的 cloudApiPath.ts)。
 *
 * 本模块不 import Capacitor,单测见 mobile/scripts/cloud-fetch.test.cjs(npm run test:cloudfetch)。
 */

export interface CloudFetchRequest { path: string; method?: string; body?: unknown; timeoutMs?: number }
export interface CloudFetchResult { status: number; json?: unknown; error?: string }

/** 相对路径 → 云端 API 的绝对地址;非法一律 null。两条真正起作用的闸:① 必须以 `/` 开头(挡绝对 URL);
 *  ② 归一化后的 pathname 仍在 `/api/` 之下(挡 `/../x` 逃出前缀)。origin 比对是纵深防御。 */
export function resolveCloudApiUrl(cloudUrl: unknown, path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  // 手机垫片的 cloudApiBase 已含 /api,剥一次(桌面给的是纯源):免得拼成 /api/api。
  const origin = String(cloudUrl || '').replace(/\/+$/, '').replace(/\/api$/, '')
  if (!origin) return null
  let base: URL
  let target: URL
  try {
    base = new URL(origin)
    target = new URL(origin + '/api' + path)
  } catch { return null }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null
  if (target.origin !== base.origin) return null
  if (!target.pathname.startsWith('/api/')) return null
  return target.toString()
}

export function createCloudFetch(deps: {
  /** 云端 API 基址(含不含 /api 都行)。 */
  cloudApiBase: () => string
  /** 当前账号令牌;空 = 没登录。每次现取:登出 / 换号之后不拿旧的。 */
  token: () => string
  fetch: (input: string, init?: RequestInit) => Promise<Response>
}): (req: CloudFetchRequest) => Promise<CloudFetchResult> {
  return async (raw) => {
    const req = (raw ?? {}) as Partial<Record<keyof CloudFetchRequest, unknown>>
    const path = typeof req.path === 'string' ? req.path : ''
    // 调用方可延长超时(带附件的请求在慢网上 15s 不够),封顶 120s 防止挂死。
    const timeoutMs = Math.min(120_000, Math.max(1_000, Number(req.timeoutMs) || 15_000))
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) return { status: 0, error: 'bad_method' }
    if (!path.startsWith('/')) return { status: 0, error: 'bad_path' }
    const base = deps.cloudApiBase()
    if (!base) return { status: 0, error: 'no_cloud_url' }
    const target = resolveCloudApiUrl(base, path)
    if (!target) return { status: 0, error: 'bad_path' }
    const token = deps.token()
    if (!token) return { status: 401, error: 'not_signed_in' }

    const hasBody = req.body !== undefined && method !== 'GET' && method !== 'DELETE'
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await deps.fetch(target, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: ctl.signal,
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    } catch (err) {
      return { status: 0, error: String((err as Error)?.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }
}
