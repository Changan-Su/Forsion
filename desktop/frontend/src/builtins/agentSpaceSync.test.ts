/**
 * agentSpaceSync 的回写判据:装上了却没注册 home(09-27 实机 Muse Space 空白 16 天的形态)也得回写给 Muse,
 * 注册了 / 用户关了 / 目录空就不报。reloadOne 用桩代替,只摆出重载后的 store 状态。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services/backendService', () => ({ postMuseFeedback: vi.fn(async () => ({ ok: true })) }))

import { agentSpaceSourceUrl, usePluginStore } from '@amadeus/plugins/pluginStore'
import { postMuseFeedback } from '../services/backendService'
import { syncAgentSpace, reportAgentSpaceMountError, agentSpaceRuntimeError, noteAgentSpaceRuntimeError, __resetAgentSpaceSync } from './agentSpaceSync'
import type { TanguDesktopConfig } from '../types'

const cfg = {} as TanguDesktopConfig
const posted = vi.mocked(postMuseFeedback)
const muse = { id: 'agent-muse', name: 'Muse', version: '1', builtin: false, setup: () => {} }

/** 让 reloadOne 把 store 摆成「重载后」的样子。 */
function afterReload(state: Record<string, unknown>): void {
  usePluginStore.setState({ reloadOne: async () => { usePluginStore.setState(state) } } as never)
}

describe('syncAgentSpace 回写', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    posted.mockClear()
    __resetAgentSpaceSync()
    usePluginStore.setState({ plugins: [], activeIds: [], views: [], lastSetupError: {} } as never)
  })
  afterEach(() => vi.useRealTimers())

  const run = async (stamp: number): Promise<void> => {
    const p = syncAgentSpace(cfg, 'muse', stamp)
    await vi.advanceTimersByTimeAsync(5000)
    await p
  }

  it('装上了、没抛错、没注册 home(包成 function setup 不调用)→ 回写一次,点名顶层 registerView', async () => {
    afterReload({ plugins: [muse], activeIds: ['agent-muse'], views: [] })
    await run(1)
    expect(posted).toHaveBeenCalledTimes(1)
    expect(posted.mock.calls[0][1]).toMatch(/registered no "home" view/)
    expect(posted.mock.calls[0][1]).toMatch(/function setup\(ctx\)/)
    await run(1) // 同一戳:不重载、不重报
    expect(posted).toHaveBeenCalledTimes(1)
  })

  it('async setup 在宽限期内注册了 home → 不报', async () => {
    usePluginStore.setState({ reloadOne: async () => {
      usePluginStore.setState({ plugins: [muse], activeIds: ['agent-muse'], views: [] } as never)
      setTimeout(() => usePluginStore.setState({ views: [{ pluginId: 'agent-muse', item: { id: 'home' } }] } as never), 1000)
    } } as never)
    await run(2)
    expect(posted).not.toHaveBeenCalled()
  })

  it('setup 抛错 → 立即按原口径回写失败原因(不等宽限、不再报 no-home)', async () => {
    afterReload({ plugins: [muse], activeIds: [], views: [], lastSetupError: { 'agent-muse': 'boom' } })
    await run(3)
    expect(posted).toHaveBeenCalledTimes(1)
    expect(posted.mock.calls[0][1]).toBe('Space plugin failed to load: boom')
  })

  it('manifest 被 minAppVersion 门禁挡下 → 回写(从前只认 invalid,这种一声不吭)', async () => {
    afterReload({ plugins: [{ ...muse, blocked: 'minApp' }], activeIds: [], views: [] })
    await run(4)
    expect(posted.mock.calls[0]?.[1]).toMatch(/blocked \(minApp\)/)
  })

  it('home 挂载抛错:同一份定义同一条错只报一次(切出切回不重报),交替的两种错各报一次,新代码再报,别的 agent 不报', async () => {
    const home = { id: 'home' }
    reportAgentSpaceMountError(cfg, 'muse', home, new Error('boom A'))
    reportAgentSpaceMountError(cfg, 'muse', home, new Error('boom A')) // 用户又进了一次 Muse Space
    reportAgentSpaceMountError(cfg, 'muse', home, new Error('boom B'))
    reportAgentSpaceMountError(cfg, 'muse', home, new Error('boom A')) // A、B 交替:都不再报
    reportAgentSpaceMountError(cfg, 'muse', home, new Error('boom B'))
    reportAgentSpaceMountError(cfg, 'muse', { id: 'home' }, new Error('boom A')) // 新代码 = 新 def:照报
    reportAgentSpaceMountError(cfg, 'other', home, new Error('x'))
    expect(posted.mock.calls.map((c) => c[1])).toEqual([
      expect.stringMatching(/mount\(\) threw.*boom A/), expect.stringMatching(/boom B/), expect.stringMatching(/boom A/),
    ])
  })

  it('挂载失败的回写 POST 失败 → 撤销标记,下次挂载再报', async () => {
    const home = { id: 'home' }
    posted.mockRejectedValueOnce(new Error('engine down'))
    reportAgentSpaceMountError(cfg, 'muse', home, new Error('boom'))
    await vi.advanceTimersByTimeAsync(0)
    reportAgentSpaceMountError(cfg, 'muse', home, new Error('boom'))
    expect(posted).toHaveBeenCalledTimes(2)
  })

  it('用户关掉了 / 目录空(没有来源)→ 都不报', async () => {
    afterReload({ plugins: [muse], activeIds: [], views: [] })
    await run(5)
    afterReload({ plugins: [], activeIds: [], views: [] })
    await run(6)
    expect(posted).not.toHaveBeenCalled()
  })

  // 挂载之后的运行时错误:用与宿主同形的 new Function + sourceURL 造真栈(Node 与 Electron 同一个 V8)
  const url = agentSpaceSourceUrl('agent-muse')
  const throwFromSpace = (body: string): unknown => {
    const inner = (new Function('ctx', `${body}\n//# sourceURL=${url}`) as (c: unknown) => () => void)({})
    try { inner() } catch (e) { return e }
    throw new Error('fixture did not throw')
  }
  const withHome = { plugins: [muse], activeIds: ['agent-muse'], views: [{ pluginId: 'agent-muse', item: { id: 'home' } }] }

  it('运行时错误按 sourceURL 认领:行号换算回 main.js;宿主自己的错 / 非 Error 不认', () => {
    const text = agentSpaceRuntimeError(throwFromSpace('const box = null\nreturn () => { box.innerHTML = 1 }'), url)
    expect(text).toMatch(/threw after it loaded \(main\.js line 2\): TypeError: Cannot set properties of null/)
    expect(agentSpaceRuntimeError(new Error('backend not ready'), url)).toBeNull()
    expect(agentSpaceRuntimeError('just a string', url)).toBeNull()
    expect(agentSpaceRuntimeError(throwFromSpace('return () => { null.x = 1 }'), agentSpaceSourceUrl('agent-other'))).toBeNull()
  })

  it('运行时错误回写:同一条只报一次、每份内容最多 3 条,换了戳重新计,POST 失败撤销标记', async () => {
    noteAgentSpaceRuntimeError(throwFromSpace('return () => { null.a = 1 }'))
    expect(posted).not.toHaveBeenCalled() // 还没见过 Muse 的 cfg(Muse 界面没开过):不报
    afterReload(withHome)
    await run(10)
    const a = throwFromSpace('return () => { null.a = 1 }')
    noteAgentSpaceRuntimeError(a)
    noteAgentSpaceRuntimeError(a) // 定时器里反复抛同一条
    expect(posted).toHaveBeenCalledTimes(1)
    expect(posted.mock.calls[0][1]).toMatch(/main\.js line 1\): TypeError/)
    for (const k of ['b', 'c', 'd']) noteAgentSpaceRuntimeError(throwFromSpace(`return () => { null.${k} = 1 }`))
    expect(posted).toHaveBeenCalledTimes(3) // 上限 3:d 不报
    afterReload(withHome)
    await run(11) // 新内容
    posted.mockRejectedValueOnce(new Error('engine down'))
    noteAgentSpaceRuntimeError(a)
    await vi.advanceTimersByTimeAsync(0)
    noteAgentSpaceRuntimeError(a)
    expect(posted).toHaveBeenCalledTimes(5) // 新戳重新计;POST 失败那次撤销了标记,再报一次
  })
})
