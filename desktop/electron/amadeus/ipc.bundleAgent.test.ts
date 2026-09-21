// ctx.tangu.startChat 的 send:true 归属判定主进程半(2026-09-19 评审 host-seams HIGH):
// bundle.agents 只说明「插件目录里有 agents/<slug>/」,引擎对已存在的 slug 永不覆盖 → 只看清单就能对别人的 Agent 直发。
// 引擎新播种时写 <tanguDataDir>/agents/<slug>/.bundle-origin = bundle 目录名;bundleAgentOwned 比它与本插件的目录名。
// 负对照(已实跑红):把比对对象从目录名换成 pluginId → 「manifest id ≠ 目录名」用例红;
// 去掉读标记、只看插件目录在不在 → 「撞名 / 别家标记」用例红。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>() }))
// clipboard / nativeImage:ipc.ts 顶层 import 了(copyAttachment),本用例不走那条路,垫空对象防御性占位。
vi.mock('electron', () => ({
  app: { getPath: () => env.root, getVersion: () => '99.0.0', once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {}, clipboard: {}, nativeImage: {},
  ipcMain: { handle: (key: string, fn: (...args: any[]) => any) => env.handlers.set(key, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => env.root, tanguDataDir: () => path.join(env.root, 'tangu'), defaultWorkspaceDir: () => env.root,
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => ({}) }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))

let stop: undefined | (() => Promise<void>)
beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-bundle-agent-'))
  env.handlers.clear()
})
afterEach(async () => { await stop?.(); stop = undefined; await fs.rm(env.root, { recursive: true, force: true }) })

async function plugin(dir: string, manifest: Record<string, unknown>, agents: string[]): Promise<void> {
  const p = path.join(env.root, 'plugins', dir)
  await fs.mkdir(p, { recursive: true })
  await fs.writeFile(path.join(p, 'manifest.json'), JSON.stringify({ name: dir, version: '1.0.0', ...manifest }))
  for (const a of agents) {
    await fs.mkdir(path.join(p, 'agents', a), { recursive: true })
    await fs.writeFile(path.join(p, 'agents', a, 'config.toml'), `name = "${a}"\n`)
  }
}
/** 模拟引擎播种后的 agents 根:marker=null 表示「已存在、引擎没写标记」(用户自建 / 默认 agent / 别家先播)。 */
async function engineAgent(slug: string, marker: string | null): Promise<void> {
  const d = path.join(env.root, 'tangu', 'agents', slug)
  await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(d, 'config.toml'), `name = "${slug}"\n`)
  if (marker !== null) await fs.writeFile(path.join(d, '.bundle-origin'), marker)
}
async function owned(): Promise<(pluginId: unknown, slug: unknown) => Promise<boolean>> {
  const { registerIpc } = await import('./ipc')
  const { IPC } = await import('@amadeus-shared/ipc')
  stop = registerIpc(() => null).stopSync
  const h = env.handlers.get(IPC.bundleAgentOwned)
  expect(h, 'IPC.bundleAgentOwned 没注册').toBeTypeOf('function')
  return (pluginId, slug) => h!({ sender: { id: 1 } }, pluginId, slug)
}

it('标记 = 本插件目录名 → true;manifest id 与目录名不同也按目录名比(引擎写的是目录名)', async () => {
  await plugin('dir-name', { id: 'manifest-id' }, ['fresh-one'])
  await plugin('plain', {}, ['plain-agent']) // 无 manifest id → pluginIdOf 回退目录名
  await engineAgent('fresh-one', 'dir-name\n')
  await engineAgent('plain-agent', 'plain')
  const ask = await owned()
  expect(await ask('manifest-id', 'fresh-one')).toBe(true)
  expect(await ask('plain', 'plain-agent')).toBe(true)
  expect(await ask('dir-name', 'fresh-one')).toBe(false) // 目录名不是插件 id:按 id 找不到插件
})

it('撞名(已存在的 agent 没有标记)/ 标记是别家插件 / agent 不存在 → false', async () => {
  await plugin('live3d', { id: 'live3d' }, ['xyra', 'importer', 'ghost'])
  await plugin('other', { id: 'other' }, ['importer'])
  await engineAgent('xyra', null) // 用户自己的 xyra:引擎永不覆盖、永不写标记
  await engineAgent('importer', 'other') // 别家插件先播种
  const ask = await owned()
  expect(await ask('live3d', 'xyra')).toBe(false)
  expect(await ask('live3d', 'importer')).toBe(false)
  expect(await ask('other', 'importer')).toBe(true)
  expect(await ask('live3d', 'ghost')).toBe(false)
})

it('入参非法 / 插件不存在 / 标记不是普通小文件 → false,不抛', async () => {
  await plugin('p', { id: 'p' }, ['a', 'dir-marker'])
  await engineAgent('a', 'p')
  await fs.mkdir(path.join(env.root, 'tangu', 'agents', 'dir-marker', '.bundle-origin'), { recursive: true })
  const ask = await owned()
  for (const [pid, slug] of [['p', '../a'], ['p', 'A'], ['../p', 'a'], [42, 'a'], ['p', null], ['nope', 'a']] as const) {
    expect(await ask(pid, slug), `${String(pid)} / ${String(slug)}`).toBe(false)
  }
  expect(await ask('p', 'dir-marker')).toBe(false)
  await fs.writeFile(path.join(env.root, 'tangu', 'agents', 'a', '.bundle-origin'), 'p' + ' '.repeat(400))
  expect(await ask('p', 'a')).toBe(false) // 超长(> 256 字节)不读
})
