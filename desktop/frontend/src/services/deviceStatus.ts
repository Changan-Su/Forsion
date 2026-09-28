/**
 * 设备状态模型(纯函数):手机 / web 上「这台电脑现在能不能跑会话」的唯一口径。
 * 规格:docs/ToBeImproved/设备能力MCP_P1规格_2026-09-28/K7-session-aggregation-picker.md §3.2;
 * 归属按 INTEGRATION.md R-22 —— K8 先产出(UnitsSheet「在哪运行」要用),K7 的选择器 / 状态条直接消费,不再重写。
 *
 * 三路输入,按可信度排:
 *   1. 名册(`GET /units`):online 与 caps 都是**设备自报**的快照 —— 只驱动界面,永不作授权依据;
 *      capsLive=false(重连后还没报 / 老桌面不报)时 caps.engine 当「未知」,不沿用重连前的 ready(方案 §4.7)。
 *   2. 探针:最近一次对该设备引擎的请求结果(会话列表 / `GET /unit/remote-access`)。
 *   3. 粘滞拒绝:最近一次**建会话**被拒的码(5 分钟,或直到下次建成功由调用方清掉)——
 *      读会话列表是基础档,开关关着也照样 200,只有建会话才知道会话档被拒。
 * 真正的拒绝永远是 HTTP 码;本模块只把码翻成界面状态。
 *
 * 与 K7 §3.2 的差异(INTEGRATION R-10 覆盖包规格):
 *   - 拒绝码以 K4 为准:`403 REMOTE_CALLER_UNCONFIRMED {state, reason?}` —— **reason 先于 state**(P1-KF):带 reason
 *     (严格档 / 名册缺失 / 那台没登录 / 名册查不了 / 没人答 / 排满 / P2P 不弹框)= 那台电脑上**不会**有弹框 → **callerBlocked**
 *     (第十一态,文案按 reason 出;绝不显示成「请在那台电脑上允许」)。没有 reason 时 state ∈ {pending, unconfirmed} →
 *     awaitingConfirm,state === 'denied' → **denied**(第十态;K7 表里的 CALLER_CONFIRM_PENDING / CALLER_REJECTED 已作废)。
 *   - K8 中继合成的 `503 CALLER_UNAVAILABLE / CALLER_UNSUPPORTED` 是「这台手机」的全局状况,不是某台电脑的状态:
 *     这里只折成 unreachable(消费方别见到未知码),具体文案由界面按码另显一条横幅。
 */
import type { UnitInfo } from '../types'
import { isTrustReason } from '../../../shared/remoteSessions'
// 手机弹层(K8)/ 选择器(K7)按 reason 选文案要用到;从这里转出,消费方不必另找 shared 的相对路径。
export { isTrustReason, RETRY_SOON_REASONS, type TrustReason } from '../../../shared/remoteSessions'

export type DeviceStatus =
  | 'checking'
  | 'ready'
  | 'starting'
  | 'engineStopped'
  | 'noEngine'
  | 'offline'
  | 'unreachable'
  | 'remoteOff'
  | 'awaitingConfirm'
  | 'denied'
  /** P1-KF:那台电脑不给这台设备跑会话,**也不会弹框问**(拒绝体带 reason);出路看 reason(见 shared/remoteSessions.ts TrustReason)。 */
  | 'callerBlocked'

/** 探针结果:ok,或失败时的 HTTP 状态(0 = 网络错 / 被中止)与响应 JSON 里的 code / state / reason。 */
export type ProbeResult = { ok: true } | { ok: false; status: number; code?: string; state?: string; reason?: string }

/** 粘滞拒绝:最近一次建会话被拒时记下的码(at = Date.now() 毫秒);REMOTE_CALLER_UNCONFIRMED 带 state / reason。 */
export interface StickyRefusal {
  code: string
  state?: string
  reason?: string
  at: number
}

/** 拒绝细节:决定状态的那条拒绝(探针或粘滞)里的 state / reason —— 界面按 reason 先、state 后选文案。 */
export type RefusalDetail = { state?: string; reason?: string }

/** 粘滞拒绝的有效期(K7 §3.2:5 分钟,或直到一次建会话成功)。 */
export const STICKY_TTL_MS = 5 * 60_000

/** 可以选作运行位置的状态:在线可用,或正等着那台电脑上点「允许」(选了就会弹确认)。callerBlocked 不在内:选了也不会弹框。 */
export const SELECTABLE: ReadonlySet<DeviceStatus> = new Set<DeviceStatus>(['ready', 'awaitingConfirm'])

/** 只用到名册的这三个字段;caps / capsLive 缺席(老 server)= 未知。 */
export type RosterUnit = Pick<UnitInfo, 'online'> & Partial<Pick<UnitInfo, 'caps' | 'capsLive'>>

const REFUSAL_STATES: ReadonlySet<DeviceStatus> = new Set<DeviceStatus>(['remoteOff', 'awaitingConfirm', 'denied', 'callerBlocked'])

/**
 * 错误 → 状态。收 `{status, code, state}`(backendService.request 抛的错、探针的失败结果都长这样),
 * 也收裸的网络错(TypeError / AbortError → unreachable)。判不出来 = null(调用方按拒绝文案显示,别硬塞一个状态)。
 */
export function statusFromError(e: unknown): DeviceStatus | null {
  if (e == null) return null
  const o = (typeof e === 'object' ? e : {}) as { status?: unknown; code?: unknown; state?: unknown; reason?: unknown; name?: unknown }
  const code = typeof o.code === 'string' ? o.code : ''
  const status = typeof o.status === 'number' ? o.status : NaN
  switch (code) {
    case 'ENGINE_NOT_READY':
      return 'starting' // 桌面在线、引擎在起(或起不来):K7 §3.2 第 9 行
    case 'UNIT_OFFLINE':
    case 'UNIT_DISCONNECTED':
      return 'offline'
    case 'UNIT_TIMEOUT':
      return 'unreachable'
    case 'REMOTE_SESSIONS_OFF':
      return 'remoteOff'
    case 'REMOTE_CALLER_UNCONFIRMED':
      if (isTrustReason(o.reason)) return 'callerBlocked' // reason 先于 state:不会弹框,不是「等确认」
      return o.state === 'denied' ? 'denied' : 'awaitingConfirm'
    // 手机中继的失败关闭(K8)与坏票重发一次后仍被拒(R-04):都是「这台手机此刻证明不了自己」,换台电脑也一样。
    case 'CALLER_UNAVAILABLE':
    case 'CALLER_UNSUPPORTED':
    case 'UNIT_CALLER_INVALID':
    case 'UNIT_CALLER_EXPIRED':
      return 'unreachable'
  }
  if (code) return status >= 500 ? 'unreachable' : null
  // 无 code:网络错 / 中止 / 5xx(网关、隧道)→ 连不上;其余 4xx 不是设备状态。
  if (o.name === 'TypeError' || o.name === 'AbortError' || status === 0) return 'unreachable'
  if (status >= 500) return 'unreachable'
  return null
}

/**
 * 名册 × 探针 × 粘滞拒绝 → 状态(K7 §3.2 表,外加 R-10 的 denied)。
 * 次序:离线 → 设备自报的引擎态(capsLive 才算数)→ 探针失败 → 粘滞拒绝 → 探针成功 → 还没探过(checking)。
 * 探针失败排在粘滞拒绝前面:连不上 / 引擎在起的时候,开关与信任都无从谈起。
 */
export function deviceStatus(u: RosterUnit, probe: ProbeResult | null, sticky?: StickyRefusal | null, now: number = Date.now()): DeviceStatus {
  return describeDevice(u, probe, sticky, now).status
}

const detailOf = (x: { state?: string; reason?: string }): RefusalDetail | undefined =>
  x.state || x.reason ? { ...(x.state ? { state: x.state } : {}), ...(x.reason ? { reason: x.reason } : {}) } : undefined

/**
 * deviceStatus 连同**决定它的那条拒绝**的 state / reason(P1-KF):awaitingConfirm / denied / callerBlocked 的文案要看它们
 * (reason 先、state 后;pending 与「还没问过」也不是一句话)。次序与 deviceStatus 完全相同(它就是本函数的 .status)。
 */
export function describeDevice(u: RosterUnit, probe: ProbeResult | null, sticky?: StickyRefusal | null, now: number = Date.now()): { status: DeviceStatus; refusal?: RefusalDetail } {
  if (!u.online) return { status: 'offline' }
  if (u.capsLive && u.caps) {
    const engine = u.caps.engine
    if (engine === 'external') return { status: 'noEngine' }
    if (engine === 'stopped') return { status: 'engineStopped' }
    if (engine === 'starting') return { status: 'starting' }
  }
  if (probe && !probe.ok) {
    const status = statusFromError(probe) ?? 'unreachable'
    const refusal = REFUSAL_STATES.has(status) ? detailOf(probe) : undefined
    return refusal ? { status, refusal } : { status }
  }
  if (sticky && now - sticky.at >= 0 && now - sticky.at < STICKY_TTL_MS) {
    const s = statusFromError({ status: 403, code: sticky.code, state: sticky.state, reason: sticky.reason })
    if (s && REFUSAL_STATES.has(s)) {
      const refusal = detailOf(sticky)
      return refusal ? { status: s, refusal } : { status: s }
    }
  }
  if (probe?.ok) return { status: 'ready' }
  return { status: 'checking' }
}

/** 设备自报「引擎在跑」(capsLive 且 engine==='ready'):只作还没探过时的提示,不等于可用。 */
export function capsSaysReady(u: RosterUnit): boolean {
  return !!(u.online && u.capsLive && u.caps?.engine === 'ready')
}
