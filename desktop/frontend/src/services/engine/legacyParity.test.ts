// P1-K6 S0 的「零行为变化」证据:服务函数改收 EngineArg 之后,老调用点(传整份 cfg)发出去的请求与改造前
// **逐字**一致(URL、头的键与值与顺序、init 的其余字段、authFetch 的参数个数);传解析层铸的 home 目标与传 cfg 等价。
// 期望值按改造前的源码手写(`authFetch(\`${cfg.backendUrl}${path}\`, { ...init, headers: headers(cfg.token) }, opts)`)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ sessions: [], runs: [], runId: 'r', ok: true }), { status: 200 }))
vi.mock('../http', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))
// 头像 / 图标返回 blob → objectURL(node 没有 createObjectURL)
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }))

const api = await import('../backendService')
const run = await import('../agentRunService')
const { asTarget } = await import('./targets')

const cfg = { backendUrl: 'http://127.0.0.1:4100', token: 'engine-token', modelId: 'fallback-model' }
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer engine-token' }

beforeEach(() => authFetch.mockClear())
afterEach(() => vi.unstubAllGlobals())

/** 同一次调用分别喂 cfg 与 asTarget(cfg),两次 authFetch 的参数必须完全相同。 */
async function both(call: (arg: typeof cfg | ReturnType<typeof asTarget>) => Promise<unknown>): Promise<unknown[]> {
  // 每次调用各自 new 的 AbortSignal 不是同一个对象:比对时只看「有没有带 signal」
  const norm = (c: unknown[]) => c.map((x, i) => (i === 1 && x && typeof x === 'object' && 'signal' in x
    ? { ...(x as object), signal: (x as { signal?: unknown }).signal ? '<signal>' : (x as { signal?: unknown }).signal }
    : x))
  authFetch.mockClear()
  await call(cfg)
  const legacy = authFetch.mock.calls.map((c) => norm([...c]))
  authFetch.mockClear()
  await call(asTarget(cfg))
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
    expect(api.workspaceDownloadUrl(cfg, 's', 'a/b.txt')).toBe(url)
    expect(api.workspaceDownloadUrl(asTarget(cfg), 's', 'a/b.txt')).toBe(url)
    vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) })
    const c = await both((a) => api.downloadWorkspaceFile(a, 's', 'a/b.txt')) as unknown[]
    expect(c).toEqual([url, { headers: H }])
  })
})

describe('agentRunService 13 个函数', () => {
  it('startRun:无模型时回退 cfg.modelId(legacy),目标本身不带模型', async () => {
    authFetch.mockClear()
    await run.startRun(cfg, { sessionId: 's', message: 'hi' })
    const [url, init, ...rest] = authFetch.mock.calls[0] as [string, RequestInit, ...unknown[]]
    expect(url).toBe('http://127.0.0.1:4100/agent/runs')
    expect(rest).toEqual([]) // 改造前是两参调用
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(H)
    expect(JSON.parse(String(init.body)).model_id).toBe('fallback-model')

    authFetch.mockClear()
    await run.startRun(asTarget(cfg), { sessionId: 's', message: 'hi' })
    expect(JSON.parse(String((authFetch.mock.calls[0][1] as RequestInit).body)).model_id).toBeUndefined()

    authFetch.mockClear()
    await run.startRun(asTarget(cfg), { sessionId: 's', message: 'hi', modelId: 'explicit' })
    expect(JSON.parse(String((authFetch.mock.calls[0][1] as RequestInit).body)).model_id).toBe('explicit')
  })

  it('带超时的(testConnection / resolveApproval / resolveInquiry)三参,其余两参', async () => {
    authFetch.mockClear()
    await run.testConnection(cfg)
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

describe('移动端本地收件箱 pull(改走目标的鉴权头)', () => {
  it('头与改造前一致;空 token 不外呼', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ broadcasts: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('window', { tangu: { mobile: true, cloudWeb: true } })
    const r = await api.pullInbox({ backendUrl: 'https://api.forsion.test/api/', token: 'forsion-token', modelId: '' })
    expect(r).toEqual({ pulled: true, added: 0 })
    expect(fetchSpy.mock.calls[0]).toEqual(['https://api.forsion.test/api/brain/inbox/broadcasts', { headers: { Authorization: 'Bearer forsion-token' } }])

    fetchSpy.mockClear()
    expect(await api.pullInbox({ backendUrl: 'https://api.forsion.test/api', token: '', modelId: '' })).toEqual({ pulled: false, added: 0, detail: 'no backend/token' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
