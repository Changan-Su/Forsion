// ctx.tangu.request 拼路由用的是包的**安装目录名**,不是插件 id(2026-10-13)。
// 引擎把包内引擎插件的路由挂在 `/extensions/<目录名>/<引擎插件 id>` 下(tangu-agent 的 registerScopedRoutes;
// lifecycle.test.ts 钉着),商店又按 install_slug 落目录、和清单里的 id 可以不一样 —— 以前这里拿插件 id 去拼,
// 两者不同的包(显示名「Jupyter Notebook」→ 目录 jupyter-notebook,id 是 notebook)页面调引擎那一半一律 404。
// 负对照(已实跑红):pluginStore 里改回 pluginRequestPath(pluginId, …) → 第一条红。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { TanguDesktopConfig } from '../../types'

const routes: string[] = []
vi.mock('../../services/backendService', () => ({
  request: vi.fn(async (_target: unknown, route: string) => { routes.push(route); return { ok: true } }),
}))

const { usePluginStore } = await import('./pluginStore')
const { setTanguProbe } = await import('./tanguSeam')
type Ctx = import('./types').PluginContext

const CFG: TanguDesktopConfig = { backendUrl: 'http://t', token: 'tok', modelId: '' }

function ctxOf(id: string, bundle: { dir?: string; enginePlugins: string[] }): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c: Ctx) => { ref = c }, bundle: { agents: [], skills: [], spaces: [], ...bundle } } as never])
  return ref!
}

beforeEach(() => {
  routes.length = 0
  setTanguProbe({
    activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {},
    waitBackend: async () => CFG, hostExecution: () => true,
  } as never)
})
afterEach(() => setTanguProbe(null))

describe('ctx.tangu.request 的路由', () => {
  it('安装目录名和插件 id 不一样:按目录名拼', async () => {
    const ctx = ctxOf('notebook', { dir: 'jupyter-notebook', enginePlugins: ['notebook-kernel'] })
    await ctx.tangu!.request!('notebook-kernel', '/status', { method: 'POST', body: {} })
    expect(routes).toEqual(['/extensions/jupyter-notebook/notebook-kernel/status'])
  })

  it('旧主进程 / 旧的远端宿主不报目录名:退回插件 id(从前的行为)', async () => {
    const ctx = ctxOf('notebook', { enginePlugins: ['notebook-kernel'] })
    await ctx.tangu!.request!('notebook-kernel', '/status')
    expect(routes).toEqual(['/extensions/notebook/notebook-kernel/status'])
  })

  it('不是本包的引擎插件照旧调不到', async () => {
    const ctx = ctxOf('notebook', { dir: 'jupyter-notebook', enginePlugins: ['notebook-kernel'] })
    await expect(ctx.tangu!.request!('someone-else', '/status')).rejects.toThrow(/not owned/)
    expect(routes).toEqual([])
  })
})
