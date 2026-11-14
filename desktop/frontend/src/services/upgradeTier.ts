/**
 * 被倍率门槛锁住的模型「要升到哪一档才能用」。
 * 数据来自公开的 GET /api/payment/offerings:每个付费方案带 perks.modelMultiplierCap(买这个方案能用的倍率上限,-1 = 不限;
 * 服务端按「方案里填的 → 档位缺省」算好)。Free 不在里面,也不需要:锁住的模型不会「升到 Free」就能用。
 * 后台能改各方案的上限,所以这里不写死任何数字,一律按接口算;拿不到 / 旧服务端没有 perks / 算不出 → null,调用方回落成「升级后可用」。
 * 桌面 / Android 经 cloudFetch、网页版 / Unit 网页经 shim 专开的 membershipOfferings,一个会话拉一次(失败下次再试)。
 */
import { useCallback, useSyncExternalStore } from 'react'

/** 档位从低到高。服务端没有排序常量(方案按 sort_order 排,那是展示顺序),档位键是固定的这几个;认不出的档位不参与推荐。 */
const TIER_ORDER = ['free', 'plus', 'pro', 'max', 'ultra'] as const

export interface UpgradeTier {
  tier: string
  /** 这一档只有一个方案时带它的中英文名;同档多个方案不带名字(同会员徽章的规矩),显示档位键 */
  name?: string
  nameEn?: string
  /** 这一档所有方案里最低的上限(-1 = 不限):同档每个方案都够用才说「X 起可用」 */
  cap: number
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** offerings 回包 → 各档(从低到高)。回包不对、或有方案缺数值上限(旧服务端)= 不知道,回 null,别当空列表。 */
export function upgradeTiersFromOfferings(json: unknown): UpgradeTier[] | null {
  const plans = (json as { membershipPlans?: unknown } | null)?.membershipPlans
  if (!Array.isArray(plans)) return null
  const byTier = new Map<string, { caps: number[]; plans: Array<{ name?: string; nameEn?: string }> }>()
  for (const p of plans) {
    const tier = typeof p?.tier === 'string' ? p.tier.toLowerCase() : ''
    const cap = p?.perks?.modelMultiplierCap
    if (typeof cap !== 'number' || !Number.isFinite(cap)) return null
    if (!(TIER_ORDER as readonly string[]).includes(tier)) continue
    const entry = byTier.get(tier) || { caps: [], plans: [] }
    entry.caps.push(cap)
    entry.plans.push({ name: str(p.name), nameEn: str(p.nameEn) })
    byTier.set(tier, entry)
  }
  const out: UpgradeTier[] = []
  for (const tier of TIER_ORDER) {
    const e = byTier.get(tier)
    if (!e) continue
    // 任一方案不限、其余有数 → 取有数里最低的;全都不限才算不限
    const finite = e.caps.filter((c) => c >= 0)
    const cap = finite.length ? Math.min(...finite) : -1
    out.push({ tier, cap, ...(e.plans.length === 1 ? e.plans[0] : {}) })
  }
  return out
}

/** 倍率 m 的模型最低要哪一档:档位最低、且上限不限或 ≥ m(与 isModelTierLocked 的「> 上限才锁」同一口径)。没有 → null。 */
export function minTierForMultiplier(tiers: UpgradeTier[] | null | undefined, multiplier: number | null | undefined): UpgradeTier | null {
  if (!tiers || typeof multiplier !== 'number' || !Number.isFinite(multiplier)) return null
  return tiers.find((t) => t.cap < 0 || multiplier <= t.cap) ?? null
}

/** 档位显示名:英文界面用英文名,没填回落中文 / 通用名,再没有就首字母大写的档位键(同 badgeLabel)。 */
export function upgradeTierLabel(t: UpgradeTier, locale: string): string {
  return (locale === 'en' && t.nameEn) || t.name || t.tier.charAt(0).toUpperCase() + t.tier.slice(1)
}

let tiers: UpgradeTier[] | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

/** 拉一次(一个会话一次);失败不记成已加载,下次挂载再试。 */
export function loadUpgradeTiers(): Promise<void> {
  const t = typeof window !== 'undefined' ? window.tangu : undefined
  const req = t?.cloudFetch ? () => t.cloudFetch!({ path: '/payment/offerings' }) : t?.membershipOfferings ? () => t.membershipOfferings!() : null
  if (!req || tiers || loading) return loading ?? Promise.resolve()
  loading = req().then((r) => {
    const next = r?.status === 200 ? upgradeTiersFromOfferings(r.json) : null
    if (!next) { loading = null; return }
    tiers = next
    listeners.forEach((l) => l())
  }).catch(() => { loading = null })
  return loading
}

/** 各档上限;enabled = false(没有任何锁)时不拉。没拉到 = null。 */
export function useUpgradeTiers(enabled: boolean): UpgradeTier[] | null {
  const subscribe = useCallback((l: () => void) => {
    listeners.add(l)
    if (enabled) void loadUpgradeTiers()
    return () => { listeners.delete(l) }
  }, [enabled])
  return useSyncExternalStore(subscribe, () => tiers)
}

/** 测试用 */
export function resetUpgradeTiersForTest(): void { tiers = null; loading = null }
