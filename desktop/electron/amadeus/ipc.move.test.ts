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

// 跨接缝的物理回滚(Codex 0.4 评审 P2):Extend 的写钩子(条目移动的配置 / 云端移动日志)抛错时,宿主 VaultManager 要把已挪走的文件放回原路径。
// 引擎那半的配置 / scope 回滚在 Extend 的 amadeusCloud.entrymove.test;这里用一个只会抛错的假工厂钉宿主这半。
it('a cloud move hook that throws makes movePage reject and the file is put back where it was', async () => {
  await stop?.()
  env.handlers.clear()
  const { registerIpc } = await import('./ipc')
  const { IPC } = await import('@amadeus-shared/ipc')
  const runtime = registerIpc(() => null, (deps) => {
    deps.setMutationHooks(() => {}, async () => { throw Object.assign(new Error('ENOSPC journal'), { code: 'ENOSPC' }) }, () => undefined)
    return { start() {}, stopAllSync: async () => {}, restartAllSync: async () => {} }
  })
  stop = runtime.stopSync
  await invoke(IPC.restoreVault)
  await expect(invoke(IPC.movePage, 'A.md', 'Dest')).rejects.toThrow('ENOSPC')
  expect(await fs.readFile(path.join(local, 'A.md'), 'utf8')).toBe('# A\n\nOriginal content\n')
  await expect(fs.access(path.join(local, 'Dest', 'A.md'))).rejects.toThrow()
})
