// P1-K6 的「零行为变化」证据:服务函数改收目标之后(S0 兼容联合 → S3 只收 EngineTarget),发出去的请求与改造前
// **逐字**一致(URL、头的键与值与顺序、init 的其余字段、authFetch 的参数个数)。
// 期望值按改造前的源码手写(`authFetch(\`${cfg.backendUrl}${path}\`, { ...init, headers: headers(cfg.token) }, opts)`),
// S3 起两种合法的 home 目标 —— 活目标 homeTarget()(宿主 cfg 就是这份)与显式快照 connectionTarget(cfg)—— 都必须等于它。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ sessions: [], runs: [], runId: 'r', ok: true }), { status: 200 }))
vi.mock('../http', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))
// 头像 / 图标返回 blob → objectURL(node 没有 createObjectURL)
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }))

const api = await import('../backendService')
const run = await import('../agentRunService')
const { connectionTarget, homeTarget, installEngineHost } = await import('./targets')

const cfg = { backendUrl: 'http://127.0.0.1:4100', token: 'engine-token', modelId: 'fallback-model' }
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer engine-token' }

beforeEach(() => {
  authFetch.mockClear()
  installEngineHost({ cfg: () => cfg, desktopConfig: () => null }) // 本端宿主的 cfg 就是这份:homeTarget() 读它
})
afterEach(() => vi.unstubAllGlobals())

/** 同一次调用分别喂 homeTarget()(活目标)与 connectionTarget(cfg)(快照),两次 authFetch 的参数必须完全相同。 */
async function both(call: (arg: ReturnType<typeof homeTarget>) => Promise<unknown>): Promise<unknown[]> {
  // 每次调用各自 new 的 AbortSignal 不是同一个对象:比对时只看「有没有带 signal」
  const norm = (c: unknown[]) => c.map((x, i) => (i === 1 && x && typeof x === 'object' && 'signal' in x
    ? { ...(x as object), signal: (x as { signal?: unknown }).signal ? '<signal>' : (x as { signal?: unknown }).signal }
    : x))
  authFetch.mockClear()
  await call(homeTarget())
  const legacy = authFetch.mock.calls.map((c) => norm([...c]))
  authFetch.mockClear()
  await call(connectionTarget(cfg))
  const viaTarget = authFetch.mock.calls.map((c) => norm([...c]))
  expect(viaTarget).toEqual(legacy)
  expect(viaTarget.map((c) => c.length)).toEqual(legacy.map((c) => c.length))
  return legacy[0]
}

describe('backendService:request() 与直连五处', () => {
  it('GET(listSessions):url / 头 / 第三参(opts=undefined)与改造前一致', async () => {
    const [url, init, opts] = (await both((a) => api.listSessions(a))) as [string, RequestInit, unknown]
    expect(url).toBe('http://127.0.0.1:4100/agent/sessions?archived=false&app_id=tangu')
    expect(Object.entries(init.headers as object)).toEqual(Object.entries(H))
    expect(opts).toBeUndefined()
  })

  it('POST(createSession):method / body 原样,调用方 init.headers 仍被整组覆盖(改造前就是如此)', async () => {
    const [, init] = (await both((a) => api.createSession(a, { title: 'x' }))) as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ app_id: 'tangu', title: 'x' })
    expect(init.headers).toEqual(H)
  })

  it('团队 / Agent 头像、项目图标:两参调用、同一组头', async () => {
    for (const [call, path] of [
      [(a: any) => api.fetchTeamAvatar(a, 'core'), '/agent/teams/core/avatar'],
      [(a: any) => api.fetchAgentAvatar(a, 'xyra'), '/agent/agents/xyra/avatar'],
      [(a: any) => api.fetchProjectIcon(a, { sessionId: 's 1' }), '/agent/project-context/icon?sessionId=s%201'],
    ] as const) {
      const c = await both(call) as unknown[]
      expect(c).toEqual([`http://127.0.0.1:4100${path}`, { headers: H }])
    }
  })

  it('workspaceDownloadUrl 与 downloadWorkspaceFile 的 URL 一致', async () => {
    const url = 'http://127.0.0.1:4100/agent/workspace/download?sessionId=s&appId=tangu&path=a%2Fb.txt'
    expect(api.workspaceDownloadUrl(homeTarget(), 's', 'a/b.txt')).toBe(url)
    expect(api.workspaceDownloadUrl(connectionTarget(cfg), 's', 'a/b.txt')).toBe(url)
    vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) })
    const c = await both((a) => api.downloadWorkspaceFile(a, 's', 'a/b.txt')) as unknown[]
    expect(c).toEqual([url, { headers: H }])
  })
})

describe('agentRunService 13 个函数', () => {
  it('startRun:URL / 头 / 两参调用与改造前一致;目标不带模型(回退链在调用方:appStore.send 的 sessionModelId,home 缺省即 cfg.modelId)', async () => {
    authFetch.mockClear()
    await run.startRun(homeTarget(), { sessionId: 's', message: 'hi', modelId: 'fallback-model' })
    const [url, init, ...rest] = authFetch.mock.calls[0] as [string, RequestInit, ...unknown[]]
    expect(url).toBe('http://127.0.0.1:4100/agent/runs')
    expect(rest).toEqual([]) // 改造前是两参调用
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(H)
    expect(JSON.parse(String(init.body)).model_id).toBe('fallback-model')

    // S3 删了服务层对 legacy cfg.modelId 的兜底:它与调用方回退链(defaultModelOf:home = cfg.modelId)同值,
    // 调用方的链由 appStore.test「新会话固化模型」钉住。不带模型 = 交给引擎按 profile 缺省。
    authFetch.mockClear()
    await run.startRun(connectionTarget(cfg), { sessionId: 's', message: 'hi' })
    expect(JSON.parse(String((authFetch.mock.calls[0][1] as RequestInit).body)).model_id).toBeUndefined()

    authFetch.mockClear()
    await run.startRun(connectionTarget(cfg), { sessionId: 's', message: 'hi', modelId: 'explicit' })
    expect(JSON.parse(String((authFetch.mock.calls[0][1] as RequestInit).body)).model_id).toBe('explicit')
  })

  it('带超时的(testConnection / resolveApproval / resolveInquiry)三参,其余两参', async () => {
    authFetch.mockClear()
    await run.testConnection(homeTarget())
    expect(authFetch.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['http://127.0.0.1:4100/health', { timeoutMs: 15000 }],
      ['http://127.0.0.1:4100/agent/special/config', { timeoutMs: 15000 }],
    ])
    expect(authFetch.mock.calls.every((c) => JSON.stringify((c[1] as RequestInit).headers) === JSON.stringify(H))).toBe(true)

    const appr = await both((a) => run.resolveApproval(a, 'r', 'ap', 'approve')) as [string, RequestInit, unknown]
    expect(appr[0]).toBe('http://127.0.0.1:4100/agent/runs/r/approvals/ap')
    expect(appr[2]).toEqual({ timeoutMs: 15000 })
    const inq = await both((a) => run.resolveInquiry(a, 'r', 'q', 'yes')) as [string, RequestInit, unknown]
    expect(inq[2]).toEqual({ timeoutMs: 15000 })

    for (const call of [
      (a: any) => run.steerRun(a, 'r', { message: 'm' }),
      (a: any) => run.cancelSteer(a, 'r', 'mid'),
      (a: any) => run.sendDeskCapture(a, 'r', 'shot', { error: 'x' }),
      (a: any) => run.sendUiAck(a, 'r', 'ack', { ok: true }),
      (a: any) => run.listActiveRuns(a, 's'),
    ]) {
      const c = await both(call) as unknown[]
      expect(c.length).toBe(2)
      expect((c[1] as RequestInit).headers).toEqual(H)
    }
  })
})

describe('移动端本地收件箱 pull(S1:广播是云端 API,基址读 cloudApiBase;凭据走目标鉴权头)', () => {
  const fetchSpy = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ broadcasts: [] }), { status: 200 }))
  beforeEach(() => {
    fetchSpy.mockClear()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('window', { tangu: { mobile: true, cloudWeb: true } })
  })

  it('今天(引擎 = 云网关):URL 与头都与改造前逐字一致', async () => {
    installEngineHost({ cfg: () => cfg, desktopConfig: () => ({ cloudUrl: 'https://api.forsion.test/api', cloudApiBase: 'https://api.forsion.test/api' }) })
    const r = await api.pullInbox(connectionTarget({ backendUrl: 'https://api.forsion.test/api', token: 'forsion-token', modelId: '' }))
    expect(r).toEqual({ pulled: true, added: 0 })
    expect(fetchSpy.mock.calls[0]).toEqual(['https://api.forsion.test/api/brain/inbox/broadcasts', { headers: { Authorization: 'Bearer forsion-token' } }])
  })

  it('引擎切到「我的电脑」后广播仍打云端(不跟着 backendUrl 进隧道)', async () => {
    installEngineHost({ cfg: () => cfg, desktopConfig: () => ({ cloudApiBase: 'https://api.forsion.test/api' }) })
    await api.pullInbox(connectionTarget({ backendUrl: 'https://api.forsion.test/api/units/u1/proxy/engine', token: 'forsion-token', modelId: '' }))
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.forsion.test/api/brain/inbox/broadcasts')
  })

  it('空 token / 云端基址未就绪 → 不外呼', async () => {
    installEngineHost({ cfg: () => cfg, desktopConfig: () => ({ cloudApiBase: 'https://api.forsion.test/api' }) })
    expect(await api.pullInbox(connectionTarget({ backendUrl: 'https://api.forsion.test/api', token: '', modelId: '' }))).toEqual({ pulled: false, added: 0, detail: 'no backend/token' })
    installEngineHost({ cfg: () => cfg, desktopConfig: () => null })
    expect(await api.pullInbox(connectionTarget({ backendUrl: 'https://api.forsion.test/api', token: 'forsion-token', modelId: '' }))).toEqual({ pulled: false, added: 0, detail: 'no backend/token' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
