import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import type { BrowserWindow, IpcMain } from 'electron'
import { VAULT_CREATE_IPC as ch } from '../../shared/amadeus/vaultCreate'

const state = vi.hoisted(() => ({ root: '', move: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => state.root }, safeStorage: {} }))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, defaultWorkspaceDir: () => path.join(state.root, 'workspace'), forsionHomeDir: () => state.root,
}))
vi.mock('./settings', async (original) => ({ ...await original<typeof import('./settings')>(), moveSyncVaultPin: state.move }))

const { createVaultRegistryHost, registerVaultCreateIpc } = await import('./vaultCreate')
const { amadeusConfigPath } = await import('./settings')
const parent = () => path.join(state.root, 'workspace', 'Vaults')
const config = () => fs.readFile(amadeusConfigPath(), 'utf8').then(JSON.parse)
beforeEach(async () => {
  state.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vault-create-')))
  state.move.mockReset()
})
afterEach(async () => { await fs.rm(state.root, { recursive: true, force: true }) })

it('registers both concurrent creations without changing the active vault or unrelated settings', async () => {
  const root = path.join(state.root, 'Home')
  await fs.writeFile(amadeusConfigPath(), JSON.stringify({ localVault: root, lastVault: root, lastPage: 'Home.md', extra: { keep: true } }))
  const host = createVaultRegistryHost()
  const [notes, work] = await Promise.all([host.create({ name: 'Notes', existing: 'refuse' }), host.create({ name: 'Work', existing: 'refuse' })])
  expect(notes).toEqual({ root: path.join(parent(), 'Notes'), created: true })
  expect(work.created).toBe(true)
  expect(await config()).toEqual({
    localVault: root, lastVault: root, lastPage: 'Home.md', extra: { keep: true }, vaults: [{ root: notes.root }, { root: work.root }],
  })
  await expect(host.create({ name: 'Notes', existing: 'refuse' })).rejects.toMatchObject({ code: 'EEXIST' })
  await expect(host.create({ parent: parent(), name: 'Notes', existing: 'reuse' })).resolves.toEqual({ root: notes.root, created: false })
})

it('does not create a filesystem folder when the registry cannot be read', async () => {
  await fs.writeFile(amadeusConfigPath(), '{')
  const host = createVaultRegistryHost()
  await expect(host.create({ name: 'Notes', existing: 'refuse' })).rejects.toThrow('amadeus-config-unparseable')
  await expect(fs.stat(parent())).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(amadeusConfigPath(), 'utf8')).toBe('{')
})

it('rejects an existing symlink and only removes an empty directory created by this process', async () => {
  const host = createVaultRegistryHost()
  const made = await host.create({ name: 'Notes', existing: 'refuse' })
  const owned = path.join(parent(), 'Work')
  await fs.mkdir(owned)
  await fs.symlink(owned, path.join(parent(), 'Link'), 'dir')
  await expect(host.create({ parent: parent(), name: 'Link', existing: 'reuse' })).rejects.toThrow('vault-folder-unavailable')
  await host.create({ parent: parent(), name: 'Work', existing: 'reuse' })
  expect(await host.empty(owned)).toBeNull()
  await expect(host.remove(owned)).rejects.toThrow()
  await fs.writeFile(path.join(made.root, '.keep'), '')
  expect(await host.empty(made.root)).toBe(false)
  await expect(host.remove(made.root)).rejects.toThrow()
  await fs.unlink(path.join(made.root, '.keep'))
  expect(await host.empty(made.root)).toBe(true)
  await host.remove(made.root)
  await expect(fs.stat(made.root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('hashes inside a registered inactive root and rejects escape through a sibling or symlink', async () => {
  const host = createVaultRegistryHost()
  const { root } = await host.create({ name: 'Notes', existing: 'refuse' })
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

it('only lets the live main top frame use direct host IPC and relays from the owned settings window', async () => {
  const handles = new Map<string, (...args: any[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (...args: any[]) => unknown) => handles.set(channel, fn) } as unknown as IpcMain
  const windowFixture = () => ({
    isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {}, send: vi.fn() },
  })
  const main = windowFixture(), settings = windowFixture(), detached = windowFixture()
  const event = (w: typeof main) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame })
  registerVaultCreateIpc(ipc, () => main as unknown as BrowserWindow, () => settings as unknown as BrowserWindow)
  expect(() => handles.get(ch.create)!(event(settings), {})).toThrow('forbidden')
  expect(() => handles.get(ch.parent)!({ ...event(main), senderFrame: null })).toThrow('forbidden')
  expect(() => handles.get(ch.parent)!({ ...event(main), senderFrame: {} })).toThrow('forbidden')
  await expect(handles.get(ch.settingsRequest)!(event(detached), ch.create, {})).rejects.toThrow('forbidden')
  await expect(handles.get(ch.settingsRequest)!(event(settings), ch.hashes, {})).rejects.toThrow('forbidden')
  const requested = handles.get(ch.settingsRequest)!(event(settings), ch.parent)
  const id = main.webContents.send.mock.calls[0]?.[1]
  handles.get(ch.settingsResult)!(event(detached), id, true, 'wrong origin')
  handles.get(ch.settingsResult)!(event(main), id, true, handles.get(ch.parent)!(event(main)))
  await expect(requested).resolves.toBe(parent())
  state.move.mockResolvedValue('legacy-remotesync-not-paused')
  await expect(handles.get(ch.movePin)!(event(main), parent())).resolves.toBe('legacy-remotesync-not-paused')
  expect(state.move).toHaveBeenCalledWith(parent())
})
