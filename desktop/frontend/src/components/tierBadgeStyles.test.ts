// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { badgeFor, badgeLabel, badgesFromPlans, DEFAULT_BADGES, loadTierBadges, resetTierBadgesForTest } from './tierBadgeStyles'

const plan = (tier: string, priceMonthly: number, from: string) => ({ tier, priceMonthly, badge: { from, to: '#000000', text: '#FFFFFF' } })

afterEach(() => { resetTierBadgesForTest(); localStorage.clear(); delete (window as any).tangu })

describe('tierBadgeStyles', () => {
  it('同档位取月价最低的方案,非法颜色丢掉', () => {
    const out = badgesFromPlans([plan('pro', 199, '#222222'), plan('pro', 99, '#111111'), plan('max', 199, 'red'), { tier: 'ultra' }])
    expect(out).toEqual({ pro: { from: '#111111', to: '#000000', text: '#FFFFFF' } })
    expect(badgesFromPlans({ plans: [] })).toEqual({})
  })

  it('没拉到配置用内置缺省,Max / Ultra 不再落成 Plus 的橙色', () => {
    expect(badgeFor('max')).toEqual(DEFAULT_BADGES.max)
    expect(badgeFor('ultra')).not.toEqual(DEFAULT_BADGES.plus)
    expect(badgeFor('team').from).toBe('#6B7280')
  })

  it('拉到配置后覆盖缺省并写缓存;接口失败不清掉', async () => {
    const cloudFetch = vi.fn().mockResolvedValue({ status: 200, json: [plan('plus', 29.9, '#ABCDEF')] })
    ;(window as any).tangu = { cloudFetch }
    await loadTierBadges()
    await loadTierBadges()
    expect(cloudFetch).toHaveBeenCalledTimes(1)
    expect(badgeFor('plus').from).toBe('#ABCDEF')
    expect(JSON.parse(localStorage.getItem('forsion_tier_badges')!).plus.from).toBe('#ABCDEF')
    resetTierBadgesForTest()
    ;(window as any).tangu = { cloudFetch: vi.fn().mockResolvedValue({ status: 500 }) }
    await loadTierBadges()
    expect(badgeFor('plus')).toEqual(DEFAULT_BADGES.plus)
  })

  it('路径不带 /api(桥会补);失败后能重试;成功的空列表清回缺省', async () => {
    const cloudFetch = vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValueOnce({ status: 200, json: [plan('pro', 99, '#123456')] }).mockResolvedValueOnce({ status: 200, json: [] })
    ;(window as any).tangu = { cloudFetch }
    await loadTierBadges()
    expect(cloudFetch.mock.calls[0][0].path).toBe('/membership/plans')
    await loadTierBadges()
    expect(badgeFor('pro').from).toBe('#123456')
    resetTierBadgesForTest()
    await loadTierBadges()
    expect(badgeFor('pro')).toEqual(DEFAULT_BADGES.pro)
    expect(JSON.parse(localStorage.getItem('forsion_tier_badges')!)).toEqual({})
  })

  it('徽章文字跟界面语言取方案名:英文缺了回落中文 / 通用名,都没有显示档位键;名字进缓存', async () => {
    ;(window as any).tangu = { cloudFetch: vi.fn().mockResolvedValue({ status: 200, json: [{ ...plan('pro', 99, '#123456'), name: '专业版', nameEn: 'Pro' }, { ...plan('max', 199, '#654321'), name: ' 旗舰 ', nameEn: '' }] }) }
    await loadTierBadges()
    expect(badgeLabel('pro', badgeFor('pro'), 'zh')).toBe('专业版')
    expect(badgeLabel('pro', badgeFor('pro'), 'en')).toBe('Pro')
    expect(badgeLabel('max', badgeFor('max'), 'en')).toBe('旗舰')
    expect(badgeLabel('ultra', badgeFor('ultra'), 'zh')).toBe('ultra')
    expect(JSON.parse(localStorage.getItem('forsion_tier_badges')!).pro).toMatchObject({ name: '专业版', nameEn: 'Pro' })
  })

  it('同档位多个方案:配色取最便宜的,名字不带(不知道用户买的是哪个),显示档位键', () => {
    const out = badgesFromPlans([{ ...plan('pro', 99, '#111111'), name: 'Pro 基础' }, { ...plan('pro', 199, '#222222'), name: 'Pro 全量' }])
    expect(out.pro).toEqual({ from: '#111111', to: '#000000', text: '#FFFFFF' })
    expect(badgeLabel('pro', out.pro, 'zh')).toBe('pro')
  })

  it('网页版没有 cloudFetch:走 webShim 的 membershipPlans', async () => {
    const membershipPlans = vi.fn().mockResolvedValue({ status: 200, json: [{ ...plan('pro', 99, '#123456'), name: '专业版' }] })
    ;(window as any).tangu = { membershipPlans }
    await loadTierBadges()
    expect(membershipPlans).toHaveBeenCalledTimes(1)
    expect(badgeLabel('pro', badgeFor('pro'), 'zh')).toBe('专业版')
  })
})

