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

it('moves the requested pin on a device without legacy remote sync and preserves the rest of the config', async () => {
  const { legacyRemoteSync, resolveLocalSyncRoot } = await import('../remotesyncIpc')
  const { moveSyncVaultPin, readConfig, writeConfig } = await import('./settings')
  expect(await resolveLocalSyncRoot()).toEqual({ root: await fs.realpath(pinned()) })
  await legacyRemoteSync.touch()
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
  await legacyRemoteSync.touch()
  expect(await moveSyncVaultPin(local())).toBe('moved')
  expect((await readConfig()).syncVault).toBeUndefined()
  expect(JSON.parse(await readBytes())).toEqual(base)
})

it('uses a strict disk read even when a cached config exists, and keeps the pin without a local destination', async () => {
  const { legacyRemoteSync } = await import('../remotesyncIpc')
  const { moveSyncVaultPin, readConfig } = await import('./settings')
  await legacyRemoteSync.touch()
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
  expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  expect(await readBytes()).toBe(before)
})

it('keeps the old root after seal, after archive, and throughout hand-back to the old push target', async () => {
  const remote = join(env.root, 'Remote')
  await fs.mkdir(remote)
  await fs.writeFile(join(pinned(), 'Plan.md'), 'original vault')
  await fs.writeFile(join(local(), 'Plan.md'), 'different vault')
  const legacyFile = join(env.root, 'remotesync.json')
  await fs.writeFile(legacyFile, JSON.stringify({ backend: 'folder', direction: 'push', intervalMin: 5, folder: { path: remote } }))
  const { legacyRemoteSync, registerRemoteSync } = await import('../remotesyncIpc')
  const { moveSyncVaultPin } = await import('./settings')
  await legacyRemoteSync.touch()
  const snapshot = await legacyRemoteSync.view()
  expect(snapshot?.root).toBe(await fs.realpath(pinned()))
  await legacyRemoteSync.seal()
  const before = await readBytes()
  expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  expect(await readBytes()).toBe(before)
  expect((await legacyRemoteSync.view())?.legacyKey).toBe(snapshot?.legacyKey)

  await legacyRemoteSync.archive(join(env.root, 'Archive'), { expectKey: snapshot!.legacyKey! })
  expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')

  let release!: () => void
  let checking!: () => void
  const paused = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { checking = resolve })
  const read = fs.readFile.bind(fs)
  const reader = vi.spyOn(fs, 'readFile').mockImplementation((async (file, ...args) => {
    if (file === legacyFile) { checking(); await paused }
    return Reflect.apply(read, fs, [file, ...args])
  }) as typeof fs.readFile)
  const handBack = legacyRemoteSync.unseal({ expectKey: snapshot!.legacyKey! })
  await entered
  try {
    expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
    expect(await readBytes()).toBe(before)
  } finally {
    release()
    await handBack
    reader.mockRestore()
  }
  expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  registerRemoteSync()
  expect((await env.handlers.get('remotesync:run')!({})).ok).toBe(true)
  expect(await fs.readFile(join(remote, 'Plan.md'), 'utf8')).toBe('original vault')
})

it('refuses a disabled, unreadable, or moved-aside legacy config even after handshake', async () => {
  const { legacyRemoteSync } = await import('../remotesyncIpc')
  const { moveSyncVaultPin } = await import('./settings')
  await legacyRemoteSync.touch()
  const file = join(env.root, 'remotesync.json')
  const before = await readBytes()
  await fs.writeFile(file, '{"backend":"off"}')
  expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  await fs.writeFile(file, '{')
  expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  await fs.rename(file, `${file}.unreadable-1`)
  expect(await moveSyncVaultPin(pinned())).toBe('legacy-remotesync-not-paused')
  expect(await readBytes()).toBe(before)
})

it('checks for legacy config inside its write queue when legacy settings are concurrently saved', async () => {
  const { legacyRemoteSync, registerRemoteSync } = await import('../remotesyncIpc')
  const { moveSyncVaultPin } = await import('./settings')
  await legacyRemoteSync.touch()
  registerRemoteSync()
  const before = await readBytes()
  const file = join(env.root, 'remotesync.json')
  let resume!: () => void
  let writing!: () => void
  const held = new Promise<void>((resolve) => { resume = resolve })
  const started = new Promise<void>((resolve) => { writing = resolve })
  const write = fs.writeFile.bind(fs)
  vi.spyOn(fs, 'writeFile').mockImplementation(async (target, ...args) => {
    if (target === file) { writing(); await held }
    await write(target, ...args)
  })
  const readdir = vi.spyOn(fs, 'readdir')
  const save = env.handlers.get('remotesync:set')!({}, { backend: 'off' })
  await started
  const move = moveSyncVaultPin(pinned())
  try {
    await expect(Promise.race([move, new Promise((resolve) => setTimeout(() => resolve('waiting'), 20))])).resolves.toBe('waiting')
    expect(readdir).not.toHaveBeenCalledWith(env.root)
  } finally {
    resume()
    await save
  }
  expect(await move).toBe('legacy-remotesync-not-paused')
  expect(await readBytes()).toBe(before)
})
