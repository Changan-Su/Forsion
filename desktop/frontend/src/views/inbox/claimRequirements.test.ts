import { describe, expect, it } from 'vitest'
import { hasUnknownRequirement, tierFromAuth, unmetClaimRequirements as unmet } from './claimRequirements'

describe('收件箱领取条件本地预判', () => {
  it('版本按数字段比(2.10 > 2.9)', () => {
    expect(unmet({ minVersion: '2.10.0' }, { version: '2.9.9', tier: null })).toEqual(['minVersion'])
    expect(unmet({ minVersion: '2.10.0' }, { version: '2.10.1', tier: null })).toEqual([])
  })
  it('会员档位不知道(null / undefined)就不拦,知道了才判', () => {
    const r = { tiers: ['plus', 'pro'] }
    expect(unmet(r, { version: '2.10.1', tier: null })).toEqual([])
    expect(unmet(r, { version: '2.10.1', tier: undefined })).toEqual([])
    expect(unmet(r, { version: '2.10.1', tier: 'free' })).toEqual(['tiers'])
    expect(unmet(r, { version: '2.10.1', tier: 'pro' })).toEqual([])
    expect(unmet({ minVersion: '3.0.0', ...r }, { version: '2.10.1', tier: 'free' })).toEqual(['minVersion', 'tiers'])
  })
  it('会员档位只认现拉成功的(tokenValid === true);离线时回的缓存资料 / 未登录 = 不知道', () => {
    expect(tierFromAuth({ loggedIn: true, tokenValid: true, membershipTier: 'free' })).toBe('free')
    expect(tierFromAuth({ loggedIn: true, tokenValid: true, membershipTier: 'plus' })).toBe('plus')
    expect(tierFromAuth({ loggedIn: true, tokenValid: null, membershipTier: 'free' })).toBeNull() // 缓存的开会员前旧档位
    expect(tierFromAuth({ loggedIn: false, tokenValid: null, membershipTier: null })).toBeNull()
    expect(tierFromAuth(null)).toBeNull()
  })
  it('服务端新加的条件键 → 另有条件', () => {
    expect(hasUnknownRequirement({ minVersion: '1.0.0', tiers: ['pro'] })).toBe(false)
    expect(hasUnknownRequirement({ minVersion: '1.0.0', minLevel: 3 })).toBe(true)
  })
})
