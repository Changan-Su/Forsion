import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => path.join(env.root, 'app-data'), defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => ({}) }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))
vi.mock('./sync/sseClient', () => ({ startSse: () => ({ stop: vi.fn() }) }))

const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)
let stop: (() => Promise<void>) | undefined
let local: string
beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-ipc-move-'))
  env.handlers.clear()
  local = path.join(env.root, 'notes')
  await fs.mkdir(local)
  await fs.writeFile(path.join(local, 'A.md'), '# A\n\nOriginal content\n')
  const { writeConfig } = await import('./settings')
  await writeConfig({ localVault: local, lastVault: local })
  const { registerIpc } = await import('./ipc')
  const { IPC } = await import('@amadeus-shared/ipc')
  const runtime = registerIpc(() => null)
  stop = runtime.stopSync
  await invoke(IPC.restoreVault)
})
afterEach(async () => { await stop?.(); await fs.rm(env.root, { recursive: true, force: true }) })

it.each(['loadPage', 'reconcilePage'] as const)('a late %s after move must not recreate an empty note at the old path', async (method) => {
  const { IPC } = await import('@amadeus-shared/ipc')
  const page = await invoke(IPC.loadPage, 'A.md')
  expect(await invoke(IPC.movePage, 'A.md', 'Dest')).toBe('Dest/A.md')
  await expect(invoke(IPC[method], 'A.md', page.manifest, {})).rejects.toThrow()
  expect(await fs.readdir(local)).toEqual(['Dest'])
  expect(await fs.readFile(path.join(local, 'Dest/A.md'), 'utf8')).toBe('# A\n\nOriginal content\n')
})

it('explicit newPage still creates a note and existing empty notes still load', async () => {
  const { IPC } = await import('@amadeus-shared/ipc')
  await invoke(IPC.newPage, 'New.md')
  expect((await invoke(IPC.loadPage, 'New.md')).manifest).toBeTruthy()
  await fs.writeFile(path.join(local, 'Empty.md'), '')
  expect((await invoke(IPC.loadPage, 'Empty.md')).manifest).toBeTruthy()
  expect(await fs.readFile(path.join(local, 'Empty.md'), 'utf8')).toBe('')
})
