import { afterEach, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ creds: {} as { cloudUrl: string; token: string } }))
vi.mock('../../forsionAuth', () => ({ loadTanguCreds: () => env.creds }))
const token = (userId: string) => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.x`
afterEach(() => vi.unstubAllGlobals())
it('an existing collaboration session never reuses A’s vault with B’s credentials', async () => {
  env.creds = { cloudUrl: 'https://cloud.example', token: token('A') }
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    requests.push(init.headers.Authorization)
    return { ok: true, json: async () => ({ vaults: [{ id: 'vault-a' }] }) }
  }))
  const { createCollabMain } = await import('./collabMain')
  const collab = createCollabMain()
  expect(await collab.ensureOwnVault()).toBe('vault-a')
  env.creds = { cloudUrl: 'https://cloud.example', token: token('B') }
  await expect(collab.ensureOwnVault()).rejects.toThrow()
  await expect(collab.call('POST', '/vaults/vault-a/presence', {})).rejects.toThrow()
  expect(requests).toHaveLength(1)
})
