/**
 * 账号边界 —— 宿主那半(引擎那半 2026-09-28 随云同步搬进 @forsion/extend:test/vitest/amadeusCloud.account.test.ts):
 * 冷启动绝不把无主的旧云镜像当本地库挂上;第三方远程同步拒绝任何云镜像当同步根;没装 Extend 时哪怕 lastVault 是当前账号的云根也不挂
 * (本机没有同步引擎,镜像只是一堆过期文件)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  root: '', creds: {} as { cloudUrl?: string; token?: string },
  handlers: new Map<string, (...args: any[]) => any>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => path.join(env.root, 'app-data'), defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => env.creds }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))
const token = (userId: string) => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.x`
const login = (userId: string) => { env.creds = { cloudUrl: 'https://cloud.example', token: token(userId) } }
const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)
beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-ipc-account-'))
  env.handlers.clear()
  login('A')
})
afterEach(async () => { await fs.rm(env.root, { recursive: true, force: true }) })

it('cold boot never adopts an unowned legacy cloud mirror as the local vault', async () => {
  const oldMirror = path.join(env.root, 'app-data', 'Amadeus Cloud')
  await fs.mkdir(oldMirror, { recursive: true })
  await fs.writeFile(path.join(oldMirror, 'LegacyPrivate.md'), 'old account private offline note')
  await fs.writeFile(path.join(env.root, 'amadeus-config.json'), JSON.stringify({
    lastVault: oldMirror, cloudSync: { vaultId: 'vault-A' },
    entrySync: [{ vaultRoot: oldMirror, cloudName: 'Old', entries: [{ path: 'LegacyPrivate.md', kind: 'page' }] }],
  }))
  env.creds = {}
  const { registerIpc } = await import('./ipc')
  const { IPC } = await import('@amadeus-shared/ipc')
  registerIpc(() => null)
  const restored = await invoke(IPC.restoreVault)
  expect(restored.root).toBe(path.join(env.root, 'workspace', 'Amadeus'))
  expect(restored.pages).not.toContain('LegacyPrivate.md')
  expect(await fs.readFile(path.join(oldMirror, 'LegacyPrivate.md'), 'utf8')).toBe('old account private offline note')
  // 旧顶层绑定被隔离进 legacyCloudState,不进任何账号
  const stored = JSON.parse(await fs.readFile(path.join(env.root, 'amadeus-config.json'), 'utf8'))
  expect(stored.entrySync).toBeUndefined()
  expect(stored.legacyCloudState?.entrySync?.[0]?.cloudName).toBe('Old')
})

it('without the Extend sync factory a saved cloud root of the current account is not mounted either', async () => {
  const { cloudVaultDir } = await import('./cloudPaths')
  const { writeConfig } = await import('./settings')
  const mirror = cloudVaultDir()
  await fs.mkdir(mirror, { recursive: true })
  await fs.writeFile(path.join(mirror, 'Stale.md'), 'mirror without an engine')
  const local = path.join(env.root, 'my-local-notes')
  await fs.mkdir(local)
  await writeConfig({ lastVault: mirror, localVault: local })
  const { registerIpc } = await import('./ipc')
  const { IPC } = await import('@amadeus-shared/ipc')
  const runtime = registerIpc(() => null) // 没递工厂 = 没装 Extend
  const restored = await invoke(IPC.restoreVault)
  expect(restored.root).toBe(local)
  expect(runtime.getVaultRoot()).toBe(local)
  await expect(runtime.stopSync()).resolves.toBeUndefined()
  await expect(runtime.restartSync()).resolves.toBeUndefined()
})

it('third-party sync refuses unowned and other-account cloud mirrors as its local root', async () => {
  const { writeConfig } = await import('./settings')
  const { cloudVaultDir, unscopedCloudVaultDir } = await import('./cloudPaths')
  const mirrorA = cloudVaultDir()
  const legacy = unscopedCloudVaultDir()
  const { resolveLocalSyncRoot } = await import('../remotesyncIpc')
  login('B')
  for (const root of [mirrorA, legacy, path.join(legacy, 'nested')]) {
    await fs.mkdir(root, { recursive: true })
    await writeConfig({ localVault: root })
    expect(await resolveLocalSyncRoot()).toEqual({ error: 'cloud-vault-forbidden' })
  }
})
