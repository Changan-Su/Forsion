/**
 * ctx.agent(2026-09-27,agent 自建 Space 读写自家数据)的宿主纪律:
 *  ① 只注入给 agent-<slug> 插件、且该 agent 有数据源;普通插件 / 没数据源的 agent 插件整个没有;
 *  ② updateTodo 只在用户刚在**本插件视图里**点过之后放行(插件代码是 agent 自己写的,不许不经点击替用户处理 TODO;
 *     窗口级的 userActivation 会被别处的点击点亮,所以宿主按视图记可信交互);
 *  ③ subscribe 状态键变了才回调,updateTodo 之后补一次;停用后计时器停、调用一律 reject。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { notePluginGesture, usePluginStore } from '@amadeus/plugins/pluginStore'
import { setTanguProbe, type TanguAgentSelf, type TanguAgentSelfStatus } from '@amadeus/plugins/tanguSeam'
import type { AmadeusPlugin, PluginContext } from '@amadeus/plugins/types'

const mem = new Map<string, string>()
const fakeLocalStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0,
}

let status: TanguAgentSelfStatus
const pending = [{ id: 't1', title: 'Try X', detail: null, status: 'pending' as const, createdAt: '2026-09-27 10:00:00' }]
const self = {
  status: vi.fn(async () => status),
  todos: vi.fn(async () => pending),
  updateTodo: vi.fn(async (_id: string, _status: 'done' | 'dismissed', _alive?: () => boolean) => {}),
  schedule: vi.fn(async () => []),
  libraryList: vi.fn(async () => []),
  libraryRead: vi.fn(async (p: string) => `content of ${p}`),
} satisfies TanguAgentSelf

const ctxs: Record<string, PluginContext> = {}
const plugin = (id: string, agent?: string): AmadeusPlugin => ({
  id, name: id, version: '1', builtin: false, ...(agent ? { agent } : {}),
  setup: (ctx) => { ctxs[id] = ctx },
})

beforeEach(() => {
  mem.clear()
  vi.stubGlobal('localStorage', fakeLocalStorage)
  vi.useFakeTimers()
  for (const f of Object.values(self)) f.mockClear()
  status = { running: false, lastCycleAt: 1, sleepUntil: null, sleepReason: null, mode: 'ask', heartbeatMinutes: 120, pendingApprovals: 0 }
  setTanguProbe({
    activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {},
    agentSelf: (slug) => (slug === 'muse' ? self : null),
  })
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], readiness: [] })
  usePluginStore.getState().init([plugin('agent-muse', 'muse'), plugin('agent-other', 'other'), plugin('p1')])
})
afterEach(() => {
  setTanguProbe(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ctx.agent', () => {
  it('只注入给有数据源的 agent 自建 Space 插件', () => {
    expect(ctxs['agent-muse'].agent?.slug).toBe('muse')
    expect(ctxs['agent-other'].agent).toBeUndefined()
    expect(ctxs.p1.agent).toBeUndefined()
  })

  it('updateTodo:没点过 / 点的是别的插件的视图 / 点过但超过 1.5 秒 → reject;刚在本视图里点过 → 放行并通知订阅者', async () => {
    const agent = ctxs['agent-muse'].agent!
    await expect(agent.updateTodo('t1', 'done')).rejects.toThrow(/clicks inside your own view/)
    notePluginGesture('p1') // 别的插件视图里的点击
    await expect(agent.updateTodo('t1', 'done')).rejects.toThrow(/clicks inside your own view/)
    notePluginGesture('agent-muse')
    await vi.advanceTimersByTimeAsync(2000) // 过了 1.5 秒窗口(定时器借着旧点击调)
    await expect(agent.updateTodo('t1', 'done')).rejects.toThrow(/clicks inside your own view/)
    await expect(agent.updateTodo('t1', 'injected' as never)).rejects.toThrow(/done' or 'dismissed/)
    expect(self.updateTodo).not.toHaveBeenCalled()
    const cb = vi.fn()
    agent.subscribe(cb)
    notePluginGesture('agent-muse')
    await agent.updateTodo('t1', 'done')
    expect(self.updateTodo).toHaveBeenCalledWith('t1', 'done', expect.any(Function))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('重载后旧实例上的点击不授权新实例;待办换了一条(条数不变)也回调', async () => {
    notePluginGesture('agent-muse')
    usePluginStore.getState().disable('agent-muse')
    usePluginStore.getState().enable('agent-muse')
    await expect(ctxs['agent-muse'].agent!.updateTodo('t1', 'done')).rejects.toThrow(/clicks inside your own view/)
    const cb = vi.fn()
    ctxs['agent-muse'].agent!.subscribe(cb)
    await vi.advanceTimersByTimeAsync(20_000) // 基线:[t1]
    self.todos.mockResolvedValue([{ ...pending[0], id: 't2' }]) // 别处忽略了 t1、Muse 新提了 t2
    await vi.advanceTimersByTimeAsync(20_000)
    expect(cb).toHaveBeenCalledTimes(1)
    self.todos.mockResolvedValue(pending)
  })

  it('等后端期间插件被停用 → 数据源拿到的 alive() 变 false(不再把写发出去)', async () => {
    const agent = ctxs['agent-muse'].agent!
    let aliveFn: (() => boolean) | undefined
    self.updateTodo.mockImplementationOnce(async (_id: string, _s: 'done' | 'dismissed', alive?: () => boolean) => { aliveFn = alive })
    notePluginGesture('agent-muse')
    await agent.updateTodo('t1', 'dismissed')
    expect(aliveFn?.()).toBe(true)
    usePluginStore.getState().disable('agent-muse')
    expect(aliveFn?.()).toBe(false)
  })

  it('library.read 透传;subscribe 只在状态键变了时回调;停用后计时器停、调用 reject', async () => {
    const agent = ctxs['agent-muse'].agent!
    expect(await agent.library.read('Journal/2026-09-27.md')).toBe('content of Journal/2026-09-27.md')
    const cb = vi.fn()
    agent.subscribe(cb)
    await vi.advanceTimersByTimeAsync(20_000) // 基线
    await vi.advanceTimersByTimeAsync(20_000) // 没变
    expect(cb).not.toHaveBeenCalled()
    status = { ...status, lastCycleAt: 2 } // 一个周期结束了
    await vi.advanceTimersByTimeAsync(20_000)
    expect(cb).toHaveBeenCalledTimes(1)
    usePluginStore.getState().disable('agent-muse')
    const calls = self.status.mock.calls.length
    status = { ...status, lastCycleAt: 3 }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(self.status.mock.calls.length).toBe(calls) // 不再轮询
    expect(cb).toHaveBeenCalledTimes(1)
    await expect(agent.status()).rejects.toThrow(/plugin disabled/)
  })
})
