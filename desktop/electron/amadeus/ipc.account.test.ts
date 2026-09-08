import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  root: '', creds: {} as { cloudUrl?: string; token?: string },
  handlers: new Map<string, (...args: any[]) => any>(), writes: [] as Array<{ account: string; vault: string; path: string }>,
  remote: new Map<string, Map<string, string>>(),
  events: [] as Array<{ window: number; channel: string; payload: unknown }>,
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [1, 2].map((window) => ({
    isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => env.events.push({ window, channel, payload }) },
  })) }, dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => path.join(env.root, 'app-data'), defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => env.creds }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))
vi.mock('./sync/sseClient', () => ({ startSse: () => ({ stop: vi.fn() }) }))
vi.mock('./sync/cloudClient', async () => {
  const { createHash } = await import('node:crypto')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  return {
    CloudHttpError: class extends Error {},
    createCloudClient: (cfg: { token: string; clientId: string }) => {
      const account = JSON.parse(Buffer.from(cfg.token.split('.')[1], 'base64url').toString()).userId
      const remote = env.remote.get(account) ?? new Map<string, string>()
      env.remote.set(account, remote)
      return {
        clientId: cfg.clientId,
        listVaults: async () => [{ id: `vault-${account}` }],
        tree: async () => ({ seq: remote.size, folders: [], entries: [...remote].map(([path, value], i) => ({ path, kind: 'page', seq: i + 1, hash: hash(value), size: value.length })) }),
        getFile: async (_vault: string, file: string) => ({ content: remote.get(file)!, seq: 1, hash: hash(remote.get(file)!) }),
        putFile: async (vault: string, file: string, content: string) => {
          env.writes.push({ account, vault, path: file })
          remote.set(file, content)
          return { seq: remote.size, hash: hash(content) }
        },
      }
    },
  }
})
const token = (userId: string) => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.x`
const login = (userId: string) => { env.creds = { cloudUrl: 'https://cloud.example', token: token(userId) } }
const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)
let stop: (() => Promise<void>) | undefined
beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-ipc-account-'))
  env.handlers.clear(); env.writes = []; env.remote.clear(); env.events = []
  login('A')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const account = JSON.parse(Buffer.from(init.headers.Authorization.slice(7).split('.')[1], 'base64url').toString()).userId
    return { ok: true, json: async () => url.endsWith('/shared-with-me') ? { items: [] } : { vaults: [{ id: `vault-${account}` }] } }
  }))
})
afterEach(async () => { await stop?.(); await fs.rm(env.root, { recursive: true, force: true }); vi.unstubAllGlobals() })

it('runs A → logout → B → A without enrolling local notes or reusing A’s mirror, cursor or vault for B', async () => {
  const { readConfig, writeConfig } = await import('./settings')
  const { cloudVaultDir } = await import('./sync/engine')
  const { SYNC_IPC } = await import('./sync/ipcKeys')
  const { IPC } = await import('@amadeus-shared/ipc')
  const local = path.join(env.root, 'my-local-notes')
  await fs.mkdir(local)
  await fs.writeFile(path.join(local, 'Selected.md'), 'local note selected by A')
  await fs.writeFile(path.join(local, 'LocalOnly.md'), 'local note never selected')
  await writeConfig({ localVault: local, lastVault: local, entrySync: [{ vaultRoot: local, cloudName: 'A folder', entries: [{ path: 'Selected.md', kind: 'page' }] }] })
  const { registerIpc } = await import('./ipc')
  const runtime = registerIpc(() => null)
  stop = runtime.stopSync
  await invoke(IPC.restoreVault)
  await vi.waitFor(() => expect(env.writes).toContainEqual({ account: 'A', vault: 'vault-A', path: 'A folder/Selected.md' }))
  const mirrorA = cloudVaultDir()
  await invoke(SYNC_IPC.switchSide, 'cloud')
  env.events = []
  await runtime.stopSync()
  for (const channel of [SYNC_IPC.entryChange, SYNC_IPC.presence]) {
    expect(new Set(env.events.filter((e) => e.channel === channel).map((e) => e.window))).toEqual(new Set([1, 2]))
  }
  expect(runtime.getVaultRoot()).toBe(local)
  // A stale detached/editor sender cannot write its old cloud document into the local root.
  await expect(invoke(IPC.writeTextFile, 'ShouldNotLeak.md', 'cloud editor stale content')).rejects.toThrow('active vault changed')
  await fs.writeFile(path.join(mirrorA, 'Private.md'), 'unsynced A-only mirror note')
  env.creds = {}
  await runtime.restartSync()
  expect((await invoke(SYNC_IPC.entryGet)).vaults).toEqual([])
  expect((await invoke(SYNC_IPC.get)).lastSyncAt).toBeNull()
  await expect(invoke(SYNC_IPC.switchSide, 'cloud')).rejects.toThrow('Sign in')
  login('B')
  await runtime.restartSync()
  expect(new Set(env.events.filter((e) => e.channel === SYNC_IPC.status).map((e) => e.window))).toEqual(new Set([1, 2]))
  const mirrorB = cloudVaultDir()
  expect(mirrorB).not.toBe(mirrorA)
  await vi.waitFor(async () => expect((await invoke(SYNC_IPC.get)).state).toBe('idle'))
  expect(env.writes.filter((w) => w.account === 'B')).toEqual([])
  expect((await invoke(SYNC_IPC.entryGet)).vaults).toEqual([])
  expect(await fs.readdir(mirrorB)).toEqual([])
  expect((await readConfig()).localVault).toBe(local)
  expect(await fs.readFile(path.join(local, 'Selected.md'), 'utf8')).toBe('local note selected by A')
  await runtime.stopSync()
  login('A')
  await runtime.restartSync()
  expect(cloudVaultDir()).toBe(mirrorA)
  expect((await invoke(SYNC_IPC.entryGet)).vaults[0].cloudName).toBe('A folder')
  await vi.waitFor(() => expect(env.writes).toContainEqual({ account: 'A', vault: 'vault-A', path: 'Private.md' }))
  expect(env.writes.some((w) => w.path.includes('LocalOnly'))).toBe(false)
  expect(env.writes.every((w) => w.vault === `vault-${w.account}`)).toBe(true)
})

it('cold boot never adopts an unowned legacy cloud mirror as a signed-out or B local vault', async () => {
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
  const { SYNC_IPC } = await import('./sync/ipcKeys')
  const runtime = registerIpc(() => null)
  stop = runtime.stopSync
  const restored = await invoke(IPC.restoreVault)
  expect(restored.root).toBe(path.join(env.root, 'workspace', 'Amadeus'))
  expect(restored.pages).not.toContain('LegacyPrivate.md')
  login('B')
  await runtime.restartSync()
  await vi.waitFor(async () => expect((await invoke(SYNC_IPC.get)).state).toBe('idle'))
  expect(env.writes).toEqual([])
  expect(await fs.readFile(path.join(oldMirror, 'LegacyPrivate.md'), 'utf8')).toBe('old account private offline note')
  expect((await invoke(SYNC_IPC.entryGet)).vaults).toEqual([])
})

it('third-party sync refuses unowned and other-account cloud mirrors as its local root', async () => {
  const { writeConfig } = await import('./settings')
  const { cloudVaultDir, unscopedCloudVaultDir } = await import('./sync/engine')
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
