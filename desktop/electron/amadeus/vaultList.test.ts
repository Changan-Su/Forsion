import { describe, expect, it } from 'vitest'
import { forgetPatch, normalizeLocal, pluginVaultRows, switchPatch, syncVaultRoot, vaultDirName, vaultList } from './vaultList'

const A = '/u/Forsion/Amadeus', B = '/u/Forsion/Vaults/Work', C = '/u/Notes'

describe('vaultList', () => {
  it('derives the list from localVault on old configs and keeps sync on it', () => {
    const cfg = { lastVault: A, localVault: A, lastPage: 'a.md' }
    expect(vaultList(cfg)).toEqual([{ root: A }])
    expect(syncVaultRoot(cfg)).toBe(A)
  })

  it('first switch pins sync to the old vault and remembers its page', () => {
    const p = switchPatch({ lastVault: A, localVault: A, lastPage: 'a.md' }, B)
    expect(p).toEqual({ vaults: [{ root: A, lastPage: 'a.md' }, { root: B }], syncVault: A, localVault: B, lastVault: B, lastPage: undefined })
    expect(syncVaultRoot(p)).toBe(A)
  })

  it('switching back restores the page and never moves the sync pin', () => {
    const cfg = { lastVault: B, localVault: B, lastPage: 'b.md', syncVault: A, vaults: [{ root: A, lastPage: 'a.md' }, { root: B }] }
    const p = switchPatch(cfg, A)
    expect(p.lastPage).toBe('a.md')
    expect(p.syncVault).toBeUndefined() // already pinned: patch leaves it alone
    expect(p.vaults).toEqual([{ root: A, lastPage: 'a.md' }, { root: B, lastPage: 'b.md' }])
  })

  it('from the cloud side the cloud page is not saved onto the local vault', () => {
    const p = switchPatch({ lastVault: '/cloud', localVault: A, lastPage: 'cloud.md', vaults: [{ root: A, lastPage: 'a.md' }] }, C)
    expect(p.vaults[0]).toEqual({ root: A, lastPage: 'a.md' })
    expect(p.syncVault).toBe(A)
  })

  it('configs with only lastVault still pin sync to it; a lone cloud mirror is never adopted', () => {
    const p = switchPatch(normalizeLocal({ lastVault: C }, () => false), B)
    expect(syncVaultRoot(p)).toBe(C)
    expect(p.vaults.map((v) => v.root)).toEqual([C, B])
    const cloud = { lastVault: '/cloud' }
    expect(normalizeLocal(cloud, (r) => r === '/cloud')).toBe(cloud)
    expect(switchPatch(normalizeLocal(cloud, (r) => r === '/cloud'), B).syncVault).toBeUndefined()
  })

  it('refuses to forget the open vault or the sync vault', () => {
    const cfg = { localVault: B, syncVault: A, vaults: [{ root: A }, { root: B }, { root: C }] }
    expect(forgetPatch(cfg, A)).toBeNull()
    expect(forgetPatch(cfg, B)).toBeNull()
    expect(forgetPatch(cfg, C)).toEqual({ vaults: [{ root: A }, { root: B }] })
  })

  it('plugin rows: the menu list plus the mounted root, cloud mirror flagged, current follows the mounted root', () => {
    const isCloud = (r: string): boolean => r.startsWith('/h/.forsion/Amadeus Accounts/')
    const cfg = { localVault: B, lastVault: B, syncVault: A, vaults: [{ root: A }, { root: B }, { root: C }] }
    expect(pluginVaultRows(cfg, B, isCloud)).toEqual([
      { root: A, name: 'Amadeus', current: false, cloud: false },
      { root: B, name: 'Work', current: true, cloud: false },
      { root: C, name: 'Notes', current: false, cloud: false },
    ])
    // 云端模式:挂着的是云端镜像(不在 vaults 里)→ 补一行 cloud,本地的 localVault 不再标 current
    const mirror = '/h/.forsion/Amadeus Accounts/abc/Cloud'
    const rows = pluginVaultRows({ ...cfg, lastVault: mirror }, mirror, isCloud)
    expect(rows.filter((r) => r.current)).toEqual([{ root: mirror, name: 'Cloud', current: true, cloud: true }])
    expect(rows.map((r) => r.root)).toEqual([A, B, C, mirror])
    // 清单里残留的旧账号镜像:没挂着就不给插件(同菜单的过滤);挂着时才以 cloud 行出现
    const stale = '/h/.forsion/Amadeus Accounts/old/Cloud'
    const withStale = { ...cfg, vaults: [...cfg.vaults, { root: stale }] }
    expect(pluginVaultRows(withStale, B, isCloud).map((r) => r.root)).toEqual([A, B, C])
    expect(pluginVaultRows(withStale, stale, isCloud).filter((r) => r.cloud)).toEqual([{ root: stale, name: 'Cloud', current: true, cloud: true }])
    // 没开库:都不是 current,也不凭空补行
    expect(pluginVaultRows(cfg, null, isCloud).some((r) => r.current)).toBe(false)
    expect(pluginVaultRows(cfg, null, isCloud)).toHaveLength(3)
    // 真的一个库都没有 → []
    expect(pluginVaultRows({}, null, isCloud)).toEqual([])
  })

  it('accepts one plain folder name only', () => {
    expect(vaultDirName('  工作 ')).toBe('工作')
    for (const bad of ['', '.hidden', 'a/b', 'a\\b', 'x:y', 1]) expect(vaultDirName(bad)).toBeNull()
  })
})
