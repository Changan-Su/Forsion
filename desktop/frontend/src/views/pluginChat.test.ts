// @vitest-environment happy-dom
/**
 * `ctx.tangu.mountChat`(2026-10-04):三层各钉一处 ——
 *  ① 会话规则(views/pluginChat):新建 = 本机执行 + 工作目录 + Agent;记住的会话还在就接回,只有 404 / 已归档才新开;
 *  ② 探针(tanguProbe.mountChat):引用投给「目标名」、预填投给会话,对话没挂上时投的也接得住;卸了就不再挂;
 *  ③ 放行规则(pluginStore):folder 走 hostPath 钳在库内;禁用即收。
 * 负对照(2026-10-04 八条都实跑红过;第六条 = 探针 prefill 不看 disposed → 「卸了之后不投」红;七 / 八 = 后端就绪前就解析工作目录、
 * 解析不出来悄悄退成沙箱 → 「等后端就绪后才解析…」红):接回时去掉 `status !== 404` 的判断 → 「连不上不新开」红;cwd 不进槽键 → 「换目录 = 新会话」红;
 * 接回时也标 fresh → 「不标全新」红;探针 quote 换一个目标名 → 「没挂上时投的引用」红;pluginStore 去掉 scope.own → 「禁用即收」红。
 * 评审后补的四条(同日,也都实跑红过):在飞去重改回按「插件 + 相对文件夹」→ 「换了库的同名文件夹」红;预填改回单槽 → 「挨着投的两条都在」红;
 * 预填只认第一次接的结果 → 「重试接上之后」红;`/` 归一化成空串 → 「整个就是分隔符」红。
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
const { usePluginChat } = await import('../stores/pluginChatStore')
type Ctx = import('../amadeus/plugins/types').PluginContext

const SLOTS = 'tangu.pluginChats'
const slots = (): Record<string, string> => JSON.parse(localStorage.getItem(SLOTS) || '{}')
const rec = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, title: null, model_id: null, archived: false, emoji: null, agent_config: null, created_at: '', updated_at: '', ...over })
const agent = (slug: string, over: Record<string, unknown> = {}) => ({ slug, name: slug, description: '', model: '', tools: [], ...over })
const realAdopt = useApp.getState().adoptSession
const adopt = vi.fn()
/** 插件给的库相对文件夹 + 它落到的本机绝对路径(库根 /v)。 */
const at = (cwd: string) => ({ folder: cwd.replace(/^\/v\//, ''), resolveCwd: () => cwd })
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
  usePluginChat.setState({ pending: [] })
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
    expect(await ensurePluginChat({ owner: 'p', agent: 'fvs-director', ...at('/v/Video/Demo'), title: 'Demo' })).toEqual({ ok: true, sessionId: 's1' })
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
    await ensurePluginChat({ owner: 'p', agent: 'fvs-director', ...at('/v/A') })
    expect(api.createSession.mock.calls[1][1]).toMatchObject({ model_id: 'm-video', agent_config: { thinkingLevel: 'high' } })
  })

  it('接回:记住的会话还在 → 不新建,且不标「全新」(历史要照常拉)', async () => {
    localStorage.setItem(SLOTS, JSON.stringify({ 'p\n/v/A': 's1' }))
    api.getSessionDetail.mockResolvedValue(rec('s1', { title: '旧对话' }))
    expect(await ensurePluginChat({ owner: 'p', ...at('/v/A') })).toEqual({ ok: true, sessionId: 's1' })
    expect(api.getSessionDetail.mock.calls[0][1]).toBe('s1')
    expect(api.createSession).not.toHaveBeenCalled()
    expect(adopt.mock.calls.at(-1)![1]).toBeUndefined()
    expect(useApp.getState().sessions[0]).toMatchObject({ id: 's1', title: '旧对话' })
  })

  it('换目录 = 新会话:槽键带着工作目录,不会接到一条指着旧目录的会话上', async () => {
    localStorage.setItem(SLOTS, JSON.stringify({ 'p\n/v/Old': 's1' }))
    api.createSession.mockResolvedValue(rec('s2'))
    expect(await ensurePluginChat({ owner: 'p', ...at('/v/New') })).toEqual({ ok: true, sessionId: 's2' })
    expect(api.getSessionDetail).not.toHaveBeenCalled()
    expect(slots()).toEqual({ 'p\n/v/Old': 's1', 'p\n/v/New': 's2' })
  })

  it('被删(404)/ 已归档 → 新开;连不上 → 报错、不新开、槽不动', async () => {
    localStorage.setItem(SLOTS, JSON.stringify({ 'p\n/v/A': 'gone' }))
    api.getSessionDetail.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    api.createSession.mockResolvedValue(rec('s2'))
    expect(await ensurePluginChat({ owner: 'p', ...at('/v/A') })).toEqual({ ok: true, sessionId: 's2' })

    api.getSessionDetail.mockResolvedValueOnce(rec('s2', { archived: true }))
    api.createSession.mockResolvedValue(rec('s3'))
    expect(await ensurePluginChat({ owner: 'p', ...at('/v/A') })).toEqual({ ok: true, sessionId: 's3' })

    api.createSession.mockClear()
    api.getSessionDetail.mockRejectedValueOnce(new Error('fetch failed'))
    expect(await ensurePluginChat({ owner: 'p', ...at('/v/A') })).toEqual({ ok: false, error: 'fetch failed' })
    expect(api.createSession).not.toHaveBeenCalled()
    expect(slots()['p\n/v/A']).toBe('s3')
  })

  it('工作目录等后端就绪后才解析;给了文件夹却落不到本机路径 → ok:false,不退成沙箱对话', async () => {
    // 应用刚启动:后端没连上、桌面配置没回来 → 此刻解析只会得到 null
    useApp.setState({ connState: 'err' } as never)
    let root: string | null = null
    api.createSession.mockResolvedValue(rec('s1'))
    const pending = ensurePluginChat({ owner: 'p', folder: 'A', resolveCwd: () => root })
    await Promise.resolve()
    root = '/v/A'
    useApp.setState({ connState: 'ok' } as never)
    expect(await pending).toEqual({ ok: true, sessionId: 's1' })
    expect(api.createSession.mock.calls[0][1]).toMatchObject({ project_path: '/v/A', agent_config: { execMode: 'host', cwd: '/v/A' } })

    api.createSession.mockClear()
    expect(await ensurePluginChat({ owner: 'p', folder: '../outside', resolveCwd: () => null })).toEqual({ ok: false, error: 'folder is not available on this host: ../outside' })
    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('同一个槽同时挂两次只建一条;建失败不抛、不记槽', async () => {
    let release = (_: unknown): void => {}
    api.createSession.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const a = ensurePluginChat({ owner: 'p', ...at('/v/A') })
    const b = ensurePluginChat({ owner: 'p', ...at('/v/A') })
    await Promise.resolve()
    release(rec('s1'))
    expect(await Promise.all([a, b])).toEqual([{ ok: true, sessionId: 's1' }, { ok: true, sessionId: 's1' }])
    expect(api.createSession).toHaveBeenCalledTimes(1)

    api.createSession.mockReset().mockRejectedValue(new Error('quota'))
    expect(await ensurePluginChat({ owner: 'p', ...at('/v/B') })).toEqual({ ok: false, error: 'quota' })
    expect(slots()).toEqual({ 'p\n/v/A': 's1' })
  })

  it('在飞去重认的是落盘那个槽:换了库的同名文件夹各建各的;同一个目录的两种写法只建一条', async () => {
    const releases: Array<(v: unknown) => void> = []
    api.createSession.mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    // 库 1 的 A 还在建,人已经换到库 2,同一个相对文件夹再挂一次
    const first = ensurePluginChat({ owner: 'p', folder: 'A', resolveCwd: () => '/v1/A' })
    const second = ensurePluginChat({ owner: 'p', folder: 'A', resolveCwd: () => '/v2/A' })
    await vi.waitFor(() => expect(releases.length).toBe(2))
    releases[0](rec('s1')); releases[1](rec('s2'))
    expect(await Promise.all([first, second])).toEqual([{ ok: true, sessionId: 's1' }, { ok: true, sessionId: 's2' }])
    expect(api.createSession.mock.calls.map((c) => (c[1] as { project_path: string }).project_path)).toEqual(['/v1/A', '/v2/A'])
    expect(slots()).toEqual({ 'p\n/v1/A': 's1', 'p\n/v2/A': 's2' })

    releases.length = 0
    const a = ensurePluginChat({ owner: 'p', folder: 'Video/Demo', resolveCwd: () => '/v/Video/Demo' })
    const b = ensurePluginChat({ owner: 'p', folder: 'Video\\Demo', resolveCwd: () => '/v/Video/Demo' })
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0))
    releases.forEach((release) => release(rec('s3')))
    expect(await Promise.all([a, b])).toEqual([{ ok: true, sessionId: 's3' }, { ok: true, sessionId: 's3' }])
    expect(releases.length).toBe(1)
  })

  it('不认识的 Agent / 后端没连上 → ok:false,不建会话', async () => {
    expect(await ensurePluginChat({ owner: 'p', agent: 'nobody', ...at('/v/A') })).toEqual({ ok: false, error: 'unknown agent: nobody' })
    vi.useFakeTimers()
    useApp.setState({ connState: 'err' } as never)
    const pending = ensurePluginChat({ owner: 'p', ...at('/v/A') })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ ok: false, error: 'engine is not connected' })
    expect(api.createSession).not.toHaveBeenCalled()
  })
})

describe('挂载(mountPluginChat)', () => {
  it('固定会话的子面对话:followActive 关、childSurface 开;失败给重试,重试成功后换成对话', async () => {
    api.createSession.mockRejectedValueOnce(new Error('quota'))
    let ready!: Promise<unknown>
    await act(async () => { const m = mountPluginChat(el, { owner: 'p', ...at('/v/A') }); cleanups.push(m.dispose); ready = m.ready; await ready })
    expect(await ready).toEqual({ ok: false, error: 'quota' })
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('对话没接上：quota')
    expect(api.seen).toEqual([])

    api.createSession.mockResolvedValue(rec('s1'))
    await act(async () => { el.querySelector('button')!.click() })
    await flush()
    expect(el.querySelector('[role="alert"]')).toBeNull()
    expect(api.seen.at(-1)).toMatchObject({
      params: { followActive: false, sessionId: 's1', childSurface: true },
      leaf: { id: 'plugin-chat:p:A', type: 'plugin-chat:p:A', loc: 'right' },
    })
  })

  it('没接上的原因照界面语言说(给插件的 error 仍是固定的英文)', async () => {
    let ready!: Promise<unknown>
    await act(async () => { const m = mountPluginChat(el, { owner: 'p', folder: '../x', resolveCwd: () => null }); cleanups.push(m.dispose); ready = m.ready; await ready })
    expect(await ready).toEqual({ ok: false, error: 'folder is not available on this host: ../x' })
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('对话没接上：这台设备上打不开这个文件夹')
    const other = document.createElement('div'); document.body.append(other); cleanups.push(() => other.remove())
    await act(async () => { const m = mountPluginChat(other, { owner: 'p', agent: 'nobody', ...at('/v/A') }); cleanups.push(m.dispose); await m.ready })
    expect(other.querySelector('[role="alert"]')!.textContent).toContain('对话没接上：没有这个 Agent：nobody')
  })

  it('dispose 之后 el 立刻还给插件:清空它、在同一个 el 上再挂,新的那份在 el 里(插件切工程就这么写)', async () => {
    api.createSession.mockResolvedValueOnce(rec('s1')).mockResolvedValueOnce(rec('s2'))
    let first!: ReturnType<typeof mountPluginChat>
    await act(async () => { first = mountPluginChat(el, { owner: 'p', ...at('/v/A') }); await first.ready })
    expect(el.querySelector('[data-plugin-chat="plugin-chat:p:A"]')).not.toBeNull()
    await act(async () => {
      first.dispose()
      expect(el.childElementCount).toBe(0) // 不等 React 的卸载落地
      el.replaceChildren()
      const second = mountPluginChat(el, { owner: 'p', ...at('/v/B') }); cleanups.push(second.dispose)
      await second.ready
    })
    expect([...el.querySelectorAll('[data-plugin-chat]')].map((x) => x.getAttribute('data-plugin-chat'))).toEqual(['plugin-chat:p:B'])
    expect(api.seen.at(-1)).toMatchObject({ params: { sessionId: 's2' } })
  })

  // 负对照(2026-10-05 实跑红):mountHostReact 的 render 不看句柄死活 → 晚到的那次重画往已卸的 root 上画(React 抛错)。
  // 10-04 的写法是「同一个 el 再调一次 mountHostReact = 原地更新」,那时晚到的结果会把后来的挂载换掉。
  it('对话还没接上、插件没 dispose 就把同一个 el 交给了别的挂载:对话被收掉,晚到的结果不顶掉后来那份', async () => {
    const { mountHostReact } = await import('@lcl/components')
    const { createElement } = await import('react')
    let release = (_: unknown): void => {}
    api.createSession.mockReturnValue(new Promise((resolve) => { release = resolve }))
    let chat!: ReturnType<typeof mountPluginChat>
    let other!: import('@lcl/components').HostReactMount
    await act(async () => { chat = mountPluginChat(el, { owner: 'p', ...at('/v/A') }); cleanups.push(chat.dispose) })
    expect(el.querySelector('[data-plugin-chat]')).not.toBeNull() // 加载中
    await act(async () => { other = mountHostReact(el, createElement('textarea', { 'data-other': '' })) })
    const node = el.querySelector('[data-other]')
    expect(node?.isConnected).toBe(true)
    expect(el.querySelector('[data-plugin-chat]')).toBeNull()
    await act(async () => { release(rec('s1')); await chat.ready })
    expect(el.querySelector('[data-other]')).toBe(node) // 后来那份原样留着
    expect(el.querySelector('[data-plugin-chat]')).toBeNull()
    expect(api.seen).toEqual([])
    await act(async () => { other.dispose() })
    expect(el.childElementCount).toBe(0) // 它的句柄还收得掉
  })

  it('卸载后不再画东西(建会话那一拍里视图被关)', async () => {
    let release = (_: unknown): void => {}
    api.createSession.mockReturnValue(new Promise((resolve) => { release = resolve }))
    let m!: ReturnType<typeof mountPluginChat>
    await act(async () => { m = mountPluginChat(el, { owner: 'p', ...at('/v/A') }) })
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
      chat = readTangu()!.mountChat!(el, { owner: 'p', ...at('/v/A') })
      cleanups.push(chat.dispose)
      chat.quote('第 2 幕 · 标题')
      chat.quote('   ') // 空引用不投
      await chat.ready
    })
    expect(await chat.ready).toEqual({ ok: true, sessionId: 's1' })
    expect(useApp.getState().pendingChatQuote).toMatchObject({ targetType: api.seen.at(-1)!.leaf.type, text: '第 2 幕 · 标题' })

    // 没被取走的引用是给这次挂载的:卸载带走它(同名的下一次挂载不该接到),别人的引用不动
    await act(async () => { chat.dispose() })
    expect(useApp.getState().pendingChatQuote).toBeNull()
    chat.quote('卸了之后')
    expect(useApp.getState().pendingChatQuote).toBeNull()
    useApp.getState().setPendingChatQuote('chat-side', '主区给侧栏的')
    const other = readTangu()!.mountChat!(el, { owner: 'p', ...at('/v/B') })
    other.dispose()
    expect(useApp.getState().pendingChatQuote).toMatchObject({ targetType: 'chat-side' })
  })

  it('预填按会话投:接上之前调用的排在 ready 后面;空的不投;卸了之后不投', async () => {
    api.createSession.mockResolvedValue(rec('s1'))
    let chat!: import('../amadeus/plugins/tanguSeam').TanguChatMount
    await act(async () => {
      chat = readTangu()!.mountChat!(el, { owner: 'p', ...at('/v/A') })
      cleanups.push(chat.dispose)
      chat.prefill('一支 10 秒的开场')
      chat.prefill('')
      chat.prefill('为这支视频写一段配乐')
      expect(usePluginChat.getState().pending).toEqual([]) // 会话还没接上:没有 id 可投
      await chat.ready
    })
    await flush()
    // 挨着投的两条都在,先投的在前(单槽的话后一条会把想法顶掉)
    expect(usePluginChat.getState().pending).toEqual([{ sessionId: 's1', text: '一支 10 秒的开场' }, { sessionId: 's1', text: '为这支视频写一段配乐' }])
    usePluginChat.getState().queue('other', '别的会话的')
    expect(usePluginChat.getState().take('s1')).toEqual(['一支 10 秒的开场', '为这支视频写一段配乐'])
    expect(usePluginChat.getState().take('s1')).toEqual([]) // 只取一次
    expect(usePluginChat.getState().pending).toEqual([{ sessionId: 'other', text: '别的会话的' }])

    chat.prefill('还没被输入框取走的')
    await flush()
    await act(async () => { chat.dispose() })
    await flush()
    chat.prefill('卸了之后')
    await flush()
    expect(usePluginChat.getState().pending).toEqual([{ sessionId: 'other', text: '别的会话的' }]) // 卸载带走自己那几条,之后不再投
  })

  it('第一次没接上、用户点「重试」接上之后:预填投给接上的那条会话', async () => {
    api.createSession.mockRejectedValueOnce(new Error('quota'))
    let chat!: import('../amadeus/plugins/tanguSeam').TanguChatMount
    await act(async () => { chat = readTangu()!.mountChat!(el, { owner: 'p', ...at('/v/A') }); cleanups.push(chat.dispose); await chat.ready })
    expect(await chat.ready).toEqual({ ok: false, error: 'quota' })
    chat.prefill('没接上时投的')
    await flush()
    expect(usePluginChat.getState().pending).toEqual([])
    api.createSession.mockResolvedValue(rec('s1'))
    await act(async () => { el.querySelector('button')!.click() })
    await flush()
    chat.prefill('为这支视频写一段配乐')
    await flush()
    expect(usePluginChat.getState().pending).toEqual([{ sessionId: 's1', text: '为这支视频写一段配乐' }])
  })

  it('界面那半还没装进来就卸了 → 不建会话、不挂东西', async () => {
    const chat = readTangu()!.mountChat!(el, { owner: 'p', ...at('/v/A') })
    chat.dispose()
    expect(await chat.ready).toEqual({ ok: false, error: 'disposed' })
    expect(api.createSession).not.toHaveBeenCalled()
    expect(el.childElementCount).toBe(0)
  })
})

describe('放行规则(ctx.tangu.mountChat)', () => {
  const inner = { ready: Promise.resolve({ ok: true, sessionId: 's1' }), quote: vi.fn(), prefill: vi.fn(), dispose: vi.fn() }
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
    mountChat.mockClear(); inner.quote.mockClear(); inner.prefill.mockClear(); inner.dispose.mockClear()
    setTanguProbe(probe({ mountChat }) as never)
  })

  it('探针没有 mountChat(旧台架 / 没有对话能力的宿主)→ 方法不存在', () => {
    setTanguProbe(probe() as never)
    expect(ctxOf('fvs-old').tangu!.mountChat).toBeUndefined()
  })

  it('folder → cwd 走 hostPath(钳在库内),调用时才解析;归属 = 插件 id;库外 / 非本机执行 → 解析为 null;不给 folder 就不带', () => {
    const ctx = ctxOf('fvs')
    const last = () => mountChat.mock.calls.at(-1)![1]
    ctx.tangu!.mountChat!(el, { agent: ' fvs-director ', folder: 'Video/Demo/', title: ' Demo ' })
    expect(last()).toEqual({ owner: 'fvs', agent: 'fvs-director', title: 'Demo', folder: 'Video/Demo', resolveCwd: expect.any(Function) })
    expect(last().resolveCwd!()).toBe('/v/Video/Demo')
    expect(last().resolveCwd!()).toBe(ctx.app.hostPath!('Video/Demo'))
    // 整个就是分隔符的也算「给了文件夹」:原样交下去、解析不出来 → 接不上,不能归一化成空串变成无目录对话
    for (const bad of ['../outside', 'Video/../../etc', '/etc', 'C:/x', '/', '\\']) {
      ctx.tangu!.mountChat!(el, { folder: bad })
      expect(last().folder, bad).toBeTruthy()
      expect(last().resolveCwd!(), bad).toBeNull()
    }
    // 解析是调用时才做的:挂载之后宿主才变成「非本机执行」,也按那一刻算
    ctx.tangu!.mountChat!(el, { folder: 'Video/Demo' })
    const late = last().resolveCwd!
    setTanguProbe(probe({ mountChat, hostExecution: () => false }) as never)
    expect(late()).toBeNull()
    setTanguProbe(probe({ mountChat }) as never)
    ctx.tangu!.mountChat!(el)
    expect(last()).toEqual({ owner: 'fvs' })
    expect(() => ctx.tangu!.mountChat!({} as never)).toThrow(TypeError)
  })

  it('禁用即收:宿主卸掉挂载,旧句柄的 quote / prefill 不再转发,再挂不碰探针', async () => {
    const ctx = ctxOf('fvs-off') // 换个 id:scope 按插件 id 记账,上一个用例的挂载也会在 disable 时被收
    const chat = ctx.tangu!.mountChat!(el, { folder: 'Video/Demo' })
    chat.quote('a'); chat.prefill('p')
    expect(inner.quote).toHaveBeenCalledWith('a')
    expect(inner.prefill).toHaveBeenCalledWith('p')
    usePluginStore.getState().disable('fvs-off')
    expect(inner.dispose).toHaveBeenCalledTimes(1)
    chat.quote('b'); chat.prefill('q')
    expect(inner.quote).toHaveBeenCalledTimes(1)
    expect(inner.prefill).toHaveBeenCalledTimes(1)
    const n = mountChat.mock.calls.length
    expect(await ctx.tangu!.mountChat!(el).ready).toEqual({ ok: false, error: 'plugin disabled' })
    expect(mountChat.mock.calls.length).toBe(n)
  })
})
