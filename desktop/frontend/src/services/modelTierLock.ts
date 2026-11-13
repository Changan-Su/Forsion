/**
 * 模型倍率门槛(2026-11-13):每档会员只能用倍率不高于上限的 Forsion 云端模型,严格大于才用不了。
 * 上限来自额度视图的 modelMultiplierCap(-1 = 不限)。拿不到(没登录 / 老扩展 / 旧服务端 / 读失败)= 不知道,
 * 一个都不标 —— 读失败不能把整张模型表锁死。用户自己接的模型没有 multiplier,天然不受影响。
 */
import { registerMessages } from '../i18n'
import { useAccountQuota } from './useAccountQuota'
import type { AccountQuotaView } from './accountQuota'

/** 有效上限;null = 不知道或不限,两者都不标锁。 */
export function modelMultiplierCapOf(quota: AccountQuotaView | null | undefined): number | null {
  const cap = quota?.modelMultiplierCap
  return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? cap : null
}

export function isModelTierLocked(
  model: { multiplier?: number | null; source?: string } | null | undefined,
  cap: number | null | undefined,
): boolean {
  if (!model || typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) return false
  if (model.source && model.source !== 'forsion') return false
  return typeof model.multiplier === 'number' && Number.isFinite(model.multiplier) && model.multiplier > cap
}

/** 模型选择器读上限:订阅额度广播(用卡 / 登出 / 切号后别处刷新),没登录或读失败 = null。 */
export function useModelMultiplierCap(enabled = true): number | null {
  return modelMultiplierCapOf(useAccountQuota(enabled))
}

registerMessages({
  'chat.err.tierLocked': { zh: '当前会员档位不能使用 {model}。升级会员或换一个模型。', en: "Your current plan can't use {model}. Upgrade your membership or pick another model." },
  'chat.err.tierLockedBare': { zh: '当前会员档位不能使用这个模型。升级会员或换一个模型。', en: "Your current plan can't use this model. Upgrade your membership or pick another model." },
  'chat.err.upgrade': { zh: '升级会员', en: 'Upgrade membership' },
})

/**
 * 服务端拦下用不了的模型:主链路 SSE `{ t:'error', status:403, message:'model_tier_locked', detail }`,引擎把它变成 run 错误串
 * `model_tier_locked`;HTTP 403 那条路(非流式 / 补全)到这里是整段 JSON 回包。两种都不锚定地认这个码。
 */
export const TIER_LOCKED_RE = /model_tier_locked/i

export function isTierLockedError(raw: string | null | undefined): boolean {
  return !!raw && TIER_LOCKED_RE.test(raw)
}

/** 回包里带了 modelName 就用它(HTTP 403 的 JSON);只有裸码时返回 ''。 */
export function tierLockedModelName(raw: string): string {
  const start = raw.indexOf('{')
  if (start < 0) return ''
  try {
    const body = JSON.parse(raw.slice(start))
    const name = body?.modelName ?? body?.detail?.modelName
    return typeof name === 'string' ? name.trim() : ''
  } catch { return '' }
}

/** 人话:有模型名说名字,没有就说「这个模型」。fallbackName = 调用方按会话模型查到的显示名。 */
export function tierLockedText(raw: string, t: (key: string, vars?: Record<string, string>) => string, fallbackName = ''): string {
  const model = tierLockedModelName(raw) || fallbackName
  return model ? t('chat.err.tierLocked', { model }) : t('chat.err.tierLockedBare')
}
