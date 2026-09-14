import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

const env = vi.hoisted(() => ({ root: '', creds: {} as { cloudUrl?: string; token?: string } }))
vi.mock('electron', () => ({ app: { getPath: () => env.root } }))
vi.mock('../forsionHome', () => ({ isDevMode: () => false }))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => env.creds }))
const token = (userId: string, iat = 1) => `x.${Buffer.from(JSON.stringify({ userId, iat })).toString('base64url')}.x`
const login = (id: string, cloudUrl = 'https://cloud.example') => { env.creds = { cloudUrl, token: token(id) } }

beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-account-'))
  login('A')
})
afterEach(() => fs.rm(env.root, { recursive: true, force: true }))

describe('Amadeus account boundaries', () => {
  it('A → logout → B → A preserves local folders and restores only that account’s note registrations', async () => {
    const { readConfig, writeConfig } = await import('./settings')
    const entries = [{ vaultRoot: '/local/notes', cloudName: 'A notes', entries: [{ path: 'Secret.md', kind: 'page' as const }] }]
    await writeConfig({ localVault: '/local/notes', lastVault: '/local/notes', cloudSync: { vaultId: 'vault-a', enabled: false }, entrySync: entries })
    env.creds = {}
    expect((await readConfig()).entrySync ?? []).toEqual([])
    expect((await readConfig()).cloudSync?.vaultId).toBeUndefined()
    expect((await readConfig()).localVault).toBe('/local/notes')
    login('B')
    expect((await readConfig()).entrySync ?? []).toEqual([])
    expect((await readConfig()).cloudSync?.enabled).toBeUndefined()
    await writeConfig({ cloudSync: { vaultId: 'vault-b' }, entrySync: [] })
    login('A')
    expect((await readConfig()).entrySync).toEqual(entries)
    expect((await readConfig()).cloudSync).toMatchObject({ vaultId: 'vault-a', enabled: false })
    login('A', 'https://other.example')
    expect((await readConfig()).entrySync ?? []).toEqual([])
    login('A')
    env.creds.token = token('A', 99)
    expect((await readConfig()).entrySync).toEqual(entries)
  })

  it('keeps unowned legacy registrations as recovery data instead of assigning them to the next signed-in account', async () => {
    const legacy = { localVault: '/local/notes', cloudSync: { vaultId: 'old-vault' }, entrySync: [{ vaultRoot: '/local/notes', cloudName: 'Old', entries: [{ path: 'Old.md', kind: 'page' }] }] }
    await fs.writeFile(path.join(env.root, 'amadeus-config.json'), JSON.stringify(legacy))
    const { readConfig, writeConfig } = await import('./settings')
    login('B')
    expect((await readConfig()).entrySync ?? []).toEqual([])
    await writeConfig({ lastPage: 'Local.md' })
    const stored = JSON.parse(await fs.readFile(path.join(env.root, 'amadeus-config.json'), 'utf8'))
    expect(stored.legacyCloudState.entrySync).toEqual(legacy.entrySync)
    expect(stored.localVault).toBe('/local/notes')
  })
})

it('pins delayed configuration writes to the originating account and survives a process reload', async () => {
  const { readConfig, writeConfig } = await import('./settings')
  const a = await readConfig()
  login('B')
  await writeConfig({ cloudSync: { vaultId: 'vault-b' } })
  await writeConfig({ entrySync: [{ vaultRoot: '/local', cloudName: 'A only', entries: [{ path: 'A.md', kind: 'page' }] }] }, a.cloudAccountId)
  expect((await readConfig()).entrySync).toEqual([])
  vi.resetModules()
  const reloaded = await import('./settings')
  expect((await reloaded.readConfig()).cloudSync?.vaultId).toBe('vault-b')
  login('A')
  expect((await reloaded.readConfig()).entrySync?.[0].cloudName).toBe('A only')
})

describe('legacy cloud state adoption', () => {
  const h8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)
  const legacy = {
    localVault: '/local/notes',
    cloudSync: { vaultId: 'vault-a', deviceId: 'desk-old', enabled: true },
    entrySync: [{ vaultRoot: '/local/notes', cloudName: 'Notes', entries: [{ path: 'MOC.md', kind: 'page' }] }],
  }
  const oldShadow = () => path.join(env.root, `amadeus-sync-entry-${h8('/local/notes')}.json`)
  const stored = async () => JSON.parse(await fs.readFile(path.join(env.root, 'amadeus-config.json'), 'utf8'))
  // A complete baseline as the engine accepts it (folder '' + tracked files), not a stub.
  const legacyShadow = {
    vaultRoot: '/local/notes', folder: '', vaultId: 'vault-a', cursor: 42, lastSyncAt: 1700000000000,
    files: { 'Notes/MOC.md': { seq: 3, hash: 'abc', size: 3, mtimeMs: 1 } },
  }
  const seed = async () => {
    await fs.writeFile(path.join(env.root, 'amadeus-config.json'), JSON.stringify(legacy))
    await fs.writeFile(oldShadow(), JSON.stringify(legacyShadow))
  }

  it('adopts bindings and their shadow once the account resolves the same vault', async () => {
    await seed()
    const { readConfig, writeConfig, adoptLegacyCloudState, cloudAccountNamespace } = await import('./settings')
    expect(await adoptLegacyCloudState()).toBe(false) // vault not resolved yet → stays quarantined
    expect((await readConfig()).entrySync).toEqual([])
    await writeConfig({ cloudSync: { vaultId: 'vault-a', deviceId: 'desk-new' } })
    expect(await adoptLegacyCloudState()).toBe(true)
    expect((await readConfig()).entrySync).toEqual(legacy.entrySync)
    expect((await readConfig()).cloudSync).toMatchObject({ vaultId: 'vault-a', deviceId: 'desk-new' })
    expect((await stored()).legacyCloudState).toBeUndefined()
    const moved = path.join(env.root, `amadeus-sync-${cloudAccountNamespace()}-entry-${h8('/local/notes')}.json`)
    expect(JSON.parse(await fs.readFile(moved, 'utf8'))).toEqual(legacyShadow) // byte-for-byte the old baseline
    await expect(fs.access(oldShadow())).rejects.toThrow()
    expect(await adoptLegacyCloudState()).toBe(false) // idempotent
    vi.resetModules()
    const reloaded = await import('./settings')
    expect((await reloaded.readConfig()).entrySync).toEqual(legacy.entrySync)
  })

  it('leaves bindings quarantined for an account whose vault differs', async () => {
    await seed()
    const { readConfig, writeConfig, adoptLegacyCloudState } = await import('./settings')
    login('B')
    await writeConfig({ cloudSync: { vaultId: 'vault-b' } })
    expect(await adoptLegacyCloudState()).toBe(false)
    expect((await readConfig()).entrySync).toEqual([])
    expect((await stored()).legacyCloudState.entrySync).toEqual(legacy.entrySync)
    await expect(fs.access(oldShadow())).resolves.toBeUndefined()
  })

  it('keeps the legacy state when the shadow cannot be moved, so nothing starts on an empty baseline', async () => {
    await seed()
    const { readConfig, writeConfig, adoptLegacyCloudState } = await import('./settings')
    await writeConfig({ cloudSync: { vaultId: 'vault-a' } })
    const nodeFs = await import('node:fs')
    const busy = vi.spyOn(nodeFs.promises, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    expect(await adoptLegacyCloudState()).toBe(false)
    busy.mockRestore()
    expect((await readConfig()).entrySync).toEqual([])
    expect((await stored()).legacyCloudState.entrySync).toEqual(legacy.entrySync)
    await expect(fs.access(oldShadow())).resolves.toBeUndefined()
    expect(await adoptLegacyCloudState()).toBe(true) // the next attempt succeeds once the file is free
    expect((await readConfig()).entrySync).toEqual(legacy.entrySync)
  })

  it('keeps a binding re-created after the upgrade together with its newer shadow', async () => {
    await seed()
    const { readConfig, writeConfig, adoptLegacyCloudState, cloudAccountNamespace } = await import('./settings')
    const fresh = { vaultRoot: '/local/notes', cloudName: 'Notes', entries: [{ path: 'Other.md', kind: 'page' as const }] }
    await writeConfig({ cloudSync: { vaultId: 'vault-a' }, entrySync: [fresh] })
    const newShadow = path.join(env.root, `amadeus-sync-${cloudAccountNamespace()}-entry-${h8('/local/notes')}.json`)
    await fs.writeFile(newShadow, JSON.stringify({ vaultRoot: '/local/notes', vaultId: 'vault-a', cursor: 7, files: {} }))
    expect(await adoptLegacyCloudState()).toBe(true)
    expect((await readConfig()).entrySync).toEqual([fresh])
    expect((await stored()).legacyCloudState).toBeUndefined()
    expect(JSON.parse(await fs.readFile(newShadow, 'utf8')).cursor).toBe(7)
    await expect(fs.access(oldShadow())).resolves.toBeUndefined()
  })
})
