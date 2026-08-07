/**
 * Forsion 账号登录(Electron 主进程版,契约与 `tangu login` 完全一致):
 *   POST {cloudUrl}/api/auth/cli/start → shell.openExternal(verification_uri_complete)
 *   → 轮询 /api/auth/cli/poll → token 存 ~/.tangu/auth.json(与 CLI/TUI/managed 后端同一份凭证)。
 * 登录态对全家共享:tangu / tangu-server / 桌面 managed 后端都读这份 auth.json。
 */
import { shell } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { forsionHomeDir } from './forsionHome'

export interface TanguCreds {
  cloudUrl?: string
  token?: string
  model?: string
}

const credsFile = (): string => join(forsionHomeDir(), 'auth.json')

export function loadTanguCreds(): TanguCreds {
  try {
    return JSON.parse(readFileSync(credsFile(), 'utf8')) as TanguCreds
  } catch {
    return {}
  }
}

export function saveTanguCreds(c: TanguCreds): void {
  mkdirSync(forsionHomeDir(), { recursive: true })
  writeFileSync(credsFile(), JSON.stringify(c, null, 2), 'utf8')
  try { chmodSync(credsFile(), 0o600) } catch { /* best-effort */ }
}

/** 登出:只清 token(保留 cloudUrl/model 记忆)。 */
export function forsionLogout(): void {
  const c = loadTanguCreds()
  delete c.token
  saveTanguCreds(c)
}

// ── 滑动续期(「离上次进入软件不满 2 周就不必重登」)──────────────────────────────
// 服务端 token 有效期 14 天且不再是硬顶:客户端每次启动拿旧的换一枚新的(/api/auth/refresh,
// jti 沿用 → 单枚吊销语义不变),于是只要 2 周内开过就永远续得上;超过 2 周没开,这枚自然过期,
// 既有 whoami 401 → 就地转真登出的链路会把用户领回登录页。

/** 只解 JWT payload、不验签(验签是服务端的事,这里只为判断该不该续期)。坏串 → null。 */
function tokenClaims(token: string): { iat?: number; exp?: number } | null {
  try {
    const seg = token.split('.')[1]
    if (!seg) return null
    const j = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** 签发至今多久(ms)。无 iat / 坏串 → Infinity:当作很老的老 token,该换就换。 */
export function tokenAgeMs(token: string, now = Date.now()): number {
  const iat = tokenClaims(token)?.iat
  return typeof iat === 'number' ? now - iat * 1000 : Infinity
}

/** 还剩多久过期(ms)。无 exp / 坏串 → Infinity:当作不急,别为它拖慢启动。 */
export function tokenRemainingMs(token: string, now = Date.now()): number {
  const exp = tokenClaims(token)?.exp
  return typeof exp === 'number' ? exp * 1000 - now : Infinity
}

/** 1h 内已换过就跳过:连续重启不必每次都打接口(代价是「闲置多久重登」有 ≤1h 的偏差)。 */
const REFRESH_MIN_AGE_MS = 3600_000

export function shouldRefreshToken(token: string, now = Date.now()): boolean {
  return !!token && tokenAgeMs(token, now) >= REFRESH_MIN_AGE_MS
}

/**
 * 拿当前 token 换一枚新的。返回新 token;**任何不确定的情况一律 null = 什么都不做**:
 * 401/403(这枚已失效,交给 auth:status 既有的转登出链路)、404(老版本 server 没这端点)、
 * 5xx / 离线 / 超时(下次启动再说)。绝不在这里清凭证。
 */
export async function forsionRefreshToken(
  cloudUrl: string,
  token: string,
  timeoutMs = 8000,
): Promise<string | null> {
  if (!cloudUrl || !token) return null
  const base = cloudUrl.replace(/\/+$/, '')
  try {
    const r = await fetch(`${base}/api/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return null
    const j: any = await r.json().catch(() => null)
    const fresh = typeof j?.token === 'string' ? j.token : ''
    return fresh && fresh !== token ? fresh : null
  } catch {
    return null
  }
}

export interface DeviceLoginStart {
  url: string
  userCode: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let loginInFlight = false

/**
 * 跑完整 device flow。onStart 在拿到授权链接时回调(渲染层据此显示链接 + 验证码,
 * 浏览器没弹出来用户也能手动打开)。成功后写 auth.json 并返回 token。
 */
export async function forsionDeviceLogin(
  cloudUrl: string,
  onStart?: (info: DeviceLoginStart) => void,
): Promise<{ token: string; cloudUrl: string }> {
  if (loginInFlight) throw new Error('已有一次登录在进行中,请先在浏览器完成或稍候重试')
  if (!cloudUrl) throw new Error('请先填写 Forsion 云端地址(或设置环境变量 TANGU_CLOUD_URL)')
  loginInFlight = true
  try {
    const base = cloudUrl.replace(/\/+$/, '')
    let start: any
    try {
      start = await fetch(`${base}/api/auth/cli/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).then((r) => r.json())
    } catch (e: any) {
      throw new Error(`无法连接 ${base}:${e?.message || e}`)
    }
    if (!start?.device_code) throw new Error(`云端不支持 CLI 登录(/api/auth/cli/start 返回异常)`)

    const url = start.verification_uri_complete || `${start.verification_uri}?code=${start.user_code}`
    onStart?.({ url, userCode: String(start.user_code || '') })
    void shell.openExternal(url)

    const deadline = Date.now() + (start.expires_in || 600) * 1000
    const interval = (start.interval || 2) * 1000
    while (Date.now() < deadline) {
      await sleep(interval)
      let resp: Response | null = null
      try {
        resp = await fetch(`${base}/api/auth/cli/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: start.device_code }),
        })
      } catch {
        continue
      }
      if (resp.status === 410) throw new Error('登录码已过期,请重新发起登录')
      const j: any = await resp.json().catch(() => ({ status: 'pending' }))
      if (j.status === 'approved' && j.token) {
        saveTanguCreds({ ...loadTanguCreds(), cloudUrl: base, token: j.token })
        return { token: j.token, cloudUrl: base }
      }
    }
    throw new Error('登录超时,请重试')
  } finally {
    loginInFlight = false
  }
}

export interface WhoamiResult {
  /** ok=token 有效;expired=401/403 凭证失效;offline=网络/云端不可达(token 未必失效)。 */
  status: 'ok' | 'expired' | 'offline'
  user?: { username?: string; nickname?: string; avatar?: string; membershipTier?: string }
}

/**
 * 用 token 查当前用户(账号卡)。除返回用户信息外,还区分 token「失效(401/403)」与「离线」——
 * 后者不应被当作登录过期(避免云端抖动把用户误登出)。
 */
export async function forsionWhoami(cloudUrl: string, token: string): Promise<WhoamiResult> {
  if (!cloudUrl || !token) return { status: 'offline' }
  const base = cloudUrl.replace(/\/+$/, '')
  try {
    const r = await fetch(`${base}/api/brain/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (r.status === 401 || r.status === 403) {
      // 仅当 401/403 确为我们 API 的 JSON 响应才判「凭证失效」——代理/网关/CDN 产的 401 页
      // (HTML/无类型)一律按离线,防基础设施抖动把还有效的 auth.json 误判(调用方会据此清凭证)。
      const isApiResp = (r.headers.get('content-type') || '').includes('application/json')
      return { status: isApiResp ? 'expired' : 'offline' }
    }
    if (!r.ok) return { status: 'offline' } // 5xx 等:不确定凭证是否失效,按离线处理
    const u: any = await r.json()
    if (!u) return { status: 'offline' }
    let avatar: string | undefined = u.avatar || u.avatarUrl || u.avatar_url || undefined
    // 相对路径头像(如 /uploads/...)在桌面 file:// 下无法加载 → 用云端地址补成绝对 URL。
    if (avatar && /^\/(?!\/)/.test(avatar)) avatar = base + avatar
    return {
      status: 'ok',
      user: {
        username: u.username || u.nickname || undefined,
        nickname: u.nickname || undefined,
        avatar,
        membershipTier: u.membershipTier || u.membership_tier || undefined,
      },
    }
  } catch {
    return { status: 'offline' }
  }
}
