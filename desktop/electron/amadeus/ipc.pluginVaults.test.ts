/**
 * 插件 ctx.app.vaults 的主进程那半(2026-11-27):读失败 ≠ 空 —— 配置坏了 / 读不出来时 reject,首启没有配置才是空;
 * 当前挂着的库标 current;这条不进 vault 面派发表(设备页的 /vault/rpc 拿不到本机绝对路径)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  root: '', creds: {} as { cloudUrl?: string; token?: string },
  handlers: new Map<string, (...args: any[]) => any>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => path.join(env.root, 'app-data'), defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => env.creds }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))
const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)
const configFile = () => path.join(env.root, 'amadeus-config.json')

beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-ipc-plugin-vaults-'))
  env.handlers.clear()
})
afterEach(async () => { await fs.rm(env.root, { recursive: true, force: true }) })

async function boot() {
  const { registerIpc } = await import('./ipc')
  const { IPC } = await import('@amadeus-shared/ipc')
  // 假的 Extend 工厂:只为拿到宿主递过去的 activateRoot(云端模式切到镜像根走的就是它)
  let activateRoot: ((root: string, keepLastPage: boolean) => Promise<unknown>) | null = null
  const factory = ((deps: { activateRoot: typeof activateRoot }) => {
    activateRoot = deps.activateRoot
    return { start: () => {}, restartAllSync: async () => {}, stopAllSync: async () => {} }
  }) as unknown as Parameters<typeof registerIpc>[1]
  const runtime = registerIpc(() => null, factory)
  return { IPC, runtime, activateRoot: (root: string) => activateRoot!(root, false) }
}

it('lists the local vaults with the mounted one marked current', async () => {
  const a = path.join(env.root, 'Notes A'), b = path.join(env.root, 'Notes B'), gone = path.join(env.root, 'Unplugged')
  await fs.mkdir(a); await fs.mkdir(b)
  await fs.writeFile(configFile(), JSON.stringify({ lastVault: b, localVault: b, vaults: [{ root: a }, { root: b }, { root: gone }] }))
  const { IPC } = await boot()
  await invoke(IPC.restoreVault)
  expect(await invoke(IPC.pluginVaults)).toEqual([
    { root: a, name: 'Notes A', current: false, cloud: false },
    { root: b, name: 'Notes B', current: true, cloud: false },
    { root: gone, name: 'Unplugged', current: false, cloud: false }, // 文件夹不在也留着,不让插件以为库被删了
  ])
})

it('flags the mounted cloud mirror as cloud and current', async () => {
  const { cloudVaultDir } = await import('./cloudPaths')
  const local = path.join(env.root, 'Local')
  await fs.mkdir(local)
  await fs.writeFile(configFile(), JSON.stringify({ lastVault: local, localVault: local }))
  const { IPC, activateRoot } = await boot()
  await invoke(IPC.restoreVault)
  const mirror = cloudVaultDir()
  await fs.mkdir(mirror, { recursive: true })
  await activateRoot(mirror)
  const rows = await invoke(IPC.pluginVaults)
  expect(rows).toEqual([
    { root: local, name: 'Local', current: false, cloud: false },
    { root: mirror, name: 'Cloud', current: true, cloud: true },
  ])
})

it('read failure is not an empty list: a corrupt or zero-byte config rejects', async () => {
  await fs.writeFile(configFile(), '')
  const { IPC } = await boot()
  await expect(invoke(IPC.pluginVaults)).rejects.toThrow('amadeus-config-unreadable')
})

it('a config that is not a JSON object rejects too', async () => {
  await fs.writeFile(configFile(), '["/somewhere"]')
  const { IPC } = await boot()
  await expect(invoke(IPC.pluginVaults)).rejects.toThrow('amadeus-config-unreadable')
})

it('no config file at all (first launch) is a real empty list', async () => {
  const { IPC } = await boot()
  expect(await invoke(IPC.pluginVaults)).toEqual([])
})

it('is not reachable through the vault RPC table the device page uses', async () => {
  const { IPC, runtime } = await boot()
  await invoke(IPC.restoreVault)
  await expect(runtime.vaultFace.call(IPC.listFiles, [])).resolves.toBeDefined() // 对照:vault 面的通道走得通
  await expect(runtime.vaultFace.call(IPC.pluginVaults, [])).rejects.toThrow(/unknown vault channel/)
  await expect(runtime.vaultFace.call(IPC.listVaults, [])).rejects.toThrow(/unknown vault channel/) // 同一口径:菜单清单也不给远端
})
