/**
 * Forsion 托管额度在账号菜单、Chat View 提示条和 run 收尾检查之间的轻量同步接缝。
 * token 始终留在宿主；渲染层只接收 `/api/token-quota/my` 的视图结果。
 */

export interface AccountQuotaView {
  dailyLimit: number
  dailyUsed?: number
  dailyRemaining?: number
  dailyPercent?: number
  weeklyLimit: number
  weeklyUsed?: number
  weeklyRemaining?: number
  weeklyPercent?: number
  weeklyResetAt?: string
  resetCards?: number
  pointsAutoDeduct?: boolean
}

export type QuotaAdvisory = {
  period: 'daily' | 'weekly'
  /** 未取整的剩余百分比，用于准确跨越 15 / 10 / 5 / 0 阈值。 */
  remainingPercent: number
  /** 0 是耗尽态；其余值是当前所在的提醒档位。 */
  threshold: 0 | 5 | 10 | 15
  exhausted: boolean
  critical: boolean
}

export const ACCOUNT_QUOTA_EVENT = 'tangu:account-quota'

/** 同步所有已挂载的账号额度 UI；只传无凭证的服务端视图。 */
export function publishAccountQuota(quota: AccountQuotaView | null): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<AccountQuotaView | null>(ACCOUNT_QUOTA_EVENT, { detail: quota }))
}

export function subscribeAccountQuota(listener: (quota: AccountQuotaView | null) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onQuota = (event: Event): void => listener((event as CustomEvent<AccountQuotaView | null>).detail)
  window.addEventListener(ACCOUNT_QUOTA_EVENT, onQuota)
  return () => window.removeEventListener(ACCOUNT_QUOTA_EVENT, onQuota)
}

function remainingPercent(
  limitValue: unknown,
  remainingValue: unknown,
  usedPercentValue: unknown,
): number | null {
  const limit = Number(limitValue)
  if (!Number.isFinite(limit) || limit < 0) return null // -1 = unlimited
  if (limit === 0) return 0
  const remaining = Number(remainingValue)
  if (Number.isFinite(remaining)) return Math.max(0, Math.min(100, (remaining / limit) * 100))
  // 兼容只返回旧 percent 字段的宿主；percent 的语义是「已用」。
  const usedPercent = Number(usedPercentValue)
  if (!Number.isFinite(usedPercent)) return null
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

/**
 * 今日和本周任一周期都会成为真实用量闸；选择剩余比例更低的那一个提醒。
 * 阈值用精确 remaining / limit 判定，不依赖服务端四舍五入后的 used percent。
 */
export function quotaAdvisoryFor(quota: AccountQuotaView | null | undefined): QuotaAdvisory | null {
  if (!quota) return null
  const candidates = [
    { period: 'daily' as const, pct: remainingPercent(quota.dailyLimit, quota.dailyRemaining, quota.dailyPercent) },
    { period: 'weekly' as const, pct: remainingPercent(quota.weeklyLimit, quota.weeklyRemaining, quota.weeklyPercent) },
  ].filter((item): item is { period: 'daily' | 'weekly'; pct: number } => item.pct !== null)
  if (!candidates.length) return null
  candidates.sort((a, b) => a.pct - b.pct)
  const tightest = candidates[0]
  const threshold = tightest.pct <= 0 ? 0
    : tightest.pct <= 5 ? 5
      : tightest.pct <= 10 ? 10
        : tightest.pct <= 15 ? 15
          : null
  if (threshold === null) return null
  return {
    period: tightest.period,
    remainingPercent: tightest.pct,
    threshold,
    exhausted: threshold === 0,
    critical: threshold === 0 || threshold === 5,
  }
}
