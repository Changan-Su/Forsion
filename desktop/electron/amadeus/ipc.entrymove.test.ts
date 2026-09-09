import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  root: '', moveFail: false, handlers: new Map<string, (...args: any[]) => any>(),
  move: null as null | ((from: string, to: string) => void | Promise<void>),
  engines: [] as Array<{ binding: any; deps: any; moves: Array<{ from: string; to: string; done?: () => void }> }>,
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {},
  ipcMain: { handle: (key: string, fn: (...args: any[]) => any) => env.handlers.set(key, fn) },
}))
vi.mock('../forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => env.root, defaultWorkspaceDir: () => env.root }))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => ({ cloudUrl: 'https://example.test', token: 'x.eyJ1c2VySWQiOiJBIn0.x' }) }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))
vi.mock('./sync/collabMain', () => ({ SHARED_DIR: '与我共享', createCollabMain: () => ({ stop() {}, sharedWithMe: async () => [], ensureOwnVault: async () => 'own', call: async () => ({}) }) }))
vi.mock('./sync/engine', () => ({
  cloudVaultDir: () => path.join(env.root, 'cloud'), isManagedCloudVault: () => false, migrateCloudMirrorDir() {},
  createSyncEngine: (deps: any, binding?: any) => {
    const rec = { binding, deps, moves: [] as Array<{ from: string; to: string; done?: () => void }> }
    env.engines.push(rec)
    return { holdLocalMove: () => () => {}, start() {}, stop: async () => {}, restart: async () => {}, getStatus: () => ({ pendingDeletions: 0 }),
      syncNow: async () => {}, notifyLocal() {}, notifyLocalMove: (from: string, to: string, done?: () => void) => { if (env.moveFail) throw new Error('ENOSPC journal'); rec.moves.push({ from, to, done }) } }
  },
}))
let stop: undefined | (() => Promise<void>)
beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-entry-move-'))
  env.engines = []; env.handlers.clear(); env.move = null; env.moveFail = false
  const { VaultManager } = await import('./fs/vaultManager')
  const originalHooks = VaultManager.prototype.setMutationHooks
  vi.spyOn(VaultManager.prototype, 'setMutationHooks').mockImplementation(function (this: InstanceType<typeof VaultManager>, mutate, move, before) { env.move = move; originalHooks.call(this, mutate, move, before) })
})
afterEach(async () => { await stop?.(); vi.useRealTimers(); vi.restoreAllMocks(); await fs.rm(env.root, { recursive: true, force: true }) })

async function setup(entries: Array<{ path: string; kind: 'page' | 'folder' | 'asset' }>) {
  const local = path.join(env.root, 'local')
  await fs.mkdir(local)
  const { writeConfig, readConfig } = await import('./settings')
  await writeConfig({ localVault: local, lastVault: local, entrySync: [{ vaultRoot: local, cloudName: 'Notes', entries }] })
  const { registerIpc } = await import('./ipc')
  const { IPC } = await import('@amadeus-shared/ipc')
  const runtime = registerIpc(() => null)
  stop = runtime.stopSync
  await env.handlers.get(IPC.restoreVault)!({ sender: { id: 1 } })
  await vi.waitFor(() => expect(env.engines.some((e) => e.binding?.localRoot === local)).toBe(true))
  return { local, readConfig, rec: env.engines.find((e) => e.binding?.localRoot === local)! }
}

it('concurrent moves retain every registration instead of overwriting a sibling’s new path', async () => {
  const { readConfig, rec } = await setup([{ path: 'A.md', kind: 'page' }, { path: 'B.md', kind: 'page' }])
  await Promise.all([env.move!('A.md', 'Folder/A.md'), env.move!('B.md', 'Folder/B.md')])
  await vi.waitFor(() => expect(rec.moves).toHaveLength(2))
  await vi.waitFor(async () => expect((await readConfig()).entrySync![0].entries.map((e) => e.path).sort()).toEqual(['Folder/A.md', 'Folder/B.md']))
})

it('keeps the old path in scope until a slow cloud move completes, without resetting newer registrations', async () => {
  const { readConfig, rec } = await setup([{ path: 'A.md', kind: 'page' }, { path: 'B.md', kind: 'page' }])
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await env.move!('A.md', 'One/A.md')
  await vi.waitFor(async () => expect((await readConfig()).entrySync![0].entries[0].path).toBe('One/A.md'))
  await vi.advanceTimersByTimeAsync(5000)
  await env.move!('B.md', 'Two/B.md')
  await vi.waitFor(async () => expect((await readConfig()).entrySync![0].entries[1].path).toBe('Two/B.md'))
  await vi.advanceTimersByTimeAsync(6000)
  expect(rec.binding.inScope('Notes/A.md')).toBe(true)
  expect(rec.binding.inScope('Notes/Two/B.md')).toBe(true)
  rec.moves[0].done?.()
  expect(rec.binding.inScope('Notes/A.md')).toBe(false)
  expect(rec.binding.inScope('Notes/Two/B.md')).toBe(true)
})

it('a note moved out of a synced folder stays synced at its destination', async () => {
  const { readConfig, rec, local } = await setup([{ path: 'Synced', kind: 'folder' }])
  await fs.mkdir(path.join(local, 'Other'))
  await fs.writeFile(path.join(local, 'Other', 'A.md'), 'kept content')
  await env.move!('Synced/A.md', 'Other/A.md')
  await vi.waitFor(() => expect(rec.moves).toHaveLength(1))
  await vi.waitFor(async () => expect((await readConfig()).entrySync![0].entries).toContainEqual({ path: 'Other/A.md', kind: 'page' }))
  expect(rec.binding.inScope('Notes/Other/A.md')).toBe(true)
})

it.each(['config', 'journal'] as const)('a failed %s write rolls the physical move back and never sends a cloud move', async (failure) => {
  const { readConfig, local, rec } = await setup([{ path: 'A.md', kind: 'page' }])
  await fs.writeFile(path.join(local, 'A.md'), 'original content')
  const write = fs.writeFile.bind(fs)
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args: any[]) => {
    if (failure === 'config' && String(file).includes('amadeus-config.json.tmp')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    return (write as any)(file, ...args)
  })
  env.moveFail = failure === 'journal'
  const { IPC } = await import('@amadeus-shared/ipc')
  await expect(env.handlers.get(IPC.movePage)!({ sender: { id: 1 } }, 'A.md', 'Dest')).rejects.toThrow('ENOSPC')
  expect(await fs.readFile(path.join(local, 'A.md'), 'utf8')).toBe('original content')
  await expect(fs.access(path.join(local, 'Dest', 'A.md'))).rejects.toThrow()
  expect((await readConfig()).entrySync![0].entries).toEqual([{ path: 'A.md', kind: 'page' }])
  expect(rec.moves).toEqual([])
  spy.mockRestore()
})

it('pending moves do not retain unrelated exclusions after the user includes a child again', async () => {
  const { local, rec } = await setup([{ path: 'A.md', kind: 'page' }, { path: 'Folder', kind: 'folder' }])
  const { updateConfig } = await import('./settings')
  await updateConfig((cfg) => { cfg.entrySync![0].exclude = ['Folder/Hidden.md'] })
  await env.move!('A.md', 'Dest/A.md')
  const { SYNC_IPC } = await import('./sync/ipcKeys')
  await env.handlers.get(SYNC_IPC.entryEnable)!({}, { entries: [], include: ['Folder/Hidden.md'] })
  expect(rec.binding.inScope('Notes/Folder/Hidden.md')).toBe(true)
  expect(rec.binding.inScope('Notes/A.md')).toBe(true)
})
