// P1-K6 S2 · 健康状态机:classify 全表(hub / unitWeb / 引擎 / K8 中继合成的码)、状态转移、waitReady、probeTarget。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Reply = { status: number; body?: unknown } | 'hang'
let router: (url: string) => Reply = () => ({ status: 200, body: {} })
const authFetch = vi.fn(async (url: string, init?: RequestInit) => {
  const r = router(url)
  if (r === 'hang') {
    // 挂住的请求(隧道那头迟迟不回):只有 signal 中止才结束 —— 与真 fetch 同语义
    return new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal
      if (sig?.aborted) { reject(sig.reason); return }
      sig?.addEventListener('abort', () => reject(sig.reason), { once: true })
    })
  }
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
})
vi.mock('../http', () => ({ authFetch: (url: string, init?: RequestInit) => authFetch(url, init) }))

const H = await import('./health')
const T = await import('./targets')

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const API = 'https://api.forsion.test/api'
const KEY = `unit:${U}` as const

beforeEach(() => {
  authFetch.mockClear()
  H.resetHealth()
  T.resetFocusForTests()
  vi.stubGlobal('window', { tangu: { mobile: true }, addEventListener: () => {}, removeEventListener: () => {} })
  T.installEngineHost({ cfg: () => ({ backendUrl: API, token: 'tk', modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('classify', () => {
  it.each([
    [200, null, 'ok'],
    [204, null, 'ok'],
    [0, null, 'offline'],
    // hub 401 体无 code、引擎 401 {detail:'Unauthorized'}:分不开 → 调用方复检账号
    [401, { detail: 'No token provided' }, 'account-auth?'],
    [401, { detail: 'Unauthorized' }, 'account-auth?'],
    [401, { code: 'UNPAIRED' }, 'account-auth?'],
    [403, { code: 'LOCAL_ONLY' }, 'local-only'],
    [404, { code: 'UNIT_NOT_FOUND' }, 'gone'],
    [404, { detail: 'Not found' }, 'fatal'],
    [413, { code: 'UNIT_BODY_TOO_LARGE' }, 'too-large'],
    [429, { code: 'RATE_LIMITED' }, 'rate-limited'],
    [429, null, 'rate-limited'],
    [503, { code: 'UNIT_OFFLINE' }, 'offline'],
    [503, { code: 'ENGINE_NOT_READY' }, 'engine-unavailable'],
    [502, { code: 'UNIT_DISCONNECTED' }, 'offline'],
    [504, { code: 'UNIT_TIMEOUT' }, 'offline'],
    [500, null, 'transient'],
    [503, null, 'transient'],
    // R-32:K8 中继合成的失败关闭 + K1 / unitWeb 的调用方身份拒绝 —— 终局
    [503, { code: 'CALLER_UNAVAILABLE' }, 'caller-unavailable'],
    [503, { code: 'CALLER_UNSUPPORTED' }, 'caller-unavailable'],
    [403, { code: 'UNIT_CALLER_INVALID' }, 'caller-unavailable'],
    [403, { code: 'UNIT_CALLER_EXPIRED' }, 'caller-unavailable'],
    [403, { code: 'UNIT_CALLER_SECRET_MISMATCH' }, 'caller-unavailable'],
    [403, { code: 'BAD_CALLER_ASSERTION' }, 'caller-unavailable'],
    // K4 / K2 的执行设备拒绝:终局
    [403, { code: 'REMOTE_SESSIONS_OFF' }, 'refused'],
    [403, { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending' }, 'refused'],
    [423, { code: 'REMOTE_LOCKED' }, 'refused'],
    [400, { code: 'REMOTE_CWD_FORBIDDEN' }, 'fatal'], // 单条请求的事,不是这台引擎不能用
    [400, { detail: 'bad' }, 'fatal'],
  ])('%i %j → %s', (status, body, want) => {
    expect(H.classify(status as number, body as never)).toBe(want)
  })

  it('classifyError:失败关闭的 CALLER_UNAVAILABLE、带 status 的错、网络错', () => {
    expect(H.classifyError(T.callerUnavailableError())).toBe('caller-unavailable')
    expect(H.classifyError(Object.assign(new Error('x'), { status: 404, code: 'UNIT_NOT_FOUND' }))).toBe('gone')
    expect(H.classifyError(new TypeError('Failed to fetch'))).toBe('offline')
  })
})

describe('健康表', () => {
  it('一个目标一格,互不影响;同态不重写 since', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    H.noteVerdict(KEY, 'offline')
    vi.spyOn(Date, 'now').mockReturnValue(5000)
    H.noteVerdict(KEY, 'offline')
    expect(H.healthOf(KEY)).toMatchObject({ state: 'offline', since: 1000 })
    expect(H.healthOf('home').state).toBe('unknown')
    H.noteVerdict('unit:other', 'ok')
    expect(H.healthOf(KEY).state).toBe('offline')
    H.noteVerdict(KEY, 'ok')
    expect(H.healthOf(KEY).state).toBe('ready')
    H.noteVerdict(KEY, 'local-only') // 单条请求的事:不改健康态
    H.noteVerdict(KEY, 'fatal')
    expect(H.healthOf(KEY).state).toBe('ready')
  })
})

describe('waitReady / probeTarget', () => {
  it('ready 立即 resolve;终局立即 reject(不等、不探)', async () => {
    H.noteVerdict(KEY, 'ok')
    await expect(H.waitReady(KEY)).resolves.toBeUndefined()
    for (const v of ['gone', 'caller-unavailable', 'refused'] as const) {
      H.resetHealth()
      H.noteVerdict(KEY, v)
      await expect(H.waitReady(KEY)).rejects.toMatchObject({ health: v === 'gone' ? 'gone' : v })
    }
    H.resetHealth()
    H.noteHealth(KEY, { state: 'engine-auth', since: 1 })
    await expect(H.waitReady(KEY)).rejects.toMatchObject({ health: 'engine-auth' })
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('离线 → 按退避探 /health + 带鉴权探针,恢复即 resolve;多个等待者共用一条探针环', async () => {
    vi.useFakeTimers()
    let online = false
    router = (url) => (online ? { status: 200, body: { ok: true } } : url.endsWith('/health') ? { status: 503, body: { code: 'UNIT_OFFLINE' } } : { status: 200 })
    H.noteVerdict(KEY, 'offline')
    const a = H.waitReady(KEY)
    const b = H.waitReady(KEY)
    await vi.advanceTimersByTimeAsync(2000) // 第一轮探针
    await vi.advanceTimersByTimeAsync(4000) // 第二轮
    const probes = authFetch.mock.calls.filter((c) => String(c[0]).endsWith('/health')).length
    expect(probes).toBe(2) // 两个等待者,一条环
    online = true
    await vi.advanceTimersByTimeAsync(8000)
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined])
    expect(H.healthOf(KEY).state).toBe('ready')
  })

  it('等待中设备被移除(探针拿到 404 UNIT_NOT_FOUND)→ reject,不再探', async () => {
    vi.useFakeTimers()
    router = () => ({ status: 404, body: { code: 'UNIT_NOT_FOUND' } })
    H.noteVerdict(KEY, 'offline')
    const p = H.waitReady(KEY).catch((e) => e)
    await vi.advanceTimersByTimeAsync(2100)
    expect(await p).toMatchObject({ health: 'gone' })
    const n = authFetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(authFetch.mock.calls.length).toBe(n)
  })

  it('signal 中止 → reject;没人等了探针环收工', async () => {
    vi.useFakeTimers()
    router = () => ({ status: 503, body: { code: 'UNIT_OFFLINE' } })
    H.noteVerdict(KEY, 'offline')
    const ac = new AbortController()
    const p = H.waitReady(KEY, ac.signal).catch((e) => e)
    ac.abort()
    expect(await p).toBeDefined()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(authFetch.mock.calls.length).toBeLessThanOrEqual(1) // 最多醒来探一次就发现没人等了
  })

  // 评审 F2:焦点离开那台时撤掉等待者 —— 探针环当场收工,**在飞的探针也撤**,慢到的结果不许把一格旧健康态写回表里
  it('最后一个等待者离开 → 在飞的探针一并中止,不写回健康表;之后到的等待者起新环', async () => {
    vi.useFakeTimers()
    router = () => 'hang'
    H.noteVerdict(KEY, 'offline')
    const ac = new AbortController()
    const p = H.waitReady(KEY, ac.signal).catch((e) => e)
    await vi.advanceTimersByTimeAsync(2000) // 第一轮探针发出去,挂住
    expect(authFetch).toHaveBeenCalledTimes(1)
    const sig = (authFetch.mock.calls[0][1] as RequestInit | undefined)?.signal
    expect(sig?.aborted).toBe(false)
    ac.abort()
    await p
    expect(sig?.aborted).toBe(true) // 在飞的探针被撤
    H.resetHealth(KEY) // 宿主离开那台时清格
    await vi.advanceTimersByTimeAsync(60_000)
    expect(H.useTargetHealth.getState().byKey[KEY]).toBeUndefined() // 没有迟到的结果写回来
    expect(authFetch).toHaveBeenCalledTimes(1)
    // 同一目标之后再来的等待者:起一条新环照常探
    router = () => ({ status: 200, body: {} })
    H.noteVerdict(KEY, 'offline')
    const q = H.waitReady(KEY)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(q).resolves.toBeUndefined()
    expect(H.healthOf(KEY).state).toBe('ready')
  })

  it('限流态带 retryAt → 探针至少等到那一刻(不在 429 的 hub 上按 2 / 4 / 8s 追打)', async () => {
    vi.useFakeTimers()
    router = () => ({ status: 200, body: {} })
    H.noteVerdict(KEY, 'rate-limited', { retryAt: Date.now() + 10_000 })
    const p = H.waitReady(KEY)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(authFetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    await expect(p).resolves.toBeUndefined()
    expect(authFetch).toHaveBeenCalled()
  })

  it('probeTarget:/health 好 + 探针 401 → engine-auth;引擎没起 → engine-unavailable;都好 → ready', async () => {
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    router = (url) => (url.endsWith('/health') ? { status: 200, body: {} } : { status: 401, body: {} })
    expect((await H.probeTarget(t)).state).toBe('engine-auth')
    router = () => ({ status: 503, body: { code: 'ENGINE_NOT_READY' } })
    expect((await H.probeTarget(t)).state).toBe('engine-unavailable')
    router = () => ({ status: 200, body: {} })
    expect((await H.probeTarget(t)).state).toBe('ready')
  })
})
