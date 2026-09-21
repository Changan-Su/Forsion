/**
 * Forsion Sandbox 的**主进程**那半(2026-09-21):托管根里开了 devLoad 的插件项目当外置来源发给渲染层。
 * 钉四件会静默出事的:
 *  ① 开发副本**遮蔽**同 id 的安装版(先扫先赢),且 shadowsInstalled 如实回传 —— 否则 Studio 分不清自己改的是哪一份;
 *  ② 判据是磁盘上的 manifest.json,不是 product.kind:清单打错一个字符,detectKind 会把项目判回 web,
 *     按 kind 过滤 = 插件从列表里凭空消失、安装版还悄悄顶回来(开发者只看到「我的改动没生效」);
 *  ③ 声明 fileExtensions 的开发副本必须 blocked:'dev-fileext' 且**不发代码** —— 扩展名保护只扫全局 plugins 目录,
 *     开发副本造出来的自定义类型文件没人护着,会被笔记 compiler 改写 = 毁档;
 *  ④ 开发副本遮蔽期间卸载必须**拒绝**:uninstallPlugin 只扫全局目录,删的是安装版而跑的是开发副本。
 * 另钉两条边界:unit 自服面(不传 dev)绝不发开发代码;一个插件都没装(全局目录不存在)时开发副本照样发。
 * 负对照见文件末尾注释。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>(), seq: 0 }))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, getVersion: () => '9.9.9', once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {},
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
vi.mock('./sync/sseClient', () => ({ startSse: () => ({ stop: vi.fn() }) }))

const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)
let stop: (() => Promise<void>) | undefined
let runtime: { readExternalPlugins: () => Promise<ExternalPluginSource[]> }

/** 装一个「已安装」插件:~/.forsion/plugins/<dir>/。 */
async function installed(dir: string, manifest: Record<string, unknown>, code = 'ctx.installed = true'): Promise<string> {
  const pdir = path.join(env.root, 'app-data', 'plugins', dir)
  await fs.mkdir(pdir, { recursive: true })
  await fs.writeFile(path.join(pdir, 'manifest.json'), JSON.stringify(manifest))
  await fs.writeFile(path.join(pdir, 'main.js'), code)
  return pdir
}

/** 建一个托管项目:~/Forsion/Project/<dir>/。manifest 传 null = 不写清单(纯 web 项目)。
 *  devLoad = 往**宿主家目录**的授权名单里登记(id + 真实根)—— 授权不住在项目 sidecar 里(那里不可信)。 */
async function project(
  dir: string,
  opts: { devLoad?: boolean; manifest?: Record<string, unknown> | string | null; code?: string | null; files?: Record<string, string> } = {},
): Promise<string> {
  const pdir = path.join(env.root, 'workspace', 'Project', dir)
  await fs.mkdir(pdir, { recursive: true })
  const id = `p_${(++env.seq).toString(16).padStart(12, '0')}`
  await fs.writeFile(path.join(pdir, '.forsion-product.json'), JSON.stringify({ version: 1, id, createdAt: Date.now() }))
  if (opts.devLoad) {
    const { setDevLoad } = await import('../devLoadStore')
    setDevLoad(path.join(env.root, 'app-data'), { id, root: await fs.realpath(pdir) }, true)
  }
  if (opts.manifest !== null && opts.manifest !== undefined) {
    await fs.writeFile(path.join(pdir, 'manifest.json'), typeof opts.manifest === 'string' ? opts.manifest : JSON.stringify(opts.manifest))
  }
  if (opts.code !== null) await fs.writeFile(path.join(pdir, 'main.js'), opts.code ?? 'ctx.dev = true')
  for (const [name, text] of Object.entries(opts.files ?? {})) await fs.writeFile(path.join(pdir, name), text)
  return pdir
}

const DEV_MANIFEST = { id: 'demo', name: '开发中的插件', version: '0.1.0', apiVersion: 1, main: 'main.js' }

async function boot(): Promise<void> {
  const { registerIpc } = await import('./ipc')
  runtime = registerIpc(() => null) as unknown as typeof runtime
  stop = (runtime as unknown as { stopSync: () => Promise<void> }).stopSync
}
const list = (): Promise<ExternalPluginSource[]> => invoke('plugins:list') as Promise<ExternalPluginSource[]>

beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-devplugins-'))
  env.handlers.clear()
  const local = path.join(env.root, 'notes')
  await fs.mkdir(local)
  const { writeConfig } = await import('./settings')
  await writeConfig({ localVault: local, lastVault: local })
})
afterEach(async () => { await stop?.(); await fs.rm(env.root, { recursive: true, force: true }) })

it('开发副本遮蔽同 id 的安装版,并标出 shadowsInstalled / devRoot / devProductId', async () => {
  await installed('demo', { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, main: 'main.js' }, 'ctx.fromInstalled = 1')
  const root = await project('demo-dev', { devLoad: true, manifest: DEV_MANIFEST, code: 'ctx.fromDev = 1' })
  await boot()
  const plugins = (await list()).filter((p) => p.id === 'demo')
  expect(plugins).toHaveLength(1) // 两份只出一份
  expect(plugins[0].dev).toBe(true)
  expect(plugins[0].code).toBe('ctx.fromDev = 1') // 跑的是开发副本
  expect(plugins[0].shadowsInstalled).toBe(true)
  expect(plugins[0].devRoot).toBe(await fs.realpath(root))
  expect(plugins[0].devProductId).toMatch(/^p_[0-9a-f]{12}$/)
  expect(plugins[0].preinstalled).toBeUndefined()
})

it('没有安装版时 shadowsInstalled 为假(撤下开发副本不会有东西回来)', async () => {
  await project('demo-dev', { devLoad: true, manifest: DEV_MANIFEST })
  await boot()
  const dev = (await list()).find((p) => p.id === 'demo')!
  expect(dev.dev).toBe(true)
  expect(dev.shadowsInstalled).toBeFalsy()
})

it('devLoad 为 false 的项目不进插件宿主,安装版照常生效', async () => {
  await installed('demo', { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, main: 'main.js' }, 'ctx.fromInstalled = 1')
  await project('demo-dev', { devLoad: false, manifest: DEV_MANIFEST, code: 'ctx.fromDev = 1' })
  await boot()
  const plugins = (await list()).filter((p) => p.id === 'demo')
  expect(plugins).toHaveLength(1)
  expect(plugins[0].dev).toBeFalsy()
  expect(plugins[0].code).toBe('ctx.fromInstalled = 1')
})

it('没有 manifest.json 的项目(web 产物)即使开了 devLoad 也不列', async () => {
  await project('site', { devLoad: true, manifest: null, code: null, files: { 'index.html': '<h1>hi</h1>' } })
  await boot()
  expect(await list()).toEqual([])
})

it('⚠️清单写坏 → 列出为 blocked:invalid 带原因,绝不凭空消失(此刻 product.kind 已经不是 plugin 了)', async () => {
  await project('demo-dev', { devLoad: true, manifest: '{ "id": "demo", broken', code: 'ctx.fromDev = 1' })
  await boot()
  const dev = (await list()).find((p) => p.dev)
  expect(dev, '清单坏掉的开发副本必须仍然列出').toBeTruthy()
  expect(dev!.id).toBe('demo-dev') // manifest id 读不出来 → 回退目录名
  expect(dev!.blocked).toBe('invalid')
  expect(dev!.blockedReason).toMatch(/manifest\.json unparsable/)
  expect(dev!.code).toBe('') // 拒载 = 一个字节的代码都不发
})

it('⚠️声明 fileExtensions 的开发副本 → blocked:dev-fileext 且不发代码(扩展名保护只覆盖全局目录)', async () => {
  await project('demo-dev', { devLoad: true, manifest: { ...DEV_MANIFEST, fileExtensions: ['.demo.md'] }, code: 'ctx.fromDev = 1' })
  await boot()
  const dev = (await list()).find((p) => p.id === 'demo')!
  expect(dev.blocked).toBe('dev-fileext')
  expect(dev.blockedReason).toMatch(/fileExtensions/)
  expect(dev.code).toBe('')
  expect(dev.fileExtensions).toBeUndefined() // 透出去 = 下游误以为这套后缀受保护
})

it('main 读不到 → blocked:invalid 带原因(不是静默少一个插件)', async () => {
  await project('demo-dev', { devLoad: true, manifest: DEV_MANIFEST, code: null })
  await boot()
  const dev = (await list()).find((p) => p.dev)!
  expect(dev.blocked).toBe('invalid')
  expect(dev.blockedReason).toMatch(/main\.js unreadable/)
})

it('apiVersion 门禁对开发副本照样生效', async () => {
  await project('demo-dev', { devLoad: true, manifest: { ...DEV_MANIFEST, apiVersion: 99 } })
  await boot()
  const dev = (await list()).find((p) => p.id === 'demo')!
  expect(dev.blocked).toBe('api')
  expect(dev.code).toBe('')
})

it('一个插件都没装(全局 plugins 目录不存在)时,开发副本照样发得出去', async () => {
  await project('demo-dev', { devLoad: true, manifest: DEV_MANIFEST })
  await boot()
  expect((await list()).map((p) => p.id)).toContain('demo')
})

it('unit 自服面(不传 dev)绝不把开发机上的代码发给远端渲染器', async () => {
  await project('demo-dev', { devLoad: true, manifest: DEV_MANIFEST, code: 'ctx.fromDev = 1' })
  await boot()
  expect(await runtime.readExternalPlugins()).toEqual([])
  expect((await list()).some((p) => p.dev)).toBe(true) // 同一份代码,桌面 IPC 那条照常给
})

it('⚠️开发副本遮蔽期间卸载必须拒绝(否则删掉的是安装版,跑着的开发副本还在)', async () => {
  const pdir = await installed('demo', { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, main: 'main.js' })
  await project('demo-dev', { devLoad: true, manifest: DEV_MANIFEST })
  await boot()
  await expect(invoke('plugins:uninstall-forsion', 'demo')).rejects.toThrow(/dev-shadowed/)
  await expect(fs.access(path.join(pdir, 'manifest.json'))).resolves.toBeUndefined() // 安装版一个字节都没动
})

it('没有开发副本时卸载照常执行(正对照:拒绝不是一刀切)', async () => {
  const pdir = await installed('demo', { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, main: 'main.js' })
  await boot()
  await expect(invoke('plugins:uninstall-forsion', 'demo')).resolves.toBeUndefined()
  await expect(fs.access(pdir)).rejects.toThrow()
})

// 负对照(已实跑,见交付说明):
//  · readExternalPlugins 里把 devSources 挪到全局目录之后再 push → 「遮蔽」与 shadowsInstalled 两条红;
//  · readDevPlugins 改成按 product.kind === 'plugin' 过滤 → 「清单写坏」那条红(kind 掉回 unknown,插件消失);
//  · 去掉 dev-fileext 分支 → 该条红(code 被发出去);
//  · 去掉 uninstall 的 dev-shadowed 闸 → 卸载那条红(安装版被删)。

it('⚠️零点击攻击面:项目 sidecar 自带 devLoad:true(克隆 / 解压来的文件夹)**不会**被当成插件来源', async () => {
  // 评审 HIGH 的原样复现:一个文件夹落进托管根,自带写好的 sidecar + manifest + main.js。授权名单里没有它 → 不列、不执行。
  const pdir = path.join(env.root, 'workspace', 'Project', 'cloned-evil')
  await fs.mkdir(pdir, { recursive: true })
  await fs.writeFile(path.join(pdir, '.forsion-product.json'), JSON.stringify({ version: 1, id: 'p_0123456789ab', createdAt: 1, devLoad: true }))
  await fs.writeFile(path.join(pdir, 'manifest.json'), JSON.stringify({ ...DEV_MANIFEST, id: 'evil' }))
  await fs.writeFile(path.join(pdir, 'main.js'), 'ctx.pwned = true')
  await boot()
  expect((await list()).some((s) => s.id === 'evil')).toBe(false)
})

it('⚠️授权按「id + 真实根」双钥匙:同 id 的 sidecar 被搬进另一个目录,授权不跟着走', async () => {
  const root = await project('demo-dev', { devLoad: true, manifest: DEV_MANIFEST, code: 'ctx.fromDev = 1' })
  // 把授权过的项目整个挪走,原地换成一个带同 id sidecar 的别的文件夹(「同 id 冒名」)。
  const sidecar = await fs.readFile(path.join(root, '.forsion-product.json'), 'utf8')
  await fs.rename(root, path.join(env.root, 'moved-away'))
  const impostor = path.join(env.root, 'workspace', 'Project', 'impostor')
  await fs.mkdir(impostor, { recursive: true })
  await fs.writeFile(path.join(impostor, '.forsion-product.json'), sidecar)
  await fs.writeFile(path.join(impostor, 'manifest.json'), JSON.stringify(DEV_MANIFEST))
  await fs.writeFile(path.join(impostor, 'main.js'), 'ctx.impostor = 1')
  await boot()
  expect((await list()).some((s) => s.dev)).toBe(false)
})

it('⚠️清单写坏期间沿用授权当时的插件 id:身份不漂到目录名,被影子的安装版也不会悄悄回来', async () => {
  // 目录叫 cool-project、清单 id 是 demo。少一个逗号 → 装载器读不出 id;若退回目录名,开发副本的报错就挂到
  // `cool-project` 上没人看,而安装版 `demo` 不再被影子、自己跑了起来(Codex 评审)。
  await installed('demo', { id: 'demo', name: '安装版', version: '1.0.0', apiVersion: 1, main: 'main.js' })
  const pdir = path.join(env.root, 'workspace', 'Project', 'cool-project')
  await fs.mkdir(pdir, { recursive: true })
  const id = 'p_00000000beef'
  await fs.writeFile(path.join(pdir, '.forsion-product.json'), JSON.stringify({ version: 1, id, createdAt: Date.now() }))
  await fs.writeFile(path.join(pdir, 'manifest.json'), '{ "id": "demo", broken')
  await fs.writeFile(path.join(pdir, 'main.js'), 'ctx.dev = 1')
  const { setDevLoad } = await import('../devLoadStore')
  setDevLoad(path.join(env.root, 'app-data'), { id, root: await fs.realpath(pdir), pluginId: 'demo' }, true)
  await boot()
  const sources = await list()
  expect(sources.filter((s) => s.id === 'demo')).toHaveLength(1)
  expect(sources.find((s) => s.id === 'demo')).toMatchObject({ dev: true, blocked: 'invalid', code: '' })
  expect(sources.some((s) => s.id === 'cool-project')).toBe(false)
})
