/**
 * UnitsSheet「在哪运行」的纯模型(P1-K8,规格 K8 §3.7;状态口径 = services/deviceStatus.ts,INTEGRATION R-22)。
 * 无 React / 无 capacitor 依赖(web 手机形态也 import 得到;node 单测 scripts/units-sheet-model.test.cjs)。
 *
 * - runRows:只列 `kind === 'desktop'` 且不是本机的设备(手机没有引擎、也没有设备页;INTEGRATION R-28 把 K1 的滤手机并到这里)。
 *   ⚠️ kind 缺席按 desktop:server 2.3.23 之前的名册不回 kind(生产今天就是这样),严格滤会把所有电脑一起滤掉。
 * - runOn:点一台电脑之后的流程 —— 懒登记本机 → 问那台电脑认不认这台手机(`GET /unit/remote-access`,经原生中继带票)
 *   → 需要就发起确认并每 2s 轮询(≤ 120s)→ 探一次引擎(`GET /engine/agent/sessions`,远端允许的基础档)→ 生效。
 *   **reason 先于 state**(P1-KF):回包带 reason(严格档 / 名册缺失 / 那台没登录 / 没人答 / 排满 …)= 那台电脑上不会有弹框 ——
 *   不发起确认、不进「请在 X 上允许」的轮询,直接按 reason 落到行上;轮询中弹框收了没回答(回 unconfirmed)也就此停下。
 *   生效 = 调注入的 select(ref);UnitsSheet 里那一个 selectRunLocation = K6-S2 的 setFocusTarget。
 * - removeThisPhone:「移除本机登记」—— 先切回云端(并等它生效)再移除,顺序由单测钉住(评审 P2)。
 */
import type { UnitInfo } from '@/types'
import { HOME_REF, type TargetRef } from '@/services/engine/target'
import { describeDevice, isTrustReason, RETRY_SOON_REASONS, type DeviceStatus, type ProbeResult, type RefusalDetail, type StickyRefusal, type TrustReason } from '@/services/deviceStatus'

export interface RunRow {
  id: string
  name: string
  icon: string | null
  platform: string | null
  status: DeviceStatus
  /** 决定 status 的那条拒绝的 state / reason(awaitingConfirm / denied / callerBlocked 的文案按它选,P1-KF)。 */
  refusal?: RefusalDetail
  /** 设备自报「引擎在跑」(还没探过时的提示,不等于可用)。 */
  capsReady: boolean
  selected: boolean
}

/** 名册里能当运行位置 / 能打开设备页的:电脑(kind 缺席按电脑),且不是本机。 */
export function isRunnableUnit(u: Pick<UnitInfo, 'id' | 'kind'>, selfId: string | null): boolean {
  return (u.kind ?? 'desktop') === 'desktop' && u.id !== selfId
}

export function runRows(
  units: UnitInfo[],
  selfId: string | null,
  current: TargetRef,
  probes: Readonly<Record<string, ProbeResult | undefined>> = {},
  sticky: Readonly<Record<string, StickyRefusal | undefined>> = {},
  now: number = Date.now(),
): RunRow[] {
  return units.filter((u) => isRunnableUnit(u, selfId)).map((u) => {
    const d = describeDevice(u, probes[u.id] ?? null, sticky[u.id], now)
    return {
      id: u.id,
      name: u.name,
      icon: u.icon ?? null,
      platform: u.platform ?? null,
      status: d.status,
      ...(d.refusal ? { refusal: d.refusal } : {}),
      capsReady: !!(u.online && u.capsLive && u.caps?.engine === 'ready'),
      selected: current.kind === 'unit' && current.unitId === u.id,
    }
  })
}

/** reason → 行上文案键(P1-KF)。Record 键钉住 TrustReason 全集:新增 reason 不补这里就编不过。 */
export const REASON_STATUS_KEYS: Record<TrustReason, string> = {
  strict: 'unitm.reason.strict',
  'never-prompts': 'unitm.reason.neverPrompts',
  'not-signed-in': 'unitm.reason.notSignedIn',
  'roster-miss': 'unitm.reason.rosterMiss',
  'roster-unreachable': 'unitm.reason.rosterUnreachable',
  'no-answer': 'unitm.reason.noAnswer',
  busy: 'unitm.reason.busy',
}

/**
 * 行上的状态文案键(unitm.*;devstatus.* 是 K7 的命名空间,这里不注册以免集成时撞键)。
 * 拒绝类**先看 reason、再看 state**(P1-KF):带 reason = 那台电脑上不会弹框,绝不出「请在 X 上允许」;
 * denied 才说「10 分钟后可再请求」(那是用户点了「不允许」之后的真实冷却),严格档 / 名册缺失不许诺它。
 */
export function statusKey(row: Pick<RunRow, 'status' | 'capsReady'> & { refusal?: RefusalDetail }, probing: boolean): string {
  const reason = row.refusal?.reason
  if (isTrustReason(reason) && (row.status === 'callerBlocked' || row.status === 'denied' || row.status === 'awaitingConfirm')) return REASON_STATUS_KEYS[reason]
  switch (row.status) {
    case 'checking':
      if (probing) return 'unitm.checking'
      return row.capsReady ? 'unitm.ready' : 'unitm.unknown'
    case 'ready': return 'unitm.ready'
    case 'starting': return 'unitm.starting'
    case 'engineStopped': return 'unitm.engineOff'
    case 'noEngine': return 'unitm.noEngine'
    case 'offline': return 'unitm.offline'
    case 'unreachable': return 'unitm.unreachable'
    case 'remoteOff': return 'unitm.remoteOff'
    case 'awaitingConfirm': return row.refusal?.state === 'unconfirmed' ? 'unitm.confirmNotAsked' : 'unitm.confirmPending'
    case 'denied': return 'unitm.confirmDenied'
    case 'callerBlocked': return 'unitm.confirmDenied' // 只在 reason 不认得时到这里(describeDevice 只在认得 reason 时给 callerBlocked)
  }
}

export type RowTone = '' | 'ok' | 'warn' | 'err'
const TONE: Record<DeviceStatus, RowTone> = {
  checking: '', ready: 'ok', starting: 'warn', engineStopped: 'warn', noEngine: 'err', offline: '',
  unreachable: 'err', remoteOff: 'warn', awaitingConfirm: 'warn', denied: 'err', callerBlocked: 'err',
}
/** 行首状态点:callerBlocked 里「稍后再试就行」的几种(名册查不了 / 没人答 / 排满)是 warn,要那台电脑上先做点什么的是 err。 */
export function rowTone(row: Pick<RunRow, 'status' | 'capsReady'> & { refusal?: RefusalDetail }, probing: boolean): RowTone {
  if (row.status === 'checking') return !probing && row.capsReady ? 'ok' : ''
  const reason = row.refusal?.reason
  if (row.status === 'callerBlocked' && isTrustReason(reason) && RETRY_SOON_REASONS.has(reason)) return 'warn'
  return TONE[row.status]
}

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
export const CONFIRM_TIMEOUT_MS = 120_000

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
      for (;;) {
        if (deps.now() >= deadline) return { kind: 'device', sticky: { ...pending, at: deps.now() } }
        await deps.sleep(CONFIRM_POLL_MS)
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
        if (s.caller === 'pending') continue
        if (s.caller === 'unconfirmed') return notAsked() // 弹框收了、没有回答:别再转「请允许」
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

export interface RemoveDeps {
  /** 当前运行位置(= focusRef())。 */
  current(): TargetRef
  /** 同 runOn 的 select:UnitsSheet 唯一的生效出口 selectRunLocation;它等切换(含重连)完成。 */
  select(ref: TargetRef): void | Promise<void>
  /** window.tangu.unitForgetSelf:删本地身份 + DELETE 名册那一行。 */
  forget(): Promise<{ ok: boolean }>
}

/**
 * 「移除本机登记」(评审 P2):**先**切回云端并等它生效,**再**移除。反过来的话,移除途中那台电脑的轮询 / SSE 重连还经中继发着,
 * 撞 403(那行没了、票作废)→ 原生强制换票 → 懒登记 → 悄悄登记出一个新身份,电脑上刚被撤销就又弹「允许这台手机?」。
 * (原生另有一道闩:移除后懒登记与自愈一律拒绝,直到下一次显式登记 —— 两道都在。)
 */
export async function removeThisPhone(deps: RemoveDeps): Promise<{ ok: boolean }> {
  if (deps.current().kind === 'unit') await deps.select(HOME_REF)
  return deps.forget()
}
