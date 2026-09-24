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
  /** 后台额度(Muse / 自动化;2026-09-24 起服务端才下发,旧服务端无此字段)。 */
  background?: BackgroundQuotaView
}

/**
 * 后台额度:主额度之外额外一桶(限额 × sharePercent + 本期从主额度转入的量),只收「后台智能体 × 云端默认后台模型」的用量。
 * 字段口径同主额度:-1 = 不限,percent = 已用百分比。modelId = 计入的那个模型;null = 服务端没配,桶不生效。
 */
export interface BackgroundQuotaView {
  sharePercent?: number
  dailyLimit: number
  dailyUsed?: number
  dailyRemaining?: number
  dailyPercent?: number
  weeklyLimit: number
  weeklyUsed?: number
  weeklyRemaining?: number
  weeklyPercent?: number
  /** 用尽后改用主额度继续(缺省 false = Muse / 自动化暂停) */
  autoMain?: boolean
  modelId?: string | null
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

/**
 * 后台额度提醒:桶生效(有计入模型)且本期真的用过才提醒 —— 从没让 Muse 跑过云端默认模型的人,
 * 不该被一条「后台额度已用尽」吓到(份额被 admin 调成 0 时上限就是 0)。
 */
export function backgroundAdvisoryFor(quota: AccountQuotaView | null | undefined): QuotaAdvisory | null {
  const bg = quota?.background
  if (!bg?.modelId) return null
  if (!(Number(bg.dailyUsed) > 0 || Number(bg.weeklyUsed) > 0)) return null
  return quotaAdvisoryFor(bg)
}

/** 聊天框只有一个提醒位:剩余比例更低的那条赢,打平时主额度优先(那是用户自己的对话)。 */
export function pickQuotaAdvisory(
  main: QuotaAdvisory | null,
  background: QuotaAdvisory | null,
): { advisory: QuotaAdvisory; bucket: 'main' | 'background' } | null {
  if (main && (!background || main.remainingPercent <= background.remainingPercent)) return { advisory: main, bucket: 'main' }
  return background ? { advisory: background, bucket: 'background' } : null
}
