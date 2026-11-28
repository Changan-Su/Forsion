import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { switchPatch } from './vaultList'
import type { BrowserWindow, IpcMain } from 'electron'
import { VAULT_CREATE_IPC as ch } from '../../shared/amadeus/vaultCreate'

const state = vi.hoisted(() => ({ root: '', move: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => state.root }, safeStorage: {} }))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, defaultWorkspaceDir: () => path.join(state.root, 'workspace'), forsionHomeDir: () => state.root,
}))
vi.mock('./settings', async (original) => ({ ...await original<typeof import('./settings')>(), moveSyncVaultPin: state.move }))

const { createVaultRegistryHost, registerVaultCreateIpc } = await import('./vaultCreate')
const { amadeusConfigPath, readVaultMenuRegistry, withVaultRegistry, updateLocalVaultConfig } = await import('./settings')
const parent = () => path.join(state.root, 'workspace', 'Vaults')
const config = () => fs.readFile(amadeusConfigPath(), 'utf8').then(JSON.parse)
beforeEach(async () => {
  state.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vault-create-')))
  state.move.mockReset()
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(state.root, { recursive: true, force: true }) })

it('registers both concurrent creations without changing the active vault or unrelated settings', async () => {
  const root = path.join(state.root, 'Home')
  await fs.writeFile(amadeusConfigPath(), JSON.stringify({ localVault: root, lastVault: root, lastPage: 'Home.md', extra: { keep: true } }))
  const host = createVaultRegistryHost()
  const create = (args: unknown) => host.create(args, randomUUID())
  const [notes, work] = await Promise.all([create({ name: 'Notes', existing: 'refuse' }), create({ name: 'Work', existing: 'refuse' })])
  expect(notes).toMatchObject({ root: path.join(parent(), 'Notes'), created: true, registered: true })
  expect(work.created).toBe(true)
  const saved = await config()
  expect(saved.vaults[0]).toEqual({ root })
  saved.vaults = [saved.vaults[0], ...saved.vaults.slice(1).sort((a: { root: string }, b: { root: string }) => a.root.localeCompare(b.root))]
  expect(saved).toEqual({
    localVault: root, lastVault: root, lastPage: 'Home.md', extra: { keep: true }, vaults: [{ root }, ...[notes.root, work.root].map((root) => ({ root }))],
  })
  await expect(create({ name: 'Notes', existing: 'refuse' })).rejects.toMatchObject({ code: 'EEXIST' })
  await expect(create({ parent: parent(), name: 'Notes', existing: 'reuse' })).resolves.toMatchObject({ root: notes.root, created: false, registered: false })
})

it('does not create a filesystem folder when the registry cannot be read', async () => {
  await fs.writeFile(amadeusConfigPath(), '{')
  const host = createVaultRegistryHost()
  const create = (args: unknown) => host.create(args, randomUUID())
  await expect(create({ name: 'Notes', existing: 'refuse' })).rejects.toThrow('amadeus-config-unparseable')
  await expect(fs.stat(parent())).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(amadeusConfigPath(), 'utf8')).toBe('{')
})

it('rejects an existing symlink and only removes an empty directory created by this process', async () => {
  const host = createVaultRegistryHost()
  const create = (args: unknown) => host.create(args, randomUUID())
  const made = await create({ name: 'Notes', existing: 'refuse' })
  const owned = path.join(parent(), 'Work')
  await fs.mkdir(owned)
  await fs.symlink(owned, path.join(parent(), 'Link'), 'dir')
  await expect(create({ parent: parent(), name: 'Link', existing: 'reuse' })).rejects.toThrow('vault-folder-unavailable')
  await fs.writeFile(path.join(owned, 'Note.md'), 'existing')
  const reused = await create({ parent: parent(), name: 'Work', existing: 'reuse' })
  expect(await host.rollback(reused.operationId)).toBe('unregistered')
  expect(await fs.readFile(path.join(owned, 'Note.md'), 'utf8')).toBe('existing')
  await fs.writeFile(path.join(made.root, '.keep'), '')
  expect(await host.rollback(made.operationId)).toBe('kept_not_empty')
  await fs.unlink(path.join(made.root, '.keep'))
  expect(await host.rollback(made.operationId)).toBe('removed')
  await expect(fs.stat(made.root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('hashes inside a registered inactive root and rejects escape through a sibling or symlink', async () => {
  const host = createVaultRegistryHost()
  const create = (args: unknown) => host.create(args, randomUUID())
  const { root } = await create({ name: 'Notes', existing: 'refuse' })
  const sibling = path.join(parent(), 'NotesOther')
  await fs.mkdir(sibling)
  const outside = path.join(sibling, 'Work.md')
  await fs.writeFile(path.join(root, 'Note.md'), 'note')
  await fs.writeFile(outside, 'private')
  await fs.symlink(outside, path.join(root, 'Link.md'))
  expect(await host.hashes(root, ['Note.md'])).toEqual([createHash('sha256').update('note').digest('hex')])
  await expect(host.hashes(sibling, ['Work.md'])).rejects.toThrow('vault-not-listed')
  await expect(host.hashes(root, ['../NotesOther/Work.md'])).rejects.toThrow('vault-file-unavailable')
  await expect(host.hashes(root, ['Link.md'])).rejects.toThrow('vault-file-unavailable')
})

it('preserves an original registration and last page when rolling back its recreated directory', async () => {
  const root = path.join(parent(), 'Work')
  await fs.writeFile(amadeusConfigPath(), JSON.stringify({ vaults: [{ root, lastPage: 'Notes.md' }] }))
  const host = createVaultRegistryHost()
  const made = await host.create({ name: 'Work', existing: 'refuse' }, randomUUID())
  expect(made).toMatchObject({ created: true, registered: false })
  expect(await host.rollback(made.operationId)).toBe('removed_still_listed')
  expect((await config()).vaults).toEqual([{ root, lastPage: 'Notes.md' }])
  await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not roll back a folder adopted by a later request', async () => {
  const host = createVaultRegistryHost()
  const made = await host.create({ name: 'Work', existing: 'refuse' }, randomUUID())
  await host.create({ name: 'Work', existing: 'reuse' }, randomUUID())
  expect(await host.rollback(made.operationId)).toBe('kept_adopted')
  expect((await config()).vaults).toEqual([{ root: made.root }])
  expect((await fs.stat(made.root)).isDirectory()).toBe(true)
})

it('keeps a usable menu snapshot for a damaged registry while rejecting writes', async () => {
  const root = path.join(state.root, 'Notes')
  const contents = JSON.stringify({ localVault: root, vaults: [null, { root }] })
  await fs.writeFile(amadeusConfigPath(), contents)
  expect(await readVaultMenuRegistry()).toEqual({ config: { localVault: root, vaults: [{ root }] }, degraded: true })
  const host = createVaultRegistryHost()
  await expect(host.create({ name: 'Work', existing: 'refuse' }, randomUUID())).rejects.toThrow('amadeus-config-malformed')
  expect(await fs.readFile(amadeusConfigPath(), 'utf8')).toBe(contents)
})

function ipcFixture() {
  const handles = new Map<string, (...args: any[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (...args: any[]) => unknown) => handles.set(channel, fn) } as unknown as IpcMain
  const windowFixture = () => ({
    isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {}, send: vi.fn() },
  })
  const main = windowFixture(), settings = windowFixture(), detached = windowFixture()
  const event = (w: typeof main) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame })
  registerVaultCreateIpc(ipc, () => main as unknown as BrowserWindow, () => settings as unknown as BrowserWindow)
  const invoke = (channel: string, win: typeof main, ...args: unknown[]) => handles.get(channel)!(event(win), ...args)
  return { main, settings, detached, invoke }
}

it('only accepts a settings relay from the main window and leaves hashes and pins main-only', async () => {
  const { main, settings, detached, invoke } = ipcFixture()
  const id = randomUUID()
  expect(() => invoke(ch.request, detached, id, { kind: 'parent' })).toThrow('forbidden')
  expect(() => invoke(ch.hashes, settings, parent(), [])).toThrow('forbidden')
  expect(() => invoke(ch.request, settings, id, { kind: 'movePin', root: parent() })).toThrow('forbidden')
  expect(invoke(ch.request, settings, id, { kind: 'parent' })).toEqual({ state: 'pending' })
  expect(main.webContents.send).toHaveBeenCalledWith(ch.relay, id)
  expect(() => invoke(ch.accept, detached, id)).toThrow('forbidden')
  expect(() => invoke(ch.status, main, id)).toThrow('forbidden')
  invoke(ch.accept, main, id)
  await vi.waitFor(() => expect(invoke(ch.status, settings, id)).toMatchObject({ state: 'ok', value: { path: parent() } }))
  const pinId = randomUUID()
  state.move.mockResolvedValue('legacy-remotesync-not-paused')
  invoke(ch.request, main, pinId, { kind: 'movePin', root: parent(), check: { checkOnly: true } })
  await vi.waitFor(() => expect(invoke(ch.status, main, pinId)).toEqual({ state: 'ok', value: 'legacy-remotesync-not-paused' }))
  expect(state.move).toHaveBeenCalledWith(parent(), { checkOnly: true })
})

it('expires only unstarted requests and returns journaled results when an accepted request runs slowly', async () => {
  const { main, settings, invoke } = ipcFixture()
  const now = vi.spyOn(Date, 'now').mockReturnValue(100)
  const expired = randomUUID()
  invoke(ch.request, settings, expired, { kind: 'create', args: { name: 'Notes', existing: 'refuse' } })
  now.mockReturnValue(20_000)
  expect(invoke(ch.status, settings, expired)).toEqual({ state: 'failed', error: 'vault-host-unavailable' })
  invoke(ch.accept, main, expired)
  await expect(fs.stat(parent())).rejects.toMatchObject({ code: 'ENOENT' })

  const accepted = randomUUID()
  const operation = { kind: 'create', args: { name: 'Work', existing: 'refuse' } }
  let release!: () => void
  let entered!: () => void
  const atDisk = new Promise<void>((resolve) => { entered = resolve })
  const delayed = new Promise<void>((resolve) => { release = resolve })
  const realpath = fs.realpath
  vi.spyOn(fs, 'realpath').mockImplementationOnce(async (location) => {
    entered()
    await delayed
    return realpath(location)
  })
  invoke(ch.request, settings, accepted, operation)
  invoke(ch.accept, main, accepted)
  await atDisk
  try {
    now.mockReturnValue(40_000)
    expect(invoke(ch.status, settings, accepted)).toEqual({ state: 'pending' })
    expect(await withVaultRegistry(async (cfg) => cfg.vaults)).toBeUndefined()
  } finally { release() }
  const result = { state: 'ok', value: { root: path.join(parent(), 'Work'), created: true, registered: true, operationId: accepted } }
  await vi.waitFor(() => expect(invoke(ch.status, settings, accepted)).toEqual(result))
  expect(invoke(ch.request, settings, accepted, operation)).toEqual(result)
})

it('inspects a missing default parent without writing and only creates that parent after acceptance', async () => {
  const { main, invoke } = ipcFixture()
  await fs.mkdir(path.dirname(parent()))
  const read = randomUUID()
  invoke(ch.request, main, read, { kind: 'parent' })
  await vi.waitFor(() => expect(invoke(ch.status, main, read)).toMatchObject({ state: 'ok', value: { exists: false, freeBytes: expect.any(Number) } }))
  await expect(fs.stat(parent())).rejects.toMatchObject({ code: 'ENOENT' })
  const write = randomUUID()
  invoke(ch.request, main, write, { kind: 'ensureParent' })
  await vi.waitFor(() => expect(invoke(ch.status, main, write)).toEqual({ state: 'ok', value: parent() }))
  expect(await fs.readdir(parent())).toEqual([])
  await expect(fs.stat(amadeusConfigPath())).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps legacy vault order and the old vault last page after creating and switching', async () => {
  const root = path.join(state.root, 'Notes')
  await fs.writeFile(amadeusConfigPath(), JSON.stringify({ localVault: root, lastVault: root, lastPage: 'Old.md' }))
  const host = createVaultRegistryHost()
  const made = await host.create({ name: 'Work', existing: 'refuse' }, randomUUID())
  await updateLocalVaultConfig((cfg) => { Object.assign(cfg, switchPatch(cfg, made.root)) })
  const saved = await config()
  expect(saved.vaults.map((v: { root: string }) => v.root)).toEqual([root, made.root])
  expect(saved.vaults.find((v: { root: string }) => v.root === root)?.lastPage).toBe('Old.md')
})
