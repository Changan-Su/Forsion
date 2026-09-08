import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setContentStorageScope, contentStorageKey } from '@lcl/engine/contentStorageScope'
import { createCloudAmadeusBridge } from '../../../../web/src/amadeus/cloudBridge'
import { installCloudCollab } from '../../../../web/src/amadeus/cloudCollab'

vi.mock('../../../../web/src/amadeus/cloudEvents', () => ({ startCloudEvents: () => () => {} }))

const jwt = (userId: string) => `header.${btoa(JSON.stringify({ userId }))}.signature`
beforeEach(() => {
  vi.useFakeTimers()
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('location', { origin: 'https://cloud.test', reload: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const token = (init?.headers as Record<string, string>)?.Authorization?.slice(7)
    const account = token === jwt('a') ? 'a' : 'b'
    const url = new URL(input)
    let data: unknown = {}
    if (url.pathname.endsWith('/vaults')) data = { vaults: [{ id: `${account}-vault` }] }
    else if (url.pathname.endsWith('/tree')) data = { pages: [`${account}-private.md`], files: [], folders: [], seq: 1 }
    else if (url.pathname.endsWith('/file')) data = { path: url.searchParams.get('path'), content: `# ${account} private note`, seq: 1, hash: 'hash' }
    else if (url.pathname.endsWith('/asset-token')) data = { token: 'asset-token', ttlSec: 600 }
    else if (url.pathname.endsWith('/link-base')) data = { webOrigin: 'https://cloud.test' }
    return new Response(JSON.stringify(data))
  }))
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('cloud bridge account caches', () => {
  it('captures tree, last page, and active vault keys before another account becomes active', async () => {
    const open = (account: string) => {
      setContentStorageScope(`https://cloud.test/api::${account}`)
      const cfg = { apiBase: 'https://cloud.test/api', getToken: () => jwt(account), onAuthError: vi.fn() }
      const bridge = createCloudAmadeusBridge(cfg)
      installCloudCollab(cfg)
      return { bridge, collab: window.amadeusCollab!, treeKey: contentStorageKey('amadeus_tree_snap'), vaultKey: contentStorageKey('amadeus.cloudVaultId') }
    }
    const a = open('a')
    await a.bridge.listPages()
    await a.bridge.loadPage('a-private.md')
    a.collab.switchVault('a-vault')
    const b = open('b')
    expect(localStorage.getItem(b.treeKey)).toBeNull()
    expect(localStorage.getItem(b.vaultKey)).toBeNull()
    await b.bridge.restoreVault()
    await b.bridge.loadPage('b-private.md')
    b.collab.switchVault('b-vault')

    // The old bridge's cached-page callback and old collab UI may still run after B starts.
    await a.bridge.loadPage('a-private.md')
    a.collab.switchVault('a-vault')
    expect(localStorage.getItem(b.vaultKey)).toBe('b-vault')
    expect(JSON.parse(localStorage.getItem(b.treeKey)!)).toMatchObject({ v: 'b-vault', tree: { pages: ['b-private.md'] } })
    const returningB = open('b')
    await expect(returningB.bridge.restoreVault()).resolves.toMatchObject({ root: 'cloud://b-vault', pages: ['b-private.md'], lastPage: 'b-private.md' })
    const returningA = open('a')
    await expect(returningA.bridge.restoreVault()).resolves.toMatchObject({ root: 'cloud://a-vault', pages: ['a-private.md'], lastPage: 'a-private.md' })
  })
})
