/**
 * 「额度用完后用积分继续」开关的唯一写入口(2026-11-13)。
 * 读:额度视图里的 pointsAutoDeduct / pointsBalance(GET /api/token-quota/my,经 accountQuota)。
 * 写:云账号扩展的通道 `account:pointsAutoDeduct`(经 window.tangu.cloudInvoke,回 { status, json })。
 * 支不支持看额度视图里有没有 pointsBalance 与 modelMultiplierCap(pointsAutoDeduct 09-29 起一直在、恒 false,不能拿它判)。
 * 桥不在(老扩展没注册这条通道 / 没装扩展 / 网页 / 手机没有 cloudInvoke)= 不给「用积分继续」,只留用卡与升级;
 * 刻意不回落通用云请求 —— 回落了老扩展上也会出现按钮,与「没有通道就不显示」的降级相反。
 */
import { beginPointsWrite, confirmPointsWrite, mergeQuotaView, resetPointsWriteState, type AccountQuotaView } from '../services/accountQuota'

export const POINTS_AUTO_DEDUCT_CHANNEL = 'account:pointsAutoDeduct'

/** 本次运行里调过一次、扩展说没有这条通道(宿主比扩展新):之后不再露按钮。 */
let channelMissing = false
/** 仅测试用。 */
export function resetPointsAutoDeductBridge(): void { channelMissing = false; resetPointsWriteState() }

const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

export function pointsAutoDeductAvailable(quota: AccountQuotaView | null | undefined): boolean {
  if (channelMissing || typeof window === 'undefined' || typeof window.tangu?.cloudInvoke !== 'function') return false
  return isNum(quota?.pointsBalance) && isNum(quota?.modelMultiplierCap)
}

export type PointsAutoDeductResult =
  | { ok: true; quota: AccountQuotaView }
  /** unavailable = 服务端明确说暂不可用(503 points_fallback_unavailable / 老服务端 410 auto_deduct_removed);
   *  unknown = 确定不了服务端状态(status 0、超时、调用抛错、其余 5xx、200 却没 success),服务端可能已经打开了 ——
   *  调用方别当成「没开」,重读额度视图以服务端为准;
   *  no-bridge = 扩展没有这条通道;failed = 其余失败,detail 是服务端给的说明(可能为空)。 */
  | { ok: false; reason: 'unavailable' | 'unknown' | 'no-bridge' | 'failed'; detail?: string }

const NO_HANDLER = /no handler|not a forsion extend channel/i

/** 写开关。成功时返回合并后的额度视图(回包不含 resetCards / pointsBalance,沿用 prev 的值)。 */
export async function setPointsAutoDeduct(enabled: boolean, prev: AccountQuotaView | null): Promise<PointsAutoDeductResult> {
  const invoke = typeof window !== 'undefined' ? window.tangu?.cloudInvoke : undefined
  if (typeof invoke !== 'function' || channelMissing) return { ok: false, reason: 'no-bridge' }
  let response: { status?: number; json?: any } | null
  beginPointsWrite() // 在这之前发出的读取都算旧的
  try {
    response = await invoke(POINTS_AUTO_DEDUCT_CHANNEL, enabled) as { status?: number; json?: any } | null
  } catch (error: any) {
    if (NO_HANDLER.test(String(error?.message || error))) { channelMissing = true; return { ok: false, reason: 'no-bridge' } }
    return { ok: false, reason: 'unknown' }
  }
  const status = Number(response?.status) || 0
  const json = response?.json
  if (status === 200 && json?.success && typeof json.pointsAutoDeduct === 'boolean') {
    // 按回包显示,不按点的是什么
    confirmPointsWrite(json.pointsAutoDeduct)
    return { ok: true, quota: mergeQuotaView(prev, json.quota, { pointsAutoDeduct: json.pointsAutoDeduct }) }
  }
  if ((status === 503 && json?.error === 'points_fallback_unavailable') || (status === 410 && json?.error === 'auto_deduct_removed')) {
    return { ok: false, reason: 'unavailable' }
  }
  // 明确被拒的 4xx(400 invalid_request 等):服务端没改,回到原状
  if (status >= 400 && status < 500) return { ok: false, reason: 'failed', detail: typeof json?.detail === 'string' ? json.detail : undefined }
  return { ok: false, reason: 'unknown' }
}
