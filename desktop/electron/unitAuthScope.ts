/**
 * 设备页(内置浏览器分区里的 <webview>)补登录头的范围。
 *
 * 主进程在 BROWSER_PARTITION 上给「经云端中转的设备页」补 Authorization。这个分区同时装着任意第三方网页,
 * 所以补头必须同时满足:
 *   1. 发请求的 webContents 已被主进程**绑定**到某一台设备(绑定由主进程自己核:id 过白名单正则、
 *      在主进程此刻读到的当前账号名册里;渲染层只能提出「这张 webview 要看哪台」,地址前缀由主进程拼);
 *   2. 绑定时的账号 = 此刻的账号、绑定时的云端地址 = 此刻的云端地址(换号 / 登出 / 改云端地址后一律不补);
 *   3. 请求地址落在**这台设备自己**允许的前缀里(unitAllowedPrefixes,今天只有中转的 proxy/),
 *      名册管理接口(列表、改 / 删别的设备、调用方凭据……)一概不在内;
 *   4. Fetch Metadata 可信(same-origin / none / 缺省),第三方页发起的一律不补。
 *
 * 无 Electron 依赖(纯函数 + 小状态),可测。
 */
import { UNIT_ID_RE } from './unitShortcut'

export { UNIT_ID_RE }
export const isUnitFrameId = (id: unknown): id is string => typeof id === 'string' && UNIT_ID_RE.test(id)

/** 一个 webContents 的绑定:看哪台、绑定时是哪个账号、哪个云端。 */
export interface UnitFrameBinding {
  unitId: string
  /** 绑定时的账号标识(同 forsionAccountId;退回令牌哈希)。 */
  accountKey: string
  /** 绑定时的云端地址(不含尾斜杠)。 */
  cloudBase: string
}

/** 云端地址规整:去尾斜杠;解析不了 / 不是 http(s) = null。 */
export function normalizeCloudBase(cloudUrl: string | null | undefined): string | null {
  if (!cloudUrl) return null
  let u: URL
  try { u = new URL(cloudUrl) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * 这台设备允许补头的地址前缀(都以 `/` 结尾)。今天只有中转的 `<cloud>/api/units/<id>/proxy/`:
 * 云端那一侧 `/open` 不需要登录头、`/session` 只在设备自己的子域上才有(服务端 unitHostPathAllowed),
 * 其余 `/api/units/<id>/…`(caps / channel / caller-* / attention…)与名册接口都不归设备页用。
 * 以后「这台自己的子域」上线时在这里加一项。
 */
export function unitAllowedPrefixes(cloudBase: string, unitId: string): string[] {
  if (!isUnitFrameId(unitId)) return []
  return [`${cloudBase}/api/units/${unitId}/proxy/`]
}

/** 前缀之后那段路径里不许出现「解码后才冒出来的」上跳 / 反斜杠(反代可能先解码再路由)。 */
function safeRemainder(rest: string): boolean {
  let decoded: string
  try { decoded = decodeURIComponent(rest) } catch { return false }
  if (decoded.includes('\\')) return false
  return !decoded.split('/').some((s) => s === '..' || s === '.')
}

/** url 是否落在 prefixes 之一里:按解析后的 origin + pathname 比,不比原串;查询串 / 片段不参与。 */
export function urlInPrefixes(rawUrl: string, prefixes: readonly string[]): boolean {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  if (u.username || u.password) return false
  const path = `${u.origin}${u.pathname}`
  for (const p of prefixes) {
    if (!path.startsWith(p)) continue
    if (safeRemainder(path.slice(p.length))) return true
  }
  return false
}

export interface UnitAuthDecisionInput {
  url: string
  /** 请求所属 webContents 的绑定;没绑定(普通标签页 / Service Worker 等没有 webContents 的请求)= undefined。 */
  binding: UnitFrameBinding | undefined
  /** 此刻的账号标识;没登录 = null。 */
  accountKey: string | null
  /** 此刻的云端地址(normalizeCloudBase 之后);不知道 = null。 */
  cloudBase: string | null
  /** 请求头里的 Sec-Fetch-Site(没有 = '')。 */
  secFetchSite: string
}

/** 这条请求要不要补设备页的登录头。任何一项不知道 = 不补。 */
export function shouldInjectUnitAuth(i: UnitAuthDecisionInput): boolean {
  const b = i.binding
  if (!b || !i.accountKey || !i.cloudBase) return false
  if (b.accountKey !== i.accountKey || b.cloudBase !== i.cloudBase) return false
  const sfs = i.secFetchSite
  if (sfs && sfs !== 'none' && sfs !== 'same-origin') return false
  return urlInPrefixes(i.url, unitAllowedPrefixes(b.cloudBase, b.unitId))
}

/** 名册读法(和「添加到桌面」同一条:Extend 的 units:list 处理器,以发起 IPC 的窗口身份读)。 */
export type UnitFrameRosterRead =
  | { ok: true; units: Array<{ id: string }> }
  | { ok: false; code: string; detail?: string }

export type UnitFrameBindResult = { ok: true } | { ok: false; code: 'untrusted' | 'not_found' | 'signed_out' | 'roster_unavailable' | 'account_changed' | 'gone' }

export interface UnitFrameBindDeps {
  /** 发起方可信(主窗,或这台设备自己的 Unit 窗),且 webContentsId 指向它挂着的那张 webview(在设备页分区里)。 */
  trusted: boolean
  /** 那张 webview 还活着、还挂在发起方下面。 */
  guestAlive: () => boolean
  accountKey: () => string | null
  cloudBase: () => string | null
  readRoster: () => Promise<UnitFrameRosterRead>
  bind: (binding: UnitFrameBinding) => void
}

/**
 * units:bindFrame 的全部判断:发起方不可信 → 拒;id 不过正则 → not_found(名册都不读);
 * 记下发起时的账号与云端 → 读名册(读失败 = 不知道,不绑定)→ 名册里没有 → not_found;
 * 名册回来时账号 / 云端变了 → account_changed;webview 已经没了 → gone;都过了才绑定。
 */
export async function handleUnitFrameBind(unitId: unknown, d: UnitFrameBindDeps): Promise<UnitFrameBindResult> {
  if (!d.trusted) return { ok: false, code: 'untrusted' }
  if (!isUnitFrameId(unitId)) return { ok: false, code: 'not_found' }
  const account = d.accountKey()
  const cloud = d.cloudBase()
  if (!account) return { ok: false, code: 'signed_out' }
  if (!cloud) return { ok: false, code: 'roster_unavailable' }
  let roster: UnitFrameRosterRead
  try { roster = await d.readRoster() } catch { return { ok: false, code: 'roster_unavailable' } }
  if (!roster.ok) return { ok: false, code: roster.code === 'signed_out' ? 'signed_out' : 'roster_unavailable' }
  if (!roster.units.some((u) => u.id === unitId)) return { ok: false, code: 'not_found' }
  if (d.accountKey() !== account || d.cloudBase() !== cloud) return { ok: false, code: 'account_changed' }
  if (!d.guestAlive()) return { ok: false, code: 'gone' }
  d.bind({ unitId, accountKey: account, cloudBase: cloud })
  return { ok: true }
}

/** webContents id → 绑定。webContents id 在一次运行里不复用;销毁时由调用方 unbind。 */
export function createUnitFrameScope(): {
  bind(webContentsId: number, b: UnitFrameBinding): void
  unbind(webContentsId: number): void
  get(webContentsId: number | undefined): UnitFrameBinding | undefined
  clear(): void
  size(): number
} {
  const m = new Map<number, UnitFrameBinding>()
  return {
    bind: (id, b) => { m.set(id, { ...b }) },
    unbind: (id) => { m.delete(id) },
    get: (id) => (typeof id === 'number' ? m.get(id) : undefined),
    clear: () => { m.clear() },
    size: () => m.size,
  }
}
