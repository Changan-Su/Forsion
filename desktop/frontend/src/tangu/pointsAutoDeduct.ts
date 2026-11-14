/**
 * 「额度用完后用积分继续」开关的唯一写入口(2026-11-13)。
 * 读:额度视图里的 pointsAutoDeduct / pointsBalance(GET /api/token-quota/my,经 accountQuota)。
 * 写:云账号扩展的通道 `account:pointsAutoDeduct`(经 window.tangu.cloudInvoke,回 { status, json })。
 * 支不支持看额度视图里有没有 pointsBalance 与 modelMultiplierCap(pointsAutoDeduct 09-29 起一直在、恒 false,不能拿它判)。
 * 桥不在(老扩展没注册这条通道 / 没装扩展 / 网页 / 手机没有 cloudInvoke)= 不给「用积分继续」,只留用卡与升级;
 * 刻意不回落通用云请求 —— 回落了老扩展上也会出现按钮,与「没有通道就不显示」的降级相反。
 *
 * 不变量:开关绝不能显示「关」而服务端其实开着;不知道就显示不知道并禁用,不猜。
 * 所以「写入在途 / 结果不确定」是账号级共享状态(phase),所有提醒条订阅同一份:分栏里一个在途,另一个的按钮同样禁用;
 * 一个不确定,另一个也不再给「用积分继续」。只有服务端确认(写成功的回包,或写之后发出的一次读取)才清。换号时清空。
 */
import {
  accountQuotaEpoch, beginPointsWrite, confirmPointsWrite, mergeQuotaView, pointsReadToken, publishAccountQuota,
  resetAccountQuotaScope, resetPointsWriteState, subscribeAccountQuotaScope, type AccountQuotaView,
} from '../services/accountQuota'

export const POINTS_AUTO_DEDUCT_CHANNEL = 'account:pointsAutoDeduct'

/** idle = 没有悬而未决的写;pending = 写在途;unknown = 写的结果确定不了、重读也没拿到;
 *  recovering = 不确定之后的重读在途(仍算不知道 + 在途:界面照旧显示「状态未知」并禁用,不在这期间露出「关」)。 */
export type PointsWritePhase = 'idle' | 'pending' | 'unknown' | 'recovering'
/** 在途(写或恢复):所有改动开关 / 用卡的按钮都禁用。 */
export const pointsPhaseBusy = (p: PointsWritePhase): boolean => p === 'pending' || p === 'recovering'
/** 不知道服务端开没开:界面显示「状态未知」,不给「用积分继续」。 */
export const pointsPhaseUnknown = (p: PointsWritePhase): boolean => p === 'unknown' || p === 'recovering'
let phase: PointsWritePhase = 'idle'
const phaseListeners = new Set<() => void>()
function setPhase(next: PointsWritePhase): void {
  if (phase === next) return
  phase = next
  phaseListeners.forEach((listener) => listener())
}
export function pointsWritePhase(): PointsWritePhase { return phase }
export function subscribePointsWritePhase(listener: () => void): () => void {
  phaseListeners.add(listener)
  return () => { phaseListeners.delete(listener) }
}
// 换号:在途 / 不确定都是上个账号的,清掉(晚到的回包由账号代数挡掉)
subscribeAccountQuotaScope(() => setPhase('idle'))

/** 本次运行里调过一次、扩展说没有这条通道(宿主比扩展新):之后不再露按钮。 */
let channelMissing = false
/** 仅测试用。 */
export function resetPointsAutoDeductBridge(): void { channelMissing = false; resetPointsWriteState(); setPhase('idle') }
/** 仅测试用:模拟换号。 */
export { resetAccountQuotaScope }

const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

export function pointsAutoDeductAvailable(quota: AccountQuotaView | null | undefined): boolean {
  if (channelMissing || typeof window === 'undefined' || typeof window.tangu?.cloudInvoke !== 'function') return false
  return isNum(quota?.pointsBalance) && isNum(quota?.modelMultiplierCap)
}

export type PointsAutoDeductResult =
  | { ok: true; quota: AccountQuotaView }
  /** unavailable = 服务端明确说暂不可用(503 points_fallback_unavailable / 老服务端 410 auto_deduct_removed);
   *  unknown = 确定不了服务端状态(status 0、超时、调用抛错、其余 5xx、200 却没 success),服务端可能已经打开了 ——
   *  phase 已置 unknown,调用方接着 recoverPointsState() 以服务端为准;
   *  no-bridge = 扩展没有这条通道;failed = 其余明确被拒,detail 是服务端给的说明(可能为空);
   *  busy = 已有写 / 恢复在途(别的提醒条发起的也算);stale = 期间换了号,结果整个丢弃。 */
  | { ok: false; reason: 'unavailable' | 'unknown' | 'no-bridge' | 'failed' | 'busy' | 'stale'; detail?: string }

const NO_HANDLER = /no handler|not a forsion extend channel/i

/** 写开关。成功时返回合并后的额度视图(回包不含 resetCards / pointsBalance,沿用 prev 的值)。 */
export async function setPointsAutoDeduct(enabled: boolean, prev: AccountQuotaView | null): Promise<PointsAutoDeductResult> {
  const invoke = typeof window !== 'undefined' ? window.tangu?.cloudInvoke : undefined
  if (typeof invoke !== 'function' || channelMissing) return { ok: false, reason: 'no-bridge' }
  if (pointsPhaseBusy(phase)) return { ok: false, reason: 'busy' }
  const epoch = accountQuotaEpoch()
  const wasUnknown = phase === 'unknown'
  setPhase('pending')
  beginPointsWrite() // 在这之前发出的读取都算旧的
  // 明确被拒 = 服务端没改:回到写之前的样子(之前就不确定的,仍不确定)
  const rejected = (): void => setPhase(wasUnknown ? 'unknown' : 'idle')
  let response: { status?: number; json?: any } | null
  try {
    response = await invoke(POINTS_AUTO_DEDUCT_CHANNEL, enabled) as { status?: number; json?: any } | null
  } catch (error: any) {
    if (epoch !== accountQuotaEpoch()) return { ok: false, reason: 'stale' }
    if (NO_HANDLER.test(String(error?.message || error))) { channelMissing = true; rejected(); return { ok: false, reason: 'no-bridge' } }
    return uncertain()
  }
  if (epoch !== accountQuotaEpoch()) return { ok: false, reason: 'stale' } // 期间换了号:不确认、不广播
  const status = Number(response?.status) || 0
  const json = response?.json
  if (status === 200 && json?.success && typeof json.pointsAutoDeduct === 'boolean') {
    // 按回包显示,不按点的是什么
    confirmPointsWrite(json.pointsAutoDeduct)
    setPhase('idle')
    return { ok: true, quota: mergeQuotaView(prev, json.quota, { pointsAutoDeduct: json.pointsAutoDeduct }) }
  }
  if ((status === 503 && json?.error === 'points_fallback_unavailable') || (status === 410 && json?.error === 'auto_deduct_removed')) {
    rejected()
    return { ok: false, reason: 'unavailable' }
  }
  // 明确被拒的 4xx(400 invalid_request 等):服务端没改,回到原状
  if (status >= 400 && status < 500) { rejected(); return { ok: false, reason: 'failed', detail: typeof json?.detail === 'string' ? json.detail : undefined } }
  return uncertain()
}

/** 写的结果确定不了:置 unknown,并让写期间发出的读取全部作废(它们可能在服务端生效前读的)。 */
function uncertain(): PointsAutoDeductResult {
  beginPointsWrite()
  setPhase('unknown')
  return { ok: false, reason: 'unknown' }
}

/**
 * 恢复性重读(写的结果不确定之后,或用户点「重试」):以服务端为准。读到 → 走与「写成功」同一个确认入口(推进代数,
 * 让写 / 恢复期间发出的读取作废)并广播;读不到 → 停在 unknown。期间换了号 → 丢弃。
 */
export async function recoverPointsState(): Promise<{ ok: true; quota: AccountQuotaView } | { ok: false }> {
  if (pointsPhaseBusy(phase)) return { ok: false }
  const epoch = accountQuotaEpoch()
  setPhase('recovering')
  let view: AccountQuotaView | null = null
  try {
    const response = await window.tangu?.accountQuota?.()
    if (response?.status === 200 && response.json && typeof response.json.pointsAutoDeduct === 'boolean') view = response.json as AccountQuotaView
  } catch { /* 读不到 = 仍不确定 */ }
  if (epoch !== accountQuotaEpoch()) return { ok: false }
  if (!view) { setPhase('unknown'); return { ok: false } }
  confirmPointsWrite(view.pointsAutoDeduct!)
  setPhase('idle')
  publishAccountQuota(view)
  return { ok: true, quota: view }
}

/**
 * 别处的普通读取拿到了服务端值:只有在「不确定」时、且这份读取是在最后一次写 / 不确定之后才发出的(token 仍是当前代数),
 * 才算服务端确认,清掉 unknown。写期间发出的读取 token 已过期,不算。
 */
export function settlePointsFromRead(view: AccountQuotaView | null | undefined, token: number): void {
  if (phase !== 'unknown' || !view || typeof view.pointsAutoDeduct !== 'boolean' || token !== pointsReadToken()) return
  confirmPointsWrite(view.pointsAutoDeduct)
  setPhase('idle')
}
