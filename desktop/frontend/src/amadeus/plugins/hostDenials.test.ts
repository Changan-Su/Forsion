// 插件请求被宿主拒掉时的诊断(11-23,插件开发优化方案第七节 C):外部引擎模式下 ctx.tangu.request / connectChannel
// 照旧把原报错抛给插件,宿主另外在控制台 + 插件诊断里留一条,同一原因只记一次;请求成功后撤掉。
// 负对照(实跑):去掉 pluginStore 里 hostRefusal 的 noteHostDenial 调用 → 本文件 5 条全红。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TanguDesktopConfig } from '../../types'

vi.mock('../../services/backendService', () => ({
  request: vi.fn(async (_target: unknown, route: string) => {
    if (route === '/agent/channels') return { available: true, channels: [{ kind: 'chat', plugin: { fields: [{ key: 'appId' }], owner: { engine: 'chat-engine', bundle: 'acme-chat' } } }] }
    if (route.endsWith('/connect')) return { ok: true, accountId: 'acc', label: 'Chat', sessionId: 's1' }
    return { ok: true }
  }),
  listPlugins: vi.fn(async () => []),
}))

const { usePluginStore } = await import('./pluginStore')
const { setTanguProbe } = await import('./tanguSeam')
const { hostDenialsOf, resetHostDenialsForTest } = await import('./hostDenials')
const { getDevRecord } = await import('./devRecords')
const { pluginStatusForAgent, pluginProblemsForAgent } = await import('../../pluginSpaceHealth')
type Ctx = import('./types').PluginContext

const CFG: TanguDesktopConfig = { backendUrl: 'http://t', token: 'tok', modelId: '' }
const mode = { host: false, block: 'external-engine' as 'external-engine' | 'no-local-engine' | 'pending' | null }

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '1.0.0', setup: (c: Ctx) => { ref = c }, bundle: { dir: 'acme-chat', enginePlugins: ['chat-engine'], agents: [], skills: [], spaces: [] } } as never])
  return ref!
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  resetHostDenialsForTest()
  mode.host = false
  mode.block = 'external-engine'
  setTanguProbe({
    activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {},
    waitBackend: async () => CFG, hostExecution: () => mode.host, hostExecutionBlock: () => mode.block,
  } as never)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { setTanguProbe(null); warn.mockRestore() })

const ours = (): string[] => warn.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('[plugin:acme]'))

describe('插件请求被宿主拒掉', () => {
  it('报错原样给插件,宿主留一条记录(控制台 + 开发控制台 + 诊断)', async () => {
    const ctx = ctxOf('acme')
    await expect(ctx.tangu!.request!('chat-engine', '/status')).rejects.toThrow('A local engine is required')
    expect(ours()).toEqual(['[plugin:acme] ctx.tangu.request was refused by the host: Forsion is connected to an external engine; this call only works with the local engine Forsion manages itself'])
    expect(getDevRecord('acme').logs.at(-1)?.text).toContain('ctx.tangu.request was refused')
    expect(hostDenialsOf('acme')).toMatchObject([{ api: 'ctx.tangu.request', code: 'external-engine' }])
  })

  it('同一原因只记一次(轮询每几秒撞一次也不刷屏)', async () => {
    const ctx = ctxOf('acme')
    for (let i = 0; i < 5; i++) await expect(ctx.tangu!.request!('chat-engine', '/status')).rejects.toThrow()
    expect(ours()).toHaveLength(1)
    expect(hostDenialsOf('acme')).toHaveLength(1)
  })

  it('connectChannel 同样记,返回值不变', async () => {
    const r = await ctxOf('acme').tangu!.connectChannel!('chat', { appId: 'x' })
    expect(r).toEqual({ ok: false, error: 'A local engine is required' })
    expect(hostDenialsOf('acme')).toMatchObject([{ api: 'ctx.tangu.connectChannel', code: 'external-engine' }])
  })

  it('请求后来成功了就撤掉记录;再被拒会重新记', async () => {
    const ctx = ctxOf('acme')
    await expect(ctx.tangu!.request!('chat-engine', '/status')).rejects.toThrow()
    mode.host = true
    mode.block = null
    await expect(ctx.tangu!.request!('chat-engine', '/status')).resolves.toEqual({ ok: true })
    expect(hostDenialsOf('acme')).toEqual([])
    mode.host = false
    mode.block = 'external-engine'
    await expect(ctx.tangu!.request!('chat-engine', '/status')).rejects.toThrow()
    expect(ours()).toHaveLength(2)
  })

  it('插件重新激活(开发副本保存即重载)→ 再被拒会重新记一次,旧记录撤掉', async () => {
    await expect(ctxOf('acme').tangu!.request!('chat-engine', '/status')).rejects.toThrow()
    const first = hostDenialsOf('acme')[0].at
    await new Promise((r) => setTimeout(r, 5))
    await expect(ctxOf('acme').tangu!.request!('chat-engine', '/status')).rejects.toThrow()
    expect(ours()).toHaveLength(2)
    expect(hostDenialsOf('acme')).toHaveLength(1)
    expect(hostDenialsOf('acme')[0].at).toBeGreaterThan(first)
  })

  it('切回托管引擎后,「外部引擎」那条不再摆出来', async () => {
    await expect(ctxOf('acme').tangu!.request!('chat-engine', '/status')).rejects.toThrow()
    mode.block = null
    expect(hostDenialsOf('acme')).toEqual([])
    expect(pluginProblemsForAgent()).toBe('')
  })

  it('给 agent 的 plugin-status 点名被拒,问题一览里也有它', async () => {
    const ctx = ctxOf('acme')
    await expect(ctx.tangu!.request!('chat-engine', '/status')).rejects.toThrow()
    expect(pluginStatusForAgent('acme')).toContain('host refused ctx.tangu.request (external engine mode, needs the managed local engine)')
    expect(pluginProblemsForAgent()).toContain('acme (host refused ctx.tangu.request)')
  })
})
