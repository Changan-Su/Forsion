// @vitest-environment happy-dom
/**
 * agent 自建 Space 的 sourceURL(2026-09-27):只给 agent Space 的代码打、带加载序号;其它已安装插件求值路径逐字不变。
 * 走真实的「外置源 → toPlugin → setup」路径(IPC 桩与 devSandbox.test 同一套;环境必须是 happy-dom,理由见那边)。
 * builtins/agentSpaceSync 靠这个地址把挂载之后没接住的错误认领回 Muse,重载后旧版漏清的定时器不算新版的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({ sources: [] as ExternalPluginSource[] }))
vi.mock('../api', () => ({
  amadeus: { listPlugins: async () => env.sources, listPages: async () => [], listFiles: async () => [] },
}))
vi.mock('../../services/backendService', () => ({ postMuseFeedback: vi.fn(async () => ({ ok: true })) }))

const { usePluginStore, agentSpaceSourceUrl } = await import('./pluginStore')
const { syncAgentSpace, noteAgentSpaceRuntimeError, __resetAgentSpaceSync } = await import('../../builtins/agentSpaceSync')
const posted = vi.mocked((await import('../../services/backendService')).postMuseFeedback)

const source = (over: Partial<ExternalPluginSource> & { id: string }): ExternalPluginSource => ({
  name: over.id, version: '0.0.1', apiVersion: 1, code: '', ...over,
})
type Probe = { __agentThrow?: (k?: string) => void; __plainThrow?: () => void }
const g = globalThis as unknown as Probe
const stackOf = (fn: (() => void) | undefined): string => {
  try { fn?.() } catch (e) { return String((e as Error).stack) }
  return ''
}
const errorOf = (k: string): unknown => {
  try { g.__agentThrow?.(k) } catch (e) { return e }
  throw new Error('fixture did not throw')
}
const agentCode = "globalThis.__agentThrow = (k = 'boom') => { null[k] = 1 }"

beforeEach(() => {
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false })
  posted.mockClear()
  __resetAgentSpaceSync()
  env.sources = []
  delete g.__agentThrow
  delete g.__plainThrow
})

describe('agent Space 的 sourceURL', () => {
  it('栈帧带当前这一版的地址(函数体第 1 行 = 源第 3 行);普通已安装插件不打;重载后序号变、新栈帧用新地址', async () => {
    env.sources = [
      source({ id: 'agent-muse', agent: 'muse', code: agentCode }),
      source({ id: 'plain', code: 'globalThis.__plainThrow = () => { null.boom = 1 }' }),
    ]
    await usePluginStore.getState().loadExternal()
    const url1 = agentSpaceSourceUrl('agent-muse')
    expect(url1).toMatch(/^forsion-agent-space\/agent-muse\/\d+\/main\.js$/)
    expect(stackOf(g.__agentThrow)).toContain(`${url1}:3:`)
    expect(stackOf(g.__plainThrow)).toMatch(/TypeError/)
    expect(stackOf(g.__plainThrow)).not.toContain('forsion-agent-space')

    env.sources = [source({ id: 'agent-muse', agent: 'muse', code: `${agentCode}\n// v2` })] // 代码变了才真重载
    await usePluginStore.getState().reloadOne('agent-muse')
    const url2 = agentSpaceSourceUrl('agent-muse')
    expect(url2).not.toBe(url1)
    expect(stackOf(g.__agentThrow)).toContain(`${url2}:3:`)

    env.sources = [] // 来源没了 → 拆掉:不再有「正在运行的那一版」
    await usePluginStore.getState().reloadOne('agent-muse')
    expect(agentSpaceSourceUrl('agent-muse')).toBeNull()
  })

  it('回写只认正在运行的那一版:同一条只报一次、每版最多 3 条、POST 失败撤销标记;重载后旧版漏清的定时器、拆掉后的残留都不报', async () => {
    env.sources = [source({ id: 'agent-muse', agent: 'muse', code: agentCode })]
    await usePluginStore.getState().loadExternal()
    const oldThrow = errorOf('before-cfg')
    noteAgentSpaceRuntimeError(oldThrow)
    expect(posted).not.toHaveBeenCalled() // 还没见过 Muse 的 cfg(Muse 界面没开过):不报
    void syncAgentSpace({} as never, 'muse', undefined) // 只为记下 cfg(没有戳 → 不重载)
    const a = errorOf('a')
    noteAgentSpaceRuntimeError(a)
    noteAgentSpaceRuntimeError(a) // 定时器里反复抛同一条
    expect(posted).toHaveBeenCalledTimes(1)
    expect(posted.mock.calls[0][1]).toMatch(/went unhandled in your Space after it loaded \(main\.js line 1\): TypeError: Cannot set properties of null \(setting 'a'\)/)
    posted.mockRejectedValueOnce(new Error('engine down'))
    const b = errorOf('b')
    noteAgentSpaceRuntimeError(b)
    await new Promise((r) => setTimeout(r, 0))
    noteAgentSpaceRuntimeError(b) // POST 失败那次撤销了标记,再报一次
    noteAgentSpaceRuntimeError(errorOf('c'))
    noteAgentSpaceRuntimeError(errorOf('d')) // 上限 3(a、b、c):d 不报
    expect(posted.mock.calls.map((c) => String(c[1]).match(/setting '(\w)'/)?.[1])).toEqual(['a', 'b', 'b', 'c'])

    const leaked = g.__agentThrow // 旧版的函数(比如漏清的定时器)重载后还在
    env.sources = [source({ id: 'agent-muse', agent: 'muse', code: `${agentCode}\n// v2` })]
    await usePluginStore.getState().reloadOne('agent-muse')
    noteAgentSpaceRuntimeError((() => { try { leaked?.('old') } catch (e) { return e } })())
    expect(posted).toHaveBeenCalledTimes(4) // 旧版的不算新版的
    noteAgentSpaceRuntimeError(errorOf('new')) // 新版自己的:换版重新计
    expect(posted).toHaveBeenCalledTimes(5)

    const lastRun = g.__agentThrow // 拆掉前最后在跑的这一版(v2)的函数
    env.sources = []
    await usePluginStore.getState().reloadOne('agent-muse') // 拆掉了:连它自己的残留也不报
    noteAgentSpaceRuntimeError((() => { try { lastRun?.('gone') } catch (e) { return e } })())
    expect(posted).toHaveBeenCalledTimes(5)
  })

  it('setup 同步抛错的那一版不算「正在运行」:它先留下的函数(如已起的定时器)之后再抛也不报(加载失败另有回写)', async () => {
    env.sources = [source({ id: 'agent-muse', agent: 'muse', code: `${agentCode}\nthrow new Error('setup boom')` })]
    await usePluginStore.getState().loadExternal()
    expect(usePluginStore.getState().lastSetupError['agent-muse']).toMatch(/setup boom/)
    expect(agentSpaceSourceUrl('agent-muse')).toBeNull()
    void syncAgentSpace({} as never, 'muse', undefined)
    noteAgentSpaceRuntimeError(errorOf('leftover'))
    expect(posted).not.toHaveBeenCalled()
  })
})
