/** 登录态滑动续期的判定层:token 年龄/剩余解码 + 该不该换。 */
import { describe, it, expect } from 'vitest'
import { tokenAgeMs, tokenRemainingMs, shouldRefreshToken } from './forsionAuth'

const HOUR = 3600_000
/** 造一枚只有 payload 的假 JWT(这层只解不验签)。 */
const jwt = (claims: Record<string, unknown>): string =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

const now = 1_800_000_000_000
const s = (ms: number): number => Math.floor(ms / 1000)

describe('token 解码', () => {
  it('按 iat/exp 算年龄与剩余', () => {
    const t = jwt({ iat: s(now - 3 * HOUR), exp: s(now + 5 * HOUR) })
    expect(tokenAgeMs(t, now)).toBe(3 * HOUR)
    expect(tokenRemainingMs(t, now)).toBe(5 * HOUR)
  })

  it('坏串/缺 claim:年龄 Infinity(当作老 token 该换)、剩余 Infinity(不为它拖启动)', () => {
    for (const t of ['', 'not-a-jwt', 'a.!!!.c', jwt({})]) {
      expect(tokenAgeMs(t, now)).toBe(Infinity)
      expect(tokenRemainingMs(t, now)).toBe(Infinity)
    }
  })
})

describe('shouldRefreshToken', () => {
  it('1h 内刚换过 → 不换;超过 1h → 换', () => {
    expect(shouldRefreshToken(jwt({ iat: s(now - 59 * 60_000) }), now)).toBe(false)
    expect(shouldRefreshToken(jwt({ iat: s(now - 61 * 60_000) }), now)).toBe(true)
  })

  it('没 token 不换;没有 iat 的老 token 要换(升级到 14d 滑动窗口)', () => {
    expect(shouldRefreshToken('', now)).toBe(false)
    expect(shouldRefreshToken(jwt({ userId: 'u1' }), now)).toBe(true)
  })
})
