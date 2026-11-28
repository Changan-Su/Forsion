import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  app: { getPath: () => env.root },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => env.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
}))
vi.mock('../forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => env.root, defaultWorkspaceDir: () => env.root }))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => ({}) }))

const configFile = () => join(env.root, 'amadeus-config.json')
const readBytes = () => fs.readFile(configFile(), 'utf8')
const pinned = () => join(env.root, 'Notes')
const local = () => join(env.root, 'Work')
const config = () => ({
  syncVault: pinned(), localVault: local(), lastVault: local(), lastPage: 'Local.md',
  vaults: [{ root: pinned() }, { root: local() }], cloudAccounts: { account: { cloudSync: { vaultId: 'vault-a' } } },
})

beforeEach(async () => {
  vi.resetModules()
  env.handlers.clear()
  env.root = await fs.mkdtemp(join(tmpdir(), 'amadeus-pin-'))
  await fs.mkdir(pinned())
  await fs.mkdir(local())
  await fs.writeFile(configFile(), JSON.stringify(config()))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(env.root, { recursive: true, force: true })
})

it('moves the requested pin to the local vault while sealed and preserves the rest of the config', async () => {
  const { legacyRemoteSync, resolveLocalSyncRoot } = await import('../remotesyncIpc')
  const { moveSyncVaultPin, readConfig, writeConfig } = await import('./settings')
  expect(await resolveLocalSyncRoot()).toEqual({ root: await fs.realpath(pinned()) })
  await legacyRemoteSync.seal()
  const otherWrite = writeConfig({ lastPage: 'New.md' })
  expect(await moveSyncVaultPin(pinned())).toBe('moved')
  await otherWrite
  expect(await readConfig()).toMatchObject({ syncVault: local(), lastPage: 'New.md' })
  expect(await resolveLocalSyncRoot()).toEqual({ root: await fs.realpath(local()) })
  expect(JSON.parse(await readBytes())).toEqual({ ...config(), syncVault: local(), lastPage: 'New.md' })
  const once = await readBytes()
  expect(await moveSyncVaultPin(pinned())).toBe('unchanged')
  expect(await readBytes()).toBe(once)
})

it('clears a pin equal to localVault using the vault list path comparison', async () => {
  const { legacyRemoteSync } = await import('../remotesyncIpc')
  const { moveSyncVaultPin, readConfig } = await import('./settings')
  const { syncVault: _old, ...base } = config()
  await fs.writeFile(configFile(), JSON.stringify({ ...base, syncVault: `${local()}/` }))
  await legacyRemoteSync.seal()
  expect(await moveSyncVaultPin(local())).toBe('moved')
  expect((await readConfig()).syncVault).toBeUndefined()
  expect(JSON.parse(await readBytes())).toEqual(base)
})

it('uses a strict disk read even when a cached config exists, and keeps the pin without a local destination', async () => {
  const { legacyRemoteSync } = await import('../remotesyncIpc')
  const { moveSyncVaultPin, readConfig } = await import('./settings')
  await legacyRemoteSync.seal()
  expect((await readConfig()).localVault).toBe(local())
  await fs.writeFile(configFile(), '{')
  await expect(moveSyncVaultPin(pinned())).rejects.toThrow('amadeus-config-unparseable')
  expect(await readBytes()).toBe('{')
  const incomplete = JSON.stringify({ ...config(), localVault: undefined })
  await fs.writeFile(configFile(), incomplete)
  expect(await moveSyncVaultPin(pinned())).toBe('local-vault-unavailable')
  expect(await readBytes()).toBe(incomplete)
})

it('does not move an unsealed pin or trust a persisted hold before this launch handshakes', async () => {
  const before = await readBytes()
  const { moveSyncVaultPin } = await import('./settings')
  expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  const { legacyRemoteSync } = await import('../remotesyncIpc')
  await legacyRemoteSync.seal()
  vi.resetModules()
  const restarted = await import('./settings')
  expect(await restarted.moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  const legacy = (await import('../remotesyncIpc')).legacyRemoteSync
  legacy.extendLoaded(false)
  expect(await restarted.moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  expect(await readBytes()).toBe(before)
})

it('refuses to move while a sealed remote round is still draining', async () => {
  const remote = join(env.root, 'Remote')
  await fs.mkdir(remote)
  await fs.writeFile(join(env.root, 'remotesync.json'), JSON.stringify({ backend: 'folder', folder: { path: remote } }))
  const { legacyRemoteSync, registerRemoteSync, syncTargetsStore } = await import('../remotesyncIpc')
  const { moveSyncVaultPin } = await import('./settings')
  const engine = await import('../remotesync/engine')
  let resume!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => { resume = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const runSync = engine.runSync
  vi.spyOn(engine, 'runSync').mockImplementationOnce(async (options) => {
    entered()
    await held
    return runSync(options)
  })
  registerRemoteSync()
  await legacyRemoteSync.touch()
  const invokeRun = env.handlers.get('remotesync:run')!
  const round = invokeRun({}, { dryRun: true })
  await Promise.race([started, round.then(() => { throw new Error('round did not reach the engine') })])
  const seal = legacyRemoteSync.seal()
  const before = await readBytes()
  try {
    await vi.waitFor(async () => expect((await syncTargetsStore.readLegacy()).holder).toBe('v2'))
    expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
    expect(await readBytes()).toBe(before)
  } finally {
    resume()
    await Promise.all([round, seal])
  }
  expect(await moveSyncVaultPin(pinned())).toBe('moved')
})
