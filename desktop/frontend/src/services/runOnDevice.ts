/**
 * 「点一台电脑,把新会话建到它上面」的流程(纯函数,无 React / 无 capacitor 依赖)—— 手机的「在哪运行」弹层(K8,
 * mobile/src/unitsSheetModel.ts 转出)与桌面新对话的运行位置胶囊(components/RunLocationPicker.tsx)共用这一份。
 *
 * runOn:确认本端身份(手机 = 懒登记本机;桌面 = 身份由主进程中转口管,恒 ok)→ 问那台电脑认不认这一端
 *   (`GET /unit/remote-access`)→ 需要就发起确认并每 2s 轮询(截止 = 那台查名册 + 弹框时限 + 余量,过了再核一次)
 *   → 探一次引擎(`GET /engine/agent/sessions`,远端允许的基础档)→ 生效(调注入的 select)。
 *   **reason 先于 state**(P1-KF):回包带 reason(严格档 / 名册缺失 / 那台没登录 / 没人答 / 排满 …)= 那台电脑上不会有弹框 ——
 *   不发起确认、不进「请在 X 上允许」的轮询,直接按 reason 落到行上;轮询中弹框收了没回答(回 unconfirmed)也就此停下。
 * 单测:mobile/scripts/units-sheet-model.test.cjs(经 unitsSheetModel 的转出跑)。
 */
import type { TargetRef } from './engine/target'
import { isTrustReason, REMOTE_PROMPT_TTL_MS, ROSTER_LOOKUP_TIMEOUT_MS, type ProbeResult, type StickyRefusal } from './deviceStatus'

/**
 * 这台手机自身的状况(不是某台电脑的):显示成弹层上方的一条横幅。
 * 按原因分(评审 P1):短暂失败(断网 / 5xx / 限流)是 network(稍后重试就好)、forsion_token 被拒是 signedOut(重新登录),
 * 只有明确的拒绝才是 callerUnavailable —— 原先断网也显示「这台手机无法证明自己的身份」,文不对题。
 */
export type PhoneIssue = 'nativeOnly' | 'callerUnavailable' | 'callerUnsupported' | 'network' | 'signedOut'

/** ensureRegistered 的 reject code(原生 UnitError)/ 中继合成的 CALLER_* 码 → 横幅。 */
export function phoneIssueOfCode(code: string | undefined | null): PhoneIssue {
  if (code === 'native_only') return 'nativeOnly'
  if (code === 'caller_unsupported' || code === 'CALLER_UNSUPPORTED') return 'callerUnsupported'
  if (code === 'network' || code === 'server_429' || (typeof code === 'string' && /^server_5\d\d$/.test(code))) return 'network'
  if (code === 'auth_expired' || code === 'server_401' || code === 'not_signed_in') return 'signedOut'
  return 'callerUnavailable'
}

export type RunOnOutcome =
  | { kind: 'selected' }
  | { kind: 'phone'; issue: PhoneIssue }
  | { kind: 'device'; probe?: ProbeResult; sticky?: StickyRefusal }
  | { kind: 'cancelled' }

export interface RunOnDeps {
  ensureSelf(): Promise<{ ok: true; unitId: string; name: string } | { ok: false; code: string }>
  /** 经 window.fetch(中继面由原生带票)。网络错抛出。 */
  fetchJson(url: string, init?: RequestInit): Promise<{ status: number; json: unknown }>
  /** 生效:切运行位置。UnitsSheet 注入它那一个 selectRunLocation(= setFocusTarget)。 */
  select(ref: TargetRef): void | Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
  /** 过程中的状态更新(等待确认时显示「请在 X 上允许这台手机」)。 */
  progress?(p: { probe?: ProbeResult; sticky?: StickyRefusal }): void
}

export const CONFIRM_POLL_MS = 2000
/**
 * 等「允许」的截止(从拿到 pending 起算)= 那台电脑查名册的上限 + 弹框时限 + 5s 余量(P1-KF 评审 P2)。
 * 原先是 120s:桌面查完名册(≤ 10s)才起 2 分钟的弹框计时,手机总是先放弃,停在「请在 X 上允许」挂 5 分钟 —— 而那个框几秒后就收了。
 * 常量与桌面同源(shared/remoteSessions.ts)。排在别的框后面(队列 ≤ 3)的请求会更晚才弹:截止后的最后一次核对兜住它。
 */
export const CONFIRM_TIMEOUT_MS = ROSTER_LOOKUP_TIMEOUT_MS + REMOTE_PROMPT_TTL_MS + 5_000
/** 过了截止再等这一拍、最后核一次:桌面的框多半刚到点收掉,拿它的 no-answer 落行,不带着「请允许」停下。 */
export const CONFIRM_GRACE_MS = 3_000

type AccessStatus = { remoteSessions?: boolean; caller?: string; reason?: string }

function failOf(status: number, json: unknown): ProbeResult {
  const o = (json && typeof json === 'object' ? json : {}) as { code?: unknown; state?: unknown; reason?: unknown }
  return {
    ok: false, status,
    ...(typeof o.code === 'string' ? { code: o.code } : {}),
    ...(typeof o.state === 'string' ? { state: o.state } : {}),
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
  }
}

function callerCodeOf(json: unknown): string | null {
  const c = (json as { code?: unknown } | null)?.code
  return c === 'CALLER_UNAVAILABLE' || c === 'CALLER_UNSUPPORTED' ? c : null
}

/**
 * 这一步的回包是不是「手机自己的问题」(换哪台电脑都一样):中继合成的 503 CALLER_* 与 401(forsion_token 被 hub 拒 ——
 * 中继换票撞 401 时合成的也是它)。是 → 横幅,不记到这台电脑头上。
 */
function phoneLevel(r: { status: number; json: unknown }): PhoneIssue | null {
  const c = callerCodeOf(r.json)
  if (c) return phoneIssueOfCode(c)
  if (r.status === 401) return 'signedOut'
  return null
}

/**
 * 点一台电脑。signal 中止(弹层关了 / 点了别的)→ cancelled,不调 select。
 * 任何一步拿到中继合成的 503 CALLER_* → 手机级横幅(换哪台电脑都一样),不记到这台电脑头上。
 */
export async function runOn(apiBase: string, unitId: string, deps: RunOnDeps, signal?: AbortSignal): Promise<RunOnOutcome> {
  const aborted = (): boolean => !!signal?.aborted
  const self = await deps.ensureSelf()
  if (aborted()) return { kind: 'cancelled' }
  if (!self.ok) return { kind: 'phone', issue: phoneIssueOfCode(self.code) }

  const base = `${apiBase}/units/${unitId}/proxy`
  const get = async (path: string, init?: RequestInit): Promise<{ status: number; json: unknown } | null> => {
    try { return await deps.fetchJson(base + path, { ...init, signal }) } catch { return null }
  }

  // ① 那台电脑认不认这台手机(K4 的状态面;老桌面没有这条路由 → 404,跳过,交给引擎探针)
  let access = await get('/unit/remote-access')
  if (aborted()) return { kind: 'cancelled' }
  if (access === null) return { kind: 'device', probe: { ok: false, status: 0 } }
  const accessIssue = phoneLevel(access)
  if (accessIssue) return { kind: 'phone', issue: accessIssue }
  if (access.status === 200) {
    let s = (access.json ?? {}) as AccessStatus
    const RCU = 'REMOTE_CALLER_UNCONFIRMED'
    /** 这份状态是不是已经说死了「这次跑不成」:开关关着 → 带 reason(不会弹框)→ 被拒。reason 先于 state(P1-KF)。 */
    const refusal = (st: AccessStatus): RunOnOutcome | null => {
      if (st.remoteSessions === false) return { kind: 'device', sticky: { code: 'REMOTE_SESSIONS_OFF', at: deps.now() } }
      if (st.caller !== 'trusted' && st.caller !== 'paired' && isTrustReason(st.reason)) {
        return { kind: 'device', sticky: { code: RCU, ...(typeof st.caller === 'string' ? { state: st.caller } : {}), reason: st.reason, at: deps.now() } }
      }
      if (st.caller === 'denied') return { kind: 'device', sticky: { code: RCU, state: 'denied', at: deps.now() } }
      return null
    }
    /** 那台电脑上此刻没有弹框、也没排上(没问过 / 弹框没等到回答就收了):不轮询,行上说「再点一次会去问」。 */
    const notAsked = (): RunOnOutcome => ({ kind: 'device', sticky: { code: RCU, state: 'unconfirmed', at: deps.now() } })
    const r0 = refusal(s)
    if (r0) return r0
    if (s.caller === 'unconfirmed') {
      const req = await get('/unit/remote-access/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (aborted()) return { kind: 'cancelled' }
      if (req === null) return { kind: 'device', probe: { ok: false, status: 0 } }
      const reqIssue = phoneLevel(req)
      if (reqIssue) return { kind: 'phone', issue: reqIssue }
      if (req.status !== 200) return { kind: 'device', probe: failOf(req.status, req.json) }
      s = (req.json ?? {}) as AccessStatus
      const r1 = refusal(s) // 排满(busy)只在这一拍知道 —— 在「请允许」之前判
      if (r1) return r1
      if (s.caller === 'unconfirmed') return notAsked() // 发起了也没排上(开关刚关 / 锁定 …):不会有弹框
    }
    if (s.caller === 'pending') {
      const pending: StickyRefusal = { code: RCU, state: 'pending', at: deps.now() }
      deps.progress?.({ sticky: pending })
      const deadline = deps.now() + CONFIRM_TIMEOUT_MS
      for (let last = false; ;) {
        // 过了截止:宽限一拍、最后核一次,按那台电脑此刻的回答落行(评审 P2)—— 绝不带着「请允许」停下:
        // 那条会在行上挂 5 分钟(STICKY_TTL_MS),人走到电脑前却没有框。
        if (!last && deps.now() >= deadline) last = true
        await deps.sleep(last ? CONFIRM_GRACE_MS : CONFIRM_POLL_MS)
        if (aborted()) return { kind: 'cancelled' }
        access = await get('/unit/remote-access')
        if (aborted()) return { kind: 'cancelled' }
        if (access === null) return { kind: 'device', probe: { ok: false, status: 0 } }
        const pollIssue = phoneLevel(access)
        if (pollIssue) return { kind: 'phone', issue: pollIssue }
        if (access.status !== 200) return { kind: 'device', probe: failOf(access.status, access.json) }
        s = (access.json ?? {}) as AccessStatus
        const r = refusal(s) // 被拒 / 名册缺失(那台查完名册才知道)/ 没人答(弹框 2 分钟到点)
        if (r) return r
        if (s.caller === 'pending' && !last) continue
        // 弹框收了、没有回答 → 别再转「请允许」;截止后还 pending(排在别的框后面)→ 不再等,行上说「点按再次请求」(再点会接着等)
        if (s.caller === 'unconfirmed' || s.caller === 'pending') return notAsked()
        break // trusted / paired
      }
    }
  } else if (access.status !== 404) {
    return { kind: 'device', probe: failOf(access.status, access.json) }
  }

  // ② 探一次引擎(读会话列表 = 基础档;离线 / 引擎没起在这里现形)
  const probe = await get('/engine/agent/sessions')
  if (aborted()) return { kind: 'cancelled' }
  if (probe === null) return { kind: 'device', probe: { ok: false, status: 0 } }
  const probeIssue = phoneLevel(probe)
  if (probeIssue) return { kind: 'phone', issue: probeIssue }
  if (probe.status < 200 || probe.status >= 300) return { kind: 'device', probe: failOf(probe.status, probe.json) }
  deps.progress?.({ probe: { ok: true } })
  await deps.select({ kind: 'unit', unitId })
  return { kind: 'selected' }
}
