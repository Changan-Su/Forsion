/**
 * 插件私有数据的**主进程**那半(2026-11-17,读失败 ≠ 没写过):
 *  ① 文件不存在 → null;② 读出错(这里用「同名的是个目录」造 EISDIR,root 跑也造得出来)→ 抛,不再回 null;
 *  ③ 零字节 / 半截 JSON → 原文照回(由渲染层 pluginLocalData 判成读失败),但记下来;
 *  ④ 读到坏内容之后插件仍要写 → 先把原件另存成 <id>.json.unreadable-<时间>,再写;读成功过的不另存;
 *  ⑤ 读出错之后连原件都拷不出来 → 拒绝这次写,原件不动;
 *  ⑥ 记号不被之后别处的成功读取清掉(拿到读失败的插件手里仍是默认值);⑦⑧ 同一个文件的并发写排队,临时文件 / 备份名不撞;
 *  ⑨ 渲染层要求先另存(同步拉云端那份盖「读失败后按默认值存下的」本机数据)→ 现有那份另存成 <id>.json.replaced-<时间>;
 *     没有现有那份就直接写;拷不出来 → 拒写,原件不动。
 * 负对照:把 pluginDataRead 改回 catch 一律 null → ② 红;去掉写之前的另存 → ④ 红;另存失败照写 → ⑤ 红;
 *  成功读取清记号 → ⑥ 红;写不排队 → ⑦ 或 ⑧ 红(看是否撞在同一毫秒)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, getVersion: () => '9.9.9', once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => ({}) }, dialog: {},
  shell: { showItemInFolder: vi.fn(), openPath: async () => '' },
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false,
  forsionHomeDir: () => path.join(env.root, 'app-data'),
  tanguDataDir: () => path.join(env.root, 'app-data', 'tangu'),
  defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => ({}) }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))

const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)
const read = (id: string) => invoke('plugins:data-read', id) as Promise<string | null>
const write = (id: string, text: string, opts?: { backup?: boolean }) => invoke('plugins:data-write', id, text, opts) as Promise<void>
const dataDir = () => path.join(env.root, 'app-data', 'plugins-data')
const backups = async (id: string) => (await fs.readdir(dataDir())).filter((n) => n.startsWith(`${id}.json.unreadable-`))
let stop: (() => Promise<void>) | undefined

beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-plugindata-'))
  env.handlers.clear()
  const local = path.join(env.root, 'notes')
  await fs.mkdir(local)
  await fs.mkdir(dataDir(), { recursive: true })
  const { writeConfig } = await import('./settings')
  await writeConfig({ localVault: local, lastVault: local })
  const { registerIpc } = await import('./ipc')
  stop = (registerIpc(() => null) as unknown as { stopSync: () => Promise<void> }).stopSync
})
afterEach(async () => { await stop?.(); await fs.rm(env.root, { recursive: true, force: true }) })

it('① 没写过 → null;写了读回原文', async () => {
  expect(await read('demo')).toBeNull()
  await write('demo', '{"a":1}')
  expect(await read('demo')).toBe('{"a":1}')
  expect(await backups('demo')).toEqual([])
})

it('② 读出错 → 抛出去,不当没写过', async () => {
  await fs.mkdir(path.join(dataDir(), 'demo.json'))
  await expect(read('demo')).rejects.toThrow()
})

it('③ 零字节 / 半截 JSON → 原文照回(渲染层判读失败)', async () => {
  await fs.writeFile(path.join(dataDir(), 'zero.json'), '')
  await fs.writeFile(path.join(dataDir(), 'half.json'), '{"snippets":"abc')
  expect(await read('zero')).toBe('')
  expect(await read('half')).toBe('{"snippets":"abc')
})

it('④ 读到坏内容后插件仍要写 → 先另存原件再写;读成功过的不另存', async () => {
  const original = '{"snippetsSourceText":"[{trigger:\\"mk\\", replacement: \\"$$0$\\"}'
  await fs.writeFile(path.join(dataDir(), 'demo.json'), original)
  await read('demo')
  await write('demo', '{"fresh":true}')
  const saved = await backups('demo')
  expect(saved).toHaveLength(1)
  expect(await fs.readFile(path.join(dataDir(), saved[0]), 'utf8')).toBe(original)
  expect(await read('demo')).toBe('{"fresh":true}')
  await write('demo', '{"fresh":2}') // 已经读成功过:不再另存
  expect(await backups('demo')).toHaveLength(1)
})

it('⑤ 读出错之后原件拷不出来 → 拒绝这次写,原件不动', async () => {
  const target = path.join(dataDir(), 'demo.json')
  await fs.writeFile(target, '{"user":"data"}')
  const eio = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
  const readSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(eio)
  const copySpy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(eio)
  try {
    await expect(read('demo')).rejects.toThrow(/EIO/)
    await expect(write('demo', '{"defaults":true}')).rejects.toThrow(/not overwriting/)
  } finally {
    readSpy.mockRestore(); copySpy.mockRestore()
  }
  expect(await fs.readFile(target, 'utf8')).toBe('{"user":"data"}')
})

it('⑥ 读出错过一次,之后别处读成功了,拿到读失败的那个插件再写 → 照样先另存原件', async () => {
  const target = path.join(dataDir(), 'demo.json')
  await fs.writeFile(target, '{"user":"data"}')
  const spy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }))
  try { await expect(read('demo')).rejects.toThrow(/EBUSY/) } finally { spy.mockRestore() }
  expect(await read('demo')).toBe('{"user":"data"}') // 另一个窗口 / 设备页读成功
  await write('demo', '{"defaults":true}') // 拿到读失败的插件按默认值存
  const saved = await backups('demo')
  expect(saved).toHaveLength(1)
  expect(await fs.readFile(path.join(dataDir(), saved[0]), 'utf8')).toBe('{"user":"data"}')
})

it('⑦ 同一个文件并发写(挤在同一毫秒):逐个写完,不撞临时文件,最后是最后一次的内容', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => write('demo', JSON.stringify({ n: i }))))
  expect(JSON.parse(await fs.readFile(path.join(dataDir(), 'demo.json'), 'utf8'))).toEqual({ n: 11 })
  expect((await fs.readdir(dataDir())).filter((n) => n.includes('.tmp-'))).toEqual([])
})

it('⑧ 读到坏内容后并发写两次:两次都写成(备份名不撞),原件留着', async () => {
  await fs.writeFile(path.join(dataDir(), 'demo.json'), '{"half":')
  await read('demo')
  await Promise.all([write('demo', '{"a":1}'), write('demo', '{"a":2}')])
  const saved = await backups('demo')
  expect(saved).toHaveLength(1)
  expect(await fs.readFile(path.join(dataDir(), saved[0]), 'utf8')).toBe('{"half":')
  expect(await read('demo')).toBe('{"a":2}')
})

it('⑨ 要求先另存 → 现有那份另存成 .replaced-<时间> 再写;没有现有那份直接写;拷不出来就拒写', async () => {
  const target = path.join(dataDir(), 'demo.json')
  await fs.writeFile(target, '{"defaults":1}')
  await write('demo', '{"from":"cloud"}', { backup: true })
  const replaced = (await fs.readdir(dataDir())).filter((n) => n.startsWith('demo.json.replaced-'))
  expect(replaced).toHaveLength(1)
  expect(await fs.readFile(path.join(dataDir(), replaced[0]), 'utf8')).toBe('{"defaults":1}')
  expect(await read('demo')).toBe('{"from":"cloud"}')

  await write('fresh', '{"a":1}', { backup: true })
  expect((await fs.readdir(dataDir())).filter((n) => n.startsWith('fresh.json.replaced-'))).toEqual([])
  expect(await read('fresh')).toBe('{"a":1}')

  const spy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
  try {
    await expect(write('demo', '{"from":"cloud2"}', { backup: true })).rejects.toThrow(/not overwriting/)
  } finally { spy.mockRestore() }
  expect(await read('demo')).toBe('{"from":"cloud"}')
})
