import { describe, expect, it } from 'vitest'
import { forsionAccountId } from './forsionAccount'

const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

describe('stable Forsion account identity', () => {
  it('survives token renewal and normalizes equivalent server URLs', () => {
    expect(forsionAccountId('https://CLOUD.test:443/', jwt({ userId: 'u-1', jti: 'old', exp: 1 })))
      .toBe(forsionAccountId('https://cloud.test', jwt({ userId: 'u-1', jti: 'new', exp: 99 })))
  })
  it('separates users, origins, and independently hosted base paths', () => {
    const keys = [
      forsionAccountId('https://a.test', jwt({ userId: 'u-1' })),
      forsionAccountId('https://a.test', jwt({ userId: 'u-2' })),
      forsionAccountId('https://b.test', jwt({ userId: 'u-1' })),
      forsionAccountId('https://a.test/tenant', jwt({ userId: 'u-1' })),
    ]
    expect(new Set(keys).size).toBe(4)
  })
  it('supports sub and UTF-8 identities, while refusing an unknown account', () => {
    expect(forsionAccountId('https://a.test', jwt({ sub: '用户一' }))).toBe('https://a.test::用户一')
    expect(forsionAccountId('https://a.test', jwt({ username: 'alice' }))).toBeNull()
    expect(forsionAccountId('https://a.test', 'broken')).toBeNull()
    expect(forsionAccountId('file:///cloud', jwt({ userId: 'u-1' }))).toBeNull()
  })
})
