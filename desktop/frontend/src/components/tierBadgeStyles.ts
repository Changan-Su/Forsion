/**
 * 会员标识配色与名称:后台按方案配置,随公开的 /api/membership/plans 下发(plan.badge = 生效配色,name / nameEn = 中英文名)。
 * 桌面 / Android 经 cloudFetch、网页版经 webShim 的 membershipPlans 拉一次,缓存进 localStorage(重启首帧直接用上次的,不先画缺省再闪)。DEFAULT_BADGES 与 server/src/services/membershipBadge.ts 逐字一致,改一处要改两处。
 */
import { useSyncExternalStore } from 'react'

export interface BadgeStyle { from: string; to: string; text: string }
/** 徽章 = 配色 + 方案名(中文 / 通用槽与英文槽;没拉到时徽章显示档位键) */
export interface TierBadgeInfo extends BadgeStyle { name?: string; nameEn?: string }

export const DEFAULT_BADGES: Record<string, BadgeStyle> = {
  free: { from: '#E5E7EB', to: '#D1D5DB', text: '#374151' },
  plus: { from: '#F59E0B', to: '#F97316', text: '#FFFFFF' },
  pro: { from: '#8B5CF6', to: '#A855F7', text: '#FFFFFF' },
  max: { from: '#F43F5E', to: '#E11D48', text: '#FFFFFF' },
  ultra: { from: '#71717A', to: '#3F3F46', text: '#FDE68A' },
}
const FALLBACK: BadgeStyle = { from: '#6B7280', to: '#4B5563', text: '#FFFFFF' }
const CACHE_KEY = 'forsion_tier_badges'
const HEX = /^#[0-9a-fA-F]{6}$/

const validBadge = (b: any): b is BadgeStyle => !!b && [b.from, b.to, b.text].every((v) => typeof v === 'string' && HEX.test(v))
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** 方案列表 → 档位徽章;同一档位有多个方案时配色取月价最低那个。
 *  徽章只拿得到档位、不知道用户买的是哪个方案,所以同档位多方案时不带名字(显示档位键),免得写成别的方案名。 */
export function badgesFromPlans(plans: unknown): Record<string, TierBadgeInfo> {
  const out: Record<string, TierBadgeInfo> = {}
  const price: Record<string, number> = {}
  const count: Record<string, number> = {}
  if (!Array.isArray(plans)) return out
  for (const p of plans) {
    const tier = typeof p?.tier === 'string' ? p.tier.toLowerCase() : ''
    if (tier) count[tier] = (count[tier] || 0) + 1
    const monthly = Number(p?.priceMonthly) || 0
    if (!tier || !validBadge(p.badge) || (tier in price && price[tier] <= monthly)) continue
    out[tier] = { from: p.badge.from, to: p.badge.to, text: p.badge.text, name: str(p.name), nameEn: str(p.nameEn) }
    price[tier] = monthly
  }
  for (const tier of Object.keys(out)) if (count[tier] > 1) out[tier] = { from: out[tier].from, to: out[tier].to, text: out[tier].text }
  return out
}

function readCache(): Record<string, TierBadgeInfo> {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
    return Object.fromEntries(Object.entries(raw).filter(([, b]) => validBadge(b))
      .map(([k, b]: [string, any]) => [k, { from: b.from, to: b.to, text: b.text, name: str(b.name), nameEn: str(b.nameEn) }]))
  } catch { return {} }
}

let configured: Record<string, TierBadgeInfo> = typeof localStorage !== 'undefined' ? readCache() : {}
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null

/** 拉一次方案配色(一个会话一次);失败保持上次缓存 / 缺省 */
export function loadTierBadges(): Promise<void> {
  const t = typeof window !== 'undefined' ? window.tangu : undefined
  // 桌面桥会补 /api 前缀(同 achievements);网页版没有通用 cloudFetch,走 webShim 专开的这一条
  const req = t?.cloudFetch ? () => t.cloudFetch!({ path: '/membership/plans' }) : t?.membershipPlans ? () => t.membershipPlans!() : null
  if (!req || loading) return loading ?? Promise.resolve()
  // 失败不记成已加载,下次挂载再试;成功的空列表(方案全停)= 清回缺省
  loading = req().then((r) => {
    if (r?.status !== 200 || !Array.isArray(r.json)) { loading = null; return }
    const next = badgesFromPlans(r.json)
    configured = next
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)) } catch { /* 存不下就只用内存 */ }
    listeners.forEach((l) => l())
  }).catch(() => { loading = null })
  return loading
}

export const badgeFor = (tier: string): TierBadgeInfo => configured[tier] ?? DEFAULT_BADGES[tier] ?? FALLBACK

/** 徽章文字:英文界面用英文名,没填回落中文 / 通用名,都没有显示档位键 */
export const badgeLabel = (tier: string, b: TierBadgeInfo, locale: string): string =>
  (locale === 'en' && b.nameEn) || b.name || tier

export function useTierBadge(tier: string): TierBadgeInfo {
  return useSyncExternalStore((l) => { listeners.add(l); void loadTierBadges(); return () => { listeners.delete(l) } }, () => badgeFor(tier))
}

/** 测试用:清掉内存配置与加载状态 */
export function resetTierBadgesForTest(): void { configured = {}; loading = null }
