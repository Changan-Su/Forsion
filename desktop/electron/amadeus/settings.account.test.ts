import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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
