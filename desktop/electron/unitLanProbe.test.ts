/**
 * LAN 直连探针:把对方 /unit/meta 里的名册 id 原样带回、认出「应答的就是本机」;其余照旧(没探通 / 不是 Unit = null)。
 * 跑法:npx vitest run electron/unitLanProbe.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { probeUnitLan } from './unitLanProbe'

const answer = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body }) as unknown as typeof fetch

describe('probeUnitLan', () => {
  it('passes the responder roster id through and asks /unit/meta on that address', async () => {
    const f = answer({ instanceId: 'inst-b', name: 'MacBook-Pro.local', unitId: 'live', version: '2.14.0' })
    expect(await probeUnitLan('http://192.168.1.8:8791', { fetch: f, selfInstanceId: 'inst-a' })).toEqual({ instanceId: 'inst-b', name: 'MacBook-Pro.local', unitId: 'live' })
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe('http://192.168.1.8:8791/unit/meta')
  })

  it('an older Forsion (no unitId) or an empty / non-string id → the key is left out (unknown)', async () => {
    for (const unitId of [undefined, null, '', 42]) {
      const r = await probeUnitLan('http://192.168.1.8:8791', { fetch: answer({ instanceId: 'inst-b', name: 'x', ...(unitId === undefined ? {} : { unitId }) }) })
      expect(r).toEqual({ instanceId: 'inst-b', name: 'x' })
    }
  })

  it('the responder is this very Forsion (same installation id) → self', async () => {
    const r = await probeUnitLan('http://192.168.1.8:8791', { fetch: answer({ instanceId: 'inst-a', name: 'x', unitId: 'me' }), selfInstanceId: 'inst-a' })
    expect(r).toEqual({ instanceId: 'inst-a', name: 'x', unitId: 'me', self: true })
    // 不知道本机实例 id → 不判 self
    expect(await probeUnitLan('http://192.168.1.8:8791', { fetch: answer({ instanceId: 'inst-a', name: 'x' }), selfInstanceId: null })).toEqual({ instanceId: 'inst-a', name: 'x' })
  })

  it('not a Unit / not reachable / not http → null', async () => {
    expect(await probeUnitLan('http://192.168.1.8:8791', { fetch: answer({ name: 'x' }) })).toBeNull()
    expect(await probeUnitLan('http://192.168.1.8:8791', { fetch: answer({ instanceId: 'i' }, false) })).toBeNull()
    expect(await probeUnitLan('http://192.168.1.8:8791', { fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch })).toBeNull()
    expect(await probeUnitLan('file:///etc/passwd', { fetch: answer({ instanceId: 'i' }) })).toBeNull()
    expect(await probeUnitLan('not a url', { fetch: answer({ instanceId: 'i' }) })).toBeNull()
  })
})
