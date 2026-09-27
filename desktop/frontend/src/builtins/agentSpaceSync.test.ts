/**
 * agentSpaceSync 的回写判据:装上了却没注册 home(09-27 实机 Muse Space 空白 16 天的形态)也得回写给 Muse,
 * 注册了 / 用户关了 / 目录空就不报。reloadOne 用桩代替,只摆出重载后的 store 状态。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services/backendService', () => ({ postMuseFeedback: vi.fn(async () => ({ ok: true })) }))

import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { postMuseFeedback } from '../services/backendService'
import { syncAgentSpace, reportAgentSpaceMountError, __resetAgentSpaceSync } from './agentSpaceSync'
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

  it('home 挂载抛错 → 回写一次(用户再进 Muse Space 不重报),别的 agent 不报', () => {
    reportAgentSpaceMountError(cfg, 'muse', 'home', new Error('boom mount'))
    reportAgentSpaceMountError(cfg, 'muse', 'home', new Error('boom mount'))
    reportAgentSpaceMountError(cfg, 'other', 'home', new Error('x'))
    expect(posted).toHaveBeenCalledTimes(1)
    expect(posted.mock.calls[0][1]).toMatch(/mount\(\) threw.*boom mount/)
  })

  it('用户关掉了 / 目录空(没有来源)→ 都不报', async () => {
    afterReload({ plugins: [muse], activeIds: [], views: [] })
    await run(5)
    afterReload({ plugins: [], activeIds: [], views: [] })
    await run(6)
    expect(posted).not.toHaveBeenCalled()
  })
})
