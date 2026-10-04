// @vitest-environment happy-dom
/**
 * `ctx.tangu.mountChat`(2026-10-04):三层各钉一处 ——
 *  ① 会话规则(views/pluginChat):新建 = 本机执行 + 工作目录 + Agent;记住的会话还在就接回,只有 404 / 已归档才新开;
 *  ② 探针(tanguProbe.mountChat):引用投给「目标名」,对话没挂上时投的也接得住;卸了就不再挂;
 *  ③ 放行规则(pluginStore):folder 走 hostPath 钳在库内;禁用即收。
 * 负对照(2026-10-04 五条都实跑红过):接回时去掉 `status !== 404` 的判断 → 「连不上不新开」红;cwd 不进槽键 → 「换目录 = 新会话」红;
 * 接回时也标 fresh → 「不标全新」红;探针 quote 换一个目标名 → 「没挂上时投的引用」红;pluginStore 去掉 scope.own → 「禁用即收」红。
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSessionDetail: vi.fn(),
  seen: [] as Array<{ leaf: { id: string; type: string }; params: Record<string, unknown> }>,
}))
vi.mock('./ChatView', () => ({ ChatView: (props: (typeof api.seen)[number]) => { api.seen.push(props); return null } }))
vi.mock('../services/backendService', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createSession: (...a: unknown[]) => api.createSession(...a),
  getSessionDetail: (...a: unknown[]) => api.getSessionDetail(...a),
}))

const { ensurePluginChat, mountPluginChat } = await import('./pluginChat')
const { installTanguProbe } = await import('../tanguProbe')
const { readTangu, setTanguProbe } = await import('../amadeus/plugins/tanguSeam')
const { usePluginStore } = await import('../amadeus/plugins/pluginStore')
const { usePageStore } = await import('../amadeus/store/pageStore')
const { useApp } = await import('../stores/appStore')
type Ctx = import('../amadeus/plugins/types').PluginContext

const SLOTS = 'tangu.pluginChats'
const slots = (): Record<string, string> => JSON.parse(localStorage.getItem(SLOTS) || '{}')
const rec = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, title: null, model_id: null, archived: false, emoji: null, agent_config: null, created_at: '', updated_at: '', ...over })
const agent = (slug: string, over: Record<string, unknown> = {}) => ({ slug, name: slug, description: '', model: '', tools: [], ...over })
const realAdopt = useApp.getState().adoptSession
const adopt = vi.fn()
let el: HTMLDivElement
const cleanups: Array<() => void> = []
const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  api.createSession.mockReset()
  api.getSessionDetail.mockReset()
  api.seen.length = 0
  usePageStore.setState({ vaultRoot: '/v' })
  useApp.setState({
    cfgLoaded: true, connState: 'ok', sessions: [], archivedSessions: [], configBySession: {}, messagesBySession: {},
    agentDefs: [agent('fvs-director')], defaultAgentSlug: 'xyra', desktopConfig: null, pendingChatQuote: null,
    refreshAgents: () => useApp.setState({ agentDefs: [...useApp.getState().agentDefs] }),
  } as never)
  adopt.mockReset().mockImplementation(realAdopt)
  useApp.setState({ adoptSession: adopt } as never)
  el = document.createElement('div')
  document.body.append(el)
})
afterEach(async () => {
  await act(async () => { for (const fn of cleanups.splice(0)) fn() })
  el.remove()
  setTanguProbe(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('会话规则(ensurePluginChat)', () => {
  it('新建:本机执行 + 工作目录 + Agent;记进槽;按「全新会话」收进列表', async () => {
    api.createSession.mockResolvedValue(rec('s1'))
    expect(await ensurePluginChat({ owner: 'p', agent: 'fvs-director', cwd: '/v/Video/Demo', title: 'Demo' })).toEqual({ ok: true, sessionId: 's1' })
    expect(api.getSessionDetail).not.toHaveBeenCalled()
    const init = api.createSession.mock.calls[0][1]
    expect(init).toMatchObject({
      title: 'Demo', project_path: '/v/Video/Demo', project_name: 'Demo',
      agent_config: { execMode: 'host', cwd: '/v/Video/Demo', agentSlug: 'fvs-director', extraRoots: ['/v'] },
    })
    expect(init).not.toHaveProperty('projectless')
    expect(slots()).toEqual({ 'p\n/v/Video/Demo': 's1' })
    expect(adopt.mock.calls.at(-1)![1]).toEqual({ fresh: true })
    expect(useApp.getState().sessions.map((s) => s.id)).toEqual(['s1'])
    expect(useApp.getState().configBySession.s1).toMatchObject({ execMode: 'host', agentSlug: 'fvs-director' }) // 老引擎不回 agent_config 也有
  })

  it('没给工作目录:无根沙箱对话,用默认 Agent;Agent 自带的模型与思考档进新会话', async () => {
    api.createSession.mockResolvedValue(rec('s1'))
    await ensurePluginChat({ owner: 'p' })
    expect(api.createSession.mock.calls[0][1]).toMatchObject({ projectless: true, agent_config: { execMode: 'sandbox', agentSlug: 'xyra' } })
    expect(api.createSession.mock.calls[0][1].agent_config).not.toHaveProperty('cwd')
    useApp.setState({ agentDefs: [agent('fvs-director', { model: 'm-video', thinkingLevel: 'high' })] } as never)
    api.createSession.mockResolvedValue(rec('s2'))
    await ensurePluginChat({ owner: 'p', agent: 'fvs-director', cwd: '/v/A' })
    expect(api.createSession.mock.calls[1][1]).toMatchObject({ model_id: 'm-video', agent_config: { thinkingLevel: 'high' } })
  })

  it('接回:记住的会话还在 → 不新建,且不标「全新」(历史要照常拉)', async () => {
    localStorage.setItem(SLOTS, JSON.stringify({ 'p\n/v/A': 's1' }))
    api.getSessionDetail.mockResolvedValue(rec('s1', { title: '旧对话' }))
    expect(await ensurePluginChat({ owner: 'p', cwd: '/v/A' })).toEqual({ ok: true, sessionId: 's1' })
    expect(api.getSessionDetail.mock.calls[0][1]).toBe('s1')
    expect(api.createSession).not.toHaveBeenCalled()
    expect(adopt.mock.calls.at(-1)![1]).toBeUndefined()
    expect(useApp.getState().sessions[0]).toMatchObject({ id: 's1', title: '旧对话' })
  })

  it('换目录 = 新会话:槽键带着工作目录,不会接到一条指着旧目录的会话上', async () => {
    localStorage.setItem(SLOTS, JSON.stringify({ 'p\n/v/Old': 's1' }))
    api.createSession.mockResolvedValue(rec('s2'))
    expect(await ensurePluginChat({ owner: 'p', cwd: '/v/New' })).toEqual({ ok: true, sessionId: 's2' })
    expect(api.getSessionDetail).not.toHaveBeenCalled()
    expect(slots()).toEqual({ 'p\n/v/Old': 's1', 'p\n/v/New': 's2' })
  })

  it('被删(404)/ 已归档 → 新开;连不上 → 报错、不新开、槽不动', async () => {
    localStorage.setItem(SLOTS, JSON.stringify({ 'p\n/v/A': 'gone' }))
    api.getSessionDetail.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    api.createSession.mockResolvedValue(rec('s2'))
    expect(await ensurePluginChat({ owner: 'p', cwd: '/v/A' })).toEqual({ ok: true, sessionId: 's2' })

    api.getSessionDetail.mockResolvedValueOnce(rec('s2', { archived: true }))
    api.createSession.mockResolvedValue(rec('s3'))
    expect(await ensurePluginChat({ owner: 'p', cwd: '/v/A' })).toEqual({ ok: true, sessionId: 's3' })

    api.createSession.mockClear()
    api.getSessionDetail.mockRejectedValueOnce(new Error('fetch failed'))
    expect(await ensurePluginChat({ owner: 'p', cwd: '/v/A' })).toEqual({ ok: false, error: 'fetch failed' })
    expect(api.createSession).not.toHaveBeenCalled()
    expect(slots()['p\n/v/A']).toBe('s3')
  })

  it('同一个槽同时挂两次只建一条;建失败不抛、不记槽', async () => {
    let release = (_: unknown): void => {}
    api.createSession.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const a = ensurePluginChat({ owner: 'p', cwd: '/v/A' })
    const b = ensurePluginChat({ owner: 'p', cwd: '/v/A' })
    await Promise.resolve()
    release(rec('s1'))
    expect(await Promise.all([a, b])).toEqual([{ ok: true, sessionId: 's1' }, { ok: true, sessionId: 's1' }])
    expect(api.createSession).toHaveBeenCalledTimes(1)

    api.createSession.mockReset().mockRejectedValue(new Error('quota'))
    expect(await ensurePluginChat({ owner: 'p', cwd: '/v/B' })).toEqual({ ok: false, error: 'quota' })
    expect(slots()).toEqual({ 'p\n/v/A': 's1' })
  })

  it('不认识的 Agent / 后端没连上 → ok:false,不建会话', async () => {
    expect(await ensurePluginChat({ owner: 'p', agent: 'nobody', cwd: '/v/A' })).toEqual({ ok: false, error: 'unknown agent: nobody' })
    vi.useFakeTimers()
    useApp.setState({ connState: 'err' } as never)
    const pending = ensurePluginChat({ owner: 'p', cwd: '/v/A' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ ok: false, error: 'engine is not connected' })
    expect(api.createSession).not.toHaveBeenCalled()
  })
})

describe('挂载(mountPluginChat)', () => {
  it('固定会话的子面对话:followActive 关、childSurface 开;失败给重试,重试成功后换成对话', async () => {
    api.createSession.mockRejectedValueOnce(new Error('quota'))
    let ready!: Promise<unknown>
    await act(async () => { const m = mountPluginChat(el, { owner: 'p', cwd: '/v/A' }); cleanups.push(m.dispose); ready = m.ready; await ready })
    expect(await ready).toEqual({ ok: false, error: 'quota' })
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('对话没接上：quota')
    expect(api.seen).toEqual([])

    api.createSession.mockResolvedValue(rec('s1'))
    await act(async () => { el.querySelector('button')!.click() })
    await flush()
    expect(el.querySelector('[role="alert"]')).toBeNull()
    expect(api.seen.at(-1)).toMatchObject({
      params: { followActive: false, sessionId: 's1', childSurface: true },
      leaf: { id: 'plugin-chat:p:/v/A', type: 'plugin-chat:p:/v/A', loc: 'right' },
    })
  })

  it('卸载后不再画东西(建会话那一拍里视图被关)', async () => {
    let release = (_: unknown): void => {}
    api.createSession.mockReturnValue(new Promise((resolve) => { release = resolve }))
    let m!: ReturnType<typeof mountPluginChat>
    await act(async () => { m = mountPluginChat(el, { owner: 'p', cwd: '/v/A' }) })
    await act(async () => { m.dispose() })
    await act(async () => { release(rec('s1')); await m.ready })
    expect(api.seen).toEqual([])
    expect(el.childElementCount).toBe(0)
  })
})

describe('探针(tanguProbe.mountChat)', () => {
  beforeEach(() => { installTanguProbe() })

  it('引用投给目标名:对话还没挂上时投的,挂上的那个 ChatView 认得', async () => {
    api.createSession.mockResolvedValue(rec('s1'))
    let chat!: import('../amadeus/plugins/tanguSeam').TanguChatMount
    await act(async () => {
      chat = readTangu()!.mountChat!(el, { owner: 'p', cwd: '/v/A' })
      cleanups.push(chat.dispose)
      chat.quote('第 2 幕 · 标题')
      chat.quote('   ') // 空引用不投
      await chat.ready
    })
    expect(await chat.ready).toEqual({ ok: true, sessionId: 's1' })
    expect(useApp.getState().pendingChatQuote).toMatchObject({ targetType: api.seen.at(-1)!.leaf.type, text: '第 2 幕 · 标题' })

    await act(async () => { chat.dispose() })
    useApp.setState({ pendingChatQuote: null } as never)
    chat.quote('卸了之后')
    expect(useApp.getState().pendingChatQuote).toBeNull()
  })

  it('界面那半还没装进来就卸了 → 不建会话、不挂东西', async () => {
    const chat = readTangu()!.mountChat!(el, { owner: 'p', cwd: '/v/A' })
    chat.dispose()
    expect(await chat.ready).toEqual({ ok: false, error: 'disposed' })
    expect(api.createSession).not.toHaveBeenCalled()
    expect(el.childElementCount).toBe(0)
  })
})

describe('放行规则(ctx.tangu.mountChat)', () => {
  const inner = { ready: Promise.resolve({ ok: true, sessionId: 's1' }), quote: vi.fn(), dispose: vi.fn() }
  const mountChat = vi.fn((_el: HTMLElement, _o: import('../amadeus/plugins/tanguSeam').TanguChatMountOptions) => inner)
  const probe = (over: Record<string, unknown> = {}) => ({
    activeModel: () => null, models: () => [], activeSpace: () => null, subscribe: () => () => {}, hostExecution: () => true, ...over,
  })
  const ctxOf = (id: string): Ctx => {
    let ref: Ctx | null = null
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
    return ref!
  }
  beforeEach(() => {
    mountChat.mockClear(); inner.quote.mockClear(); inner.dispose.mockClear()
    setTanguProbe(probe({ mountChat }) as never)
  })

  it('探针没有 mountChat(旧台架 / 没有对话能力的宿主)→ 方法不存在', () => {
    setTanguProbe(probe() as never)
    expect(ctxOf('fvs-old').tangu!.mountChat).toBeUndefined()
  })

  it('folder → cwd 走 hostPath(钳在库内);归属 = 插件 id;库外 / 非本机执行 → 不带 cwd', () => {
    const ctx = ctxOf('fvs')
    ctx.tangu!.mountChat!(el, { agent: ' fvs-director ', folder: 'Video/Demo/', title: ' Demo ' })
    expect(mountChat.mock.calls.at(-1)![1]).toEqual({ owner: 'fvs', agent: 'fvs-director', cwd: '/v/Video/Demo', title: 'Demo' })
    for (const bad of ['../outside', 'Video/../../etc', '/etc', 'C:/x']) {
      ctx.tangu!.mountChat!(el, { folder: bad })
      expect(mountChat.mock.calls.at(-1)![1], bad).toEqual({ owner: 'fvs' })
    }
    setTanguProbe(probe({ mountChat, hostExecution: () => false }) as never)
    ctx.tangu!.mountChat!(el, { folder: 'Video/Demo' })
    expect(mountChat.mock.calls.at(-1)![1]).toEqual({ owner: 'fvs' })
    expect(() => ctx.tangu!.mountChat!({} as never)).toThrow(TypeError)
  })

  it('禁用即收:宿主卸掉挂载,旧句柄的 quote 不再转发,再挂不碰探针', async () => {
    const ctx = ctxOf('fvs-off') // 换个 id:scope 按插件 id 记账,上一个用例的挂载也会在 disable 时被收
    const chat = ctx.tangu!.mountChat!(el, { folder: 'Video/Demo' })
    chat.quote('a')
    expect(inner.quote).toHaveBeenCalledWith('a')
    usePluginStore.getState().disable('fvs-off')
    expect(inner.dispose).toHaveBeenCalledTimes(1)
    chat.quote('b')
    expect(inner.quote).toHaveBeenCalledTimes(1)
    const n = mountChat.mock.calls.length
    expect(await ctx.tangu!.mountChat!(el).ready).toEqual({ ok: false, error: 'plugin disabled' })
    expect(mountChat.mock.calls.length).toBe(n)
  })
})
