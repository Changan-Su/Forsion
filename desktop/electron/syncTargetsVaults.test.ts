/**
 * 智库同步第 3 步 H3 12a(「H3 接口定稿」第 4 节):CloudHost.syncTargets.vaults() 和菜单的 listVaults 同一口径。
 * 只有 lastVault、没有 localVault / vaults[] 的老配置不再回 []（Extend 的重叠检查会漏掉这个库）;托管云镜像照旧不列;realpath 去重。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ root: '', cfg: {} as Record<string, unknown> }))
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./amadeus/settings', () => ({ readConfig: async () => structuredClone(env.cfg) }))
vi.mock('./amadeus/cloudPaths', () => ({
  cloudVaultDir: () => join(env.root, 'mirror'),
  isManagedCloudVault: (root: string) => root === join(env.root, 'mirror') || root.startsWith(join(env.root, 'mirror') + '/'),
}))
vi.mock('./remotesyncIpc', () => ({
  legacyRemoteSync: { touch: async () => {} },
  cancelTargetAuth: () => {}, finishTargetAuth: () => {}, startTargetAuth: () => {}, takeTargetAuthTicket: () => null,
  remoteSyncNet: {}, syncTargetsStore: { read: async () => ({ targets: {} }) },
}))
vi.mock('./remotesync/targetFs', () => ({ openTargetFs: () => { throw new Error('not in this test') } }))
vi.mock('./remotesync/fsS3', () => ({ normPrefix: (s: string) => s }))

import { createSyncTargets } from './syncTargets'

beforeEach(() => {
  env.root = realpathSync(mkdtempSync(join(tmpdir(), 'forsion-target-vaults-')))
  for (const d of ['Vault', 'Notes', 'mirror']) mkdirSync(join(env.root, d))
})
afterEach(() => rmSync(env.root, { recursive: true, force: true }))

describe('syncTargets.vaults()', () => {
  it('an old config with only lastVault lists that vault', async () => {
    env.cfg = { lastVault: join(env.root, 'Vault') }
    expect(await createSyncTargets().vaults()).toEqual([{ root: join(env.root, 'Vault'), name: 'Vault' }])
  })

  it('a lastVault on the managed mirror is still left out; vaults[] + localVault are listed once each by real path', async () => {
    env.cfg = { lastVault: join(env.root, 'mirror') }
    expect(await createSyncTargets().vaults()).toEqual([])
    symlinkSync(join(env.root, 'Notes'), join(env.root, 'notes-link'))
    env.cfg = {
      lastVault: join(env.root, 'mirror'), localVault: join(env.root, 'Vault'),
      vaults: [{ root: join(env.root, 'notes-link') }, { root: join(env.root, 'Notes') }, { root: join(env.root, 'mirror') }, { root: join(env.root, 'Gone') }],
    }
    expect(await createSyncTargets().vaults()).toEqual([
      { root: join(env.root, 'Notes'), name: 'Notes' },
      { root: join(env.root, 'Vault'), name: 'Vault' },
    ])
  })
})
