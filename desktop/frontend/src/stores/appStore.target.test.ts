// P1-K6 S2 · store 层的整端切换(§3.8 S2、§3.5、§3.7)。手机形态(window.tangu.mobile + 云端 home),authFetch 桩按 URL 路由。
//   ① 负对照:unit 目标回 401、账号仍有效 → 改造前 handleAuthExpired 不看是谁回的,照样重启本机引擎(backendRestart);
//   ② 负对照:焦点在 unit、引擎没回 agent_config → 改造前建会话打 home、补写走整对象 PUT(远端 deny-remote);
//   ③ setFocusTarget:代数先行(旧焦点慢到的 listSessions 不得覆盖新列表)、中止 SSE、清引擎作用域状态、按新焦点重连;
//   ④ 目录随焦点、设置 / 收件箱类仍打 home;审批兑现打会话所在的目标。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Reply = { status: number; body?: unknown }
type Call = { url: string; method: string; body: string | undefined; opts: unknown }
const calls: Call[] = []
let router: (url: string, method: string) => Reply | Promise<Reply> = () => ({ status: 200, body: {} })
vi.mock('../services/http', () => ({
  authFetch: async (url: string, init?: RequestInit, opts?: unknown) => {
    const method = (init?.method || 'GET').toUpperCase()
    calls.push({ url: String(url), method, body: typeof init?.body === 'string' ? init.body : undefined, opts })
    const r = await router(String(url), method)
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), { status: r.status })
  },
  setUnauthorizedHandler: () => {},
}))

const { useApp } = await import('./appStore')
const T = await import('../services/engine/targets')
const H = await import('../services/engine/health')
const C = await import('../services/engine/catalog')
const initial = useApp.getState()

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const API = 'https://api.forsion.test/api'
const UNIT = `${API}/units/${U}/proxy/engine`
// 形如 JWT 的假 token:焦点按账号落盘要能认出 userId
const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '')
const TOKEN = `${b64({ alg: 'none' })}.${b64({ userId: 'u-42' })}.sig`

const backendRestart = vi.fn(async () => ({}))
let account: { loggedIn: boolean; tokenValid?: boolean | null } = { loggedIn: true, tokenValid: true }
const store = new Map<string, string>()

function armMobile(): void {
  ;(globalThis as any).window = {
    tangu: {
      mobile: true,
      authStatus: async () => ({ cloudUrl: API, username: 'u', tokenSource: 'config', ...account }),
      backendRestart,
      getConfig: async () => ({ mode: 'external', backendUrl: API, token: TOKEN, cloudUrl: API, cloudApiBase: API }),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  useApp.setState({
    ...initial,
    tr: (k: string) => k,
    toast: vi.fn(),
    cfg: { backendUrl: API, token: TOKEN, modelId: 'phone-model' },
    desktopConfig: { mode: 'external', backendUrl: API, token: TOKEN, cloudUrl: API, cloudApiBase: API } as any,
    desktopMode: 'external',
    connState: 'ok',
    authInfo: { loggedIn: true, cloudUrl: API, username: 'u', tokenSource: 'tangu-login' },
  }, true)
}

const sessionRec = (id: string, extra: object = {}) => ({ id, title: id, created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z', ...extra })

beforeEach(() => {
  calls.length = 0
  store.clear()
  backendRestart.mockClear()
  account = { loggedIn: true, tokenValid: true }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  T.resetFocusForTests()
  H.resetHealth()
  C.forgetCatalog()
  armMobile()
  router = (url) => {
    if (url.endsWith('/health')) return { status: 200, body: { ok: true, sandbox: 'none' } }
    if (url.includes('/agent/sessions?archived=false')) return { status: 200, body: { sessions: [] } }
    if (url.includes('/agent/sessions?archived=true')) return { status: 200, body: { sessions: [] } }
    if (url.includes('/agent/models')) return { status: 200, body: { models: [{ id: 'mac-model', name: 'Mac' }], defaultModelId: 'mac-model' } }
    if (url.includes('/agent/agents')) return { status: 200, body: { agents: [] } }
    if (url.includes('/agent/skills')) return { status: 200, body: { skills: [] } }
    if (url.includes('/unit/config')) return { status: 200, body: { config: { homeDir: '/Users/mac', defaultWorkspaceDir: '/Users/mac/Forsion' } } }
    return { status: 200, body: {} }
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (globalThis as any).window
})

/** 不经 refocus 直接把焦点摆到 unit(负对照要在改造前的 store 上也能摆出这个局面)。 */
const focusUnitRaw = (): void => { T.useEngineFocus.setState({ ref: { kind: 'unit', unitId: U }, name: 'Mac mini' }) }

describe('§3.5 unit 目标的 401(负对照:改造前照样重启本机引擎)', () => {
  it('账号仍有效 → 只记那台「引擎鉴权」,绝不 backendRestart、不进过期态', async () => {
    focusUnitRaw()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000) // 越过 handleAuthExpired 与引擎重启的去抖
    useApp.getState().handleAuthExpired(`unit:${U}`)
    await new Promise((r) => setTimeout(r, 20))
    expect(backendRestart).not.toHaveBeenCalled()
    expect(H.healthOf(`unit:${U}`).state).toBe('engine-auth')
    expect(useApp.getState().connState).not.toBe('err')
    expect(useApp.getState().settingsOpen).toBe(false)
  })

  it('账号已失效 → 走 home 的过期流程(登录过期提示),仍不重启引擎', async () => {
    focusUnitRaw()
    account = { loggedIn: false, tokenValid: false }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7_200_000)
    useApp.getState().handleAuthExpired(`unit:${U}`)
    await vi.waitFor(() => expect(useApp.getState().connState).toBe('err'))
    expect(useApp.getState().connMessage).toBe('app.sessionExpired')
    expect(backendRestart).not.toHaveBeenCalled()
  })
})

describe('§3.7 焦点在 unit 时建会话(负对照:改造前打 home + 补整对象 PUT)', () => {
  it('建会话打那台电脑;引擎没回 agent_config → 补写走 PATCH,永不发 PUT', async () => {
    focusUnitRaw()
    router = (url, method) => {
      if (method === 'POST' && url === `${UNIT}/agent/sessions`) return { status: 200, body: { session: sessionRec('s-new') } }
      if (method === 'PATCH' && url === `${UNIT}/agent/sessions/s-new/config`) return { status: 200, body: { agent_config: {} } }
      return { status: 200, body: {} }
    }
    await useApp.getState().createInWorkspace({ key: '/Users/mac/proj', name: 'proj', kind: 'local', path: '/Users/mac/proj' })
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/agent/sessions')).map((c) => c.url)).toEqual([`${UNIT}/agent/sessions`])
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([])
    expect(calls.some((c) => c.method === 'PATCH' && c.url === `${UNIT}/agent/sessions/s-new/config`)).toBe(true)
    // 那台电脑的会话 = host 执行(真文件系统),不是沙箱
    const init = JSON.parse(calls.find((c) => c.method === 'POST' && c.url === `${UNIT}/agent/sessions`)!.body!).agent_config
    expect(init.execMode).toBe('host')
    expect(init.cwd).toBe('/Users/mac/proj')
  })
})

describe('setFocusTarget(S2 整端切换)', () => {
  it('切到 unit:目录 + 会话类走那台,收件箱 / 设置类仍打 home;家目录与默认工作区取那台的', async () => {
    router = (url) => {
      if (url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (url.startsWith(UNIT) && url.includes('/agent/sessions?archived=false')) return { status: 200, body: { sessions: [sessionRec('mac-1')] } }
      if (url.includes('/agent/sessions?archived')) return { status: 200, body: { sessions: [] } }
      if (url.includes('/agent/models')) return { status: 200, body: { models: [{ id: 'mac-model', name: 'Mac' }], defaultModelId: 'mac-model' } }
      if (url.includes('/unit/config')) return { status: 200, body: { config: { homeDir: '/Users/mac', defaultWorkspaceDir: '/Users/mac/Forsion' } } }
      return { status: 200, body: {} }
    }
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
    await vi.waitFor(() => expect(useApp.getState().sessions.map((s) => s.id)).toEqual(['mac-1']))
    expect(useApp.getState().connState).toBe('ok')
    expect(H.healthOf(`unit:${U}`).state).toBe('ready')
    expect(calls.some((c) => c.url === `${UNIT}/health`)).toBe(true)
    expect(calls.some((c) => c.url.startsWith(`${UNIT}/agent/models`))).toBe(true)
    await vi.waitFor(() => expect(useApp.getState().defaultWsDir).toBe('/Users/mac/Forsion'))
    expect(useApp.getState().homeDir).toBe('/Users/mac')
    // 焦点在 unit 时,手机偏好的模型不在那台的模型表里 → 回落那台的缺省
    const { newChatModelId } = await import('./appStore')
    expect(newChatModelId(useApp.getState())).toBe('mac-model')
    // 收件箱(home 类)仍打 home
    const api = await import('../services/backendService')
    await api.listInbox(useApp.getState().cfg).catch(() => {})
    expect(calls.filter((c) => c.url.includes('/agent/inbox')).every((c) => !c.url.startsWith(`${API}/units/`))).toBe(true)
    // 会话类老调用点(传整份 cfg)跟着会话走
    await api.listMessages(useApp.getState().cfg, 'mac-1').catch(() => {})
    expect(calls.some((c) => c.url.startsWith(`${UNIT}/agent/sessions/mac-1/messages`))).toBe(true)
    // unit 的请求带目标键(401 分流)
    expect(calls.filter((c) => c.url.startsWith(UNIT)).every((c) => (c.opts as { target?: string })?.target === `unit:${U}`)).toBe(true)
    // 持久化(按账号分键)
    expect([...store.keys()].some((k) => k.startsWith('forsion_engine_focus:') && k.includes('u-42'))).toBe(true)
  })

  it('竞态:旧焦点慢到的 listSessions 不得覆盖新目标的列表(代数先行)', async () => {
    let releaseHome!: () => void
    const homeGate = new Promise<void>((r) => { releaseHome = r })
    router = async (url) => {
      if (url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (url === `${API}/agent/sessions?archived=false&app_id=tangu`) { await homeGate; return { status: 200, body: { sessions: [sessionRec('home-stale')] } } }
      if (url.startsWith(UNIT) && url.includes('/agent/sessions?archived=false')) return { status: 200, body: { sessions: [sessionRec('mac-1')] } }
      if (url.includes('/agent/sessions?archived')) return { status: 200, body: { sessions: [] } }
      return { status: 200, body: {} }
    }
    const stale = useApp.getState().refreshSessions(useApp.getState().cfg) // home 的请求挂着
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    await vi.waitFor(() => expect(useApp.getState().sessions.map((s) => s.id)).toEqual(['mac-1']))
    releaseHome()
    await stale
    await new Promise((r) => setTimeout(r, 10))
    expect(useApp.getState().sessions.map((s) => s.id)).toEqual(['mac-1'])
  })

  it('换焦点中止全部 SSE 订阅、清会话 / 消息 / 配置 / 目录', async () => {
    const aborted: string[] = []
    router = (url) => {
      if (url.includes('/events')) return new Promise<Reply>(() => {}) // 挂住的事件流
      if (url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (url.includes('/agent/sessions?archived')) return { status: 200, body: { sessions: [] } }
      return { status: 200, body: {} }
    }
    useApp.setState({
      sessions: [sessionRec('home-1') as any], activeId: 'home-1',
      messagesBySession: { 'home-1': [{ id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: 1 }] },
      configBySession: { 'home-1': { execMode: 'sandbox' } },
      agentDefs: [{ slug: 'x', name: 'X' } as any], modelsResp: { models: [{ id: 'home-model', name: 'H' }], defaultModelId: 'home-model' } as any,
    })
    useApp.getState().subscribeRun('home-1', 'run-1', 'a1')
    const origAbort = AbortController.prototype.abort
    vi.spyOn(AbortController.prototype, 'abort').mockImplementation(function (this: AbortController, r?: unknown) { aborted.push('x'); return origAbort.call(this, r) })
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    expect(aborted.length).toBeGreaterThan(0)
    const st = useApp.getState()
    expect(st.runningBySession).toEqual({})
    expect(st.messagesBySession['home-1']).toBeUndefined()
    expect(st.configBySession).toEqual({})
    expect(st.agentDefs).toEqual([])
    expect(st.activeId).toBeNull()
  })

  it('审批兑现 / 询问打会话所在的目标(= 焦点)', async () => {
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    useApp.setState({
      activeId: 'mac-1',
      messagesBySession: { 'mac-1': [{ id: 'm1', role: 'assistant', content: '', status: 'streaming', timestamp: 1, approvals: [{ approvalId: 'ap1', runId: 'r1', name: 'run_bash', preview: '$ ls', status: 'pending' } as any] }] },
    })
    router = () => ({ status: 200, body: { ok: true } })
    calls.length = 0
    await useApp.getState().decideApproval('m1', 'ap1', 'approve', undefined, 'mac-1')
    expect(calls.map((c) => c.url)).toEqual([`${UNIT}/agent/runs/r1/approvals/ap1`])
  })

  it('桌面(非手机 / 网页版)不能把焦点切到远端:抛 TARGET_UNSUPPORTED,焦点不动', async () => {
    ;(globalThis as any).window = { tangu: {} }
    await expect(T.setFocusTarget({ kind: 'unit', unitId: U })).rejects.toMatchObject({ code: 'TARGET_UNSUPPORTED' })
    expect(T.focusRef()).toEqual({ kind: 'home' })
    expect(T.targetForRef({ kind: 'unit', unitId: U })).toBeNull()
  })

  it('切过去时那台不在线(可恢复)→ 不点重试,探针转好后自动重连(提示说的「恢复后会自动继续」得是真的)', async () => {
    let online = false
    router = (url) => {
      if (url.startsWith(`${API}/units/`) && !online) return { status: 503, body: { code: 'UNIT_OFFLINE', detail: 'Unit offline' } }
      if (url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (url.startsWith(UNIT) && url.includes('/agent/sessions?archived=false')) return { status: 200, body: { sessions: [sessionRec('mac-1')] } }
      if (url.includes('/agent/sessions?archived')) return { status: 200, body: { sessions: [] } }
      return { status: 200, body: {} }
    }
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    expect(useApp.getState().connState).toBe('err')
    expect(H.healthOf(`unit:${U}`).state).toBe('offline')
    online = true
    await vi.waitFor(() => expect(useApp.getState().connState).toBe('ok'), { timeout: 8000, interval: 100 })
    expect(useApp.getState().sessions.map((s) => s.id)).toEqual(['mac-1'])
  }, 15_000)

  it('设备不在账号下(404 UNIT_NOT_FOUND)→ 提示并切回本端', async () => {
    router = (url) => {
      if (url.startsWith(UNIT)) return { status: 404, body: { code: 'UNIT_NOT_FOUND', detail: 'Unit not found' } }
      if (url.endsWith('/health')) return { status: 200, body: { ok: true } }
      if (url.includes('/agent/sessions?archived')) return { status: 200, body: { sessions: [] } }
      return { status: 200, body: {} }
    }
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    await vi.waitFor(() => expect(T.focusRef()).toEqual({ kind: 'home' }))
    expect(H.healthOf(`unit:${U}`).state).toBe('gone')
  })
})
