/**
 * Unit 远程写 ↔ 本机回灌的**通道映射**(评审 G1-04)。真 registerIpc(electron 打桩,照 ipc.move.test),
 * 量两个派发口实际发出去的事件名:
 *  - RPC 起源(另一台设备经 /vault/rpc 写,vaultFace.call)→ 本机每个窗口;
 *  - 渲染层起源(本机编辑器写,ipcMain handle)→ Unit 设备页的 SSE(vaultFace.onEvent)。
 * v4 笔记只走 `writeTextFile` 落盘,而 UnifiedPage 只听 externalChange(onExternalChange)——
 * 映射成 fileChange 就只进插件 watchFile,开着的编辑器永不回灌,下一击键把远端改动整篇盖掉。
 * 非笔记文件(按 isPagePath:插件片段 .js、画板、插件自定义 `.md` 文件类型)保持 fileChange,进插件 watchFile。
 * (与 watcher 的分流不同:watcher 对一切 .md 都发 externalChange、只有非 .md 发 fileChange。)
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => {
  const sent: Array<{ win: number; channel: string; payload: unknown }> = []
  const win = (id: number) => ({ isDestroyed: () => false, webContents: { id, send: (channel: string, payload: unknown) => sent.push({ win: id, channel, payload }) } })
  return { root: '', handlers: new Map<string, (...args: any[]) => any>(), sent, wins: [win(1), win(2)] }
})
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => env.wins }, dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => path.join(env.root, 'app-data'), defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => ({}) }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))

// 渲染层 invoke 的 sender 是窗口 1 的 webContents(D 包的 notifyPeers 按对象身份排除发起窗口)。
const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: env.wins[0].webContents }, ...args)
let runtime: Awaited<ReturnType<typeof import('./ipc')['registerIpc']>>
let remote: Array<{ channel: string; payload: unknown; origin: string | null }>
let local: string
beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-ipc-unit-events-'))
  env.handlers.clear()
  env.sent.length = 0
  local = path.join(env.root, 'notes')
  await fs.mkdir(path.join(local, 'Snippets'), { recursive: true })
  await fs.writeFile(path.join(local, 'A.md'), '# A\n\nbase\n')
  const { writeConfig } = await import('./settings')
  await writeConfig({ localVault: local, lastVault: local })
  // 插件声明的自定义文件类型(`.mindmap.md` 这类):不是笔记,listPages 排除,事件也不该当页面发。
  const { VaultManager } = await import('./fs/vaultManager')
  const orig = VaultManager.prototype.setPluginFileExtensions
  vi.spyOn(VaultManager.prototype, 'setPluginFileExtensions').mockImplementation(function (this: InstanceType<typeof VaultManager>, exts: string[]) {
    orig.call(this, [...exts, '.mindmap.md'])
  })
  const { registerIpc } = await import('./ipc')
  const { IPC } = await import('@amadeus-shared/ipc')
  runtime = registerIpc(() => null)
  await invoke(IPC.restoreVault)
  remote = []
  runtime.vaultFace.onEvent((channel, payload, origin) => { remote.push({ channel, payload, origin }) })
  env.sent.length = 0
})
afterEach(async () => { await runtime?.stopSync(); vi.restoreAllMocks(); await fs.rm(env.root, { recursive: true, force: true }) })

it('另一台设备经 Unit RPC 写 v4 笔记 → 本机每个窗口收到 externalChange(开着的编辑器回灌),不是只进插件 watchFile 的 fileChange', async () => {
  const { IPC } = await import('@amadeus-shared/ipc')
  await runtime.vaultFace.call(IPC.writeTextFile, ['A.md', '# A\n\nfrom phone\n'], 'phone-1')
  expect(await fs.readFile(path.join(local, 'A.md'), 'utf8')).toBe('# A\n\nfrom phone\n')
  const toWindows = env.sent.filter((s) => s.payload === 'A.md')
  expect(toWindows.map((s) => `${s.win}:${s.channel}`).sort()).toEqual([`1:${IPC.externalChange}`, `2:${IPC.externalChange}`])
  // 其余 Unit 设备页同样按外部改动回灌;写入者自己按 origin 丢回声。
  expect(remote).toEqual([{ channel: IPC.externalChange, payload: 'A.md', origin: 'phone-1' }])
})

it('反方向:本机编辑器写 v4 笔记 → Unit 设备页 SSE 收到 externalChange(origin=host),远端开着的编辑器回灌', async () => {
  const { IPC } = await import('@amadeus-shared/ipc')
  await invoke(IPC.writeTextFile, 'A.md', '# A\n\nfrom desktop\n')
  expect(remote).toEqual([{ channel: IPC.externalChange, payload: 'A.md', origin: 'host' }])
  // 本机:发起窗口不回发,其余窗口由 D 包的 notifyPeers 回灌(G1-01),这里只核它没被改坏。
  expect(env.sent.map((s) => `${s.win}:${s.channel}:${String(s.payload)}`)).toEqual([`2:${IPC.externalChange}:A.md`])
})

it.each([
  ['Snippets/latex.js', 'export default []\n'],
  ['Boards/plan.excalidraw.md', '---\nexcalidraw-plugin: parsed\n---\n'],
  ['Maps/idea.mindmap.md', '# idea\n'],
])('非笔记文件 %s:两个方向都保持 fileChange(插件 watchFile 的既有契约)', async (file, text) => {
  const { IPC } = await import('@amadeus-shared/ipc')
  await fs.mkdir(path.join(local, path.dirname(file)), { recursive: true })
  await runtime.vaultFace.call(IPC.writeTextFile, [file, text], 'phone-1')
  expect(env.sent.map((s) => `${s.win}:${s.channel}:${String(s.payload)}`).sort()).toEqual([`1:${IPC.fileChange}:${file}`, `2:${IPC.fileChange}:${file}`])
  expect(remote).toEqual([{ channel: IPC.fileChange, payload: file, origin: 'phone-1' }])
  remote.length = 0
  env.sent.length = 0
  await invoke(IPC.writeTextFile, file, `${text}\n`)
  expect(remote).toEqual([{ channel: IPC.fileChange, payload: file, origin: 'host' }])
  expect(env.sent).toEqual([])
})

// 收口 N-9:带 base 的 writeTextFile 与 dbWriteCas 是比对交换写 —— 被拒(`{ ok:false }`)= 什么都没写,不许叫别的
// 编辑器 / 设备回灌(同 unit/localVault 的派发口)。两个派发口都量:RPC 起源(vaultFace.call)与渲染层起源(ipcMain handle)。
it('CAS 被拒(过期 base 的 writeTextFile / 过期版本的 dbWriteCas)= 没写:两个派发口都不发回灌事件', async () => {
  const { IPC } = await import('@amadeus-shared/ipc')
  expect(await runtime.vaultFace.call(IPC.writeTextFile, ['A.md', '# A\n\nstale phone\n', { base: 'stale-fingerprint' }], 'phone-1')).toMatchObject({ ok: false, current: '# A\n\nbase\n' })
  expect(await invoke(IPC.writeTextFile, 'A.md', '# A\n\nstale desktop\n', { base: 'stale-fingerprint' })).toMatchObject({ ok: false, current: '# A\n\nbase\n' })
  expect(await fs.readFile(path.join(local, 'A.md'), 'utf8')).toBe('# A\n\nbase\n')
  expect(remote).toEqual([])
  expect(env.sent).toEqual([])

  const { emptyDb } = await import('@amadeus-shared/db/schema')
  await invoke(IPC.dbWrite, 'T.db', emptyDb('T'))
  const saved = await invoke(IPC.dbRead, '', 'T.db') as { status: string; data: unknown; version: string }
  expect(saved.status).toBe('ok')
  remote.length = 0
  env.sent.length = 0
  expect(await runtime.vaultFace.call(IPC.dbWriteCas, ['T.db', saved.data, 'stale-version'], 'phone-1')).toMatchObject({ ok: false })
  expect(await invoke(IPC.dbWriteCas, 'T.db', saved.data, 'stale-version')).toMatchObject({ ok: false })

  expect(remote).toEqual([])
  expect(env.sent).toEqual([])
  // 对照:版本对得上的 CAS 写照常广播(判据只拦被拒的那种)
  expect(await runtime.vaultFace.call(IPC.dbWriteCas, ['T.db', saved.data, saved.version], 'phone-1')).toMatchObject({ ok: true })
  expect(remote).toEqual([{ channel: IPC.dbChange, payload: 'T.db', origin: 'phone-1' }])
})
