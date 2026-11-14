import { describe, expect, it } from 'vitest'
import { minTierForMultiplier, upgradeTierLabel, upgradeTiersFromOfferings } from './upgradeTier'

const plan = (tier: string, cap: number, extra: Record<string, unknown> = {}) => ({ tier, perks: { modelMultiplierCap: cap, topupPayPercent: 90 }, ...extra })

describe('upgradeTiersFromOfferings', () => {
  it('按档位从低到高排,与回包顺序无关;认不出的档位不参与', () => {
    const tiers = upgradeTiersFromOfferings({ membershipPlans: [plan('max', -1), plan('team', 9), plan('plus', 2.5, { name: 'Plus' }), plan('pro', 5)] })
    expect(tiers?.map((t) => t.tier)).toEqual(['plus', 'pro', 'max'])
  })
  it('同档多个方案:上限取最低(每个方案都够用才算),不带方案名', () => {
    const tiers = upgradeTiersFromOfferings({ membershipPlans: [plan('pro', 5, { name: '专业月' }), plan('pro', 3, { name: '专业年' }), plan('pro', -1)] })
    expect(tiers).toEqual([{ tier: 'pro', cap: 3 }])
  })
  it('同档全都不限 = 不限;单个方案带中英文名', () => {
    expect(upgradeTiersFromOfferings({ membershipPlans: [plan('max', -1, { name: '旗舰', nameEn: 'Flagship' })] }))
      .toEqual([{ tier: 'max', cap: -1, name: '旗舰', nameEn: 'Flagship' }])
  })
  it('回包不对 / 旧服务端没有 perks = 不知道(null),不当空列表', () => {
    expect(upgradeTiersFromOfferings(null)).toBeNull()
    expect(upgradeTiersFromOfferings({ packages: [] })).toBeNull()
    expect(upgradeTiersFromOfferings({ membershipPlans: [plan('plus', 2.5), { tier: 'pro' }] })).toBeNull()
  })
})

describe('minTierForMultiplier', () => {
  const tiers = upgradeTiersFromOfferings({ membershipPlans: [plan('plus', 2.5), plan('pro', 5), plan('max', -1), plan('ultra', -1)] })
  it('最低够用的档位;倍率 = 上限算够用(与「> 上限才锁」同口径)', () => {
    expect(minTierForMultiplier(tiers, 2.5)?.tier).toBe('plus')
    expect(minTierForMultiplier(tiers, 3)?.tier).toBe('pro')
    expect(minTierForMultiplier(tiers, 5)?.tier).toBe('pro')
    expect(minTierForMultiplier(tiers, 8)?.tier).toBe('max')
  })
  it('没有档位够用、没拉到方案、模型没倍率 → null(调用方回落「升级后可用」)', () => {
    const capped = upgradeTiersFromOfferings({ membershipPlans: [plan('plus', 2.5), plan('pro', 5)] })
    expect(minTierForMultiplier(capped, 8)).toBeNull()
    expect(minTierForMultiplier(null, 3)).toBeNull()
    expect(minTierForMultiplier(tiers, undefined)).toBeNull()
  })
})

describe('upgradeTierLabel', () => {
  it('英文界面用英文名,没填回落中文 / 通用名,再没有就首字母大写的档位键', () => {
    expect(upgradeTierLabel({ tier: 'pro', cap: 5, name: '专业版', nameEn: 'Pro' }, 'en')).toBe('Pro')
    expect(upgradeTierLabel({ tier: 'pro', cap: 5, name: '专业版', nameEn: 'Pro' }, 'zh')).toBe('专业版')
    expect(upgradeTierLabel({ tier: 'pro', cap: 5, name: 'Pro' }, 'en')).toBe('Pro')
    expect(upgradeTierLabel({ tier: 'max', cap: -1 }, 'zh')).toBe('Max')
  })
})
