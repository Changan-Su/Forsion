// P1-K6 S2 · SSE 订阅按目标的重试策略(§3.6)。fake fetch(authFetch 桩)+ fake timers:
//   ① 429 → 按 Retry-After 续订,不抛(改造前 4xx 一律抛 → 限流直接杀掉事件流;负对照);
//   ② unit 503 UNIT_OFFLINE 持续 60s → 暂停、探针、恢复后以原 lastSeq 续订,不抛、不回退 fromSeq
//      (改造前按 5xx 重试 6 次 ≈ 21s 后抛 → 消息被标错;负对照);
//   ③ 404 UNIT_NOT_FOUND → 抛,健康表记 gone;④ 调用方身份取不到 → 不发请求、不重试、记 caller-unavailable;
//   ⑤ home 目标的 5xx 行为与改造前一致(6 次后抛)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Reply = { status: number; body?: string; headers?: Record<string, string> }
let router: (url: string, init: RequestInit) => Reply = () => ({ status: 500 })
const calls: Array<{ url: string; init: RequestInit; opts: unknown }> = []
vi.mock('./http', () => ({
  authFetch: async (url: string, init: RequestInit, opts?: unknown) => {
    calls.push({ url, init, opts })
    const r = router(url, init)
    return new Response(r.body ?? '', { status: r.status, headers: r.headers })
  },
}))

const run = await import('./agentRunService')
const T = await import('./engine/targets')
const H = await import('./engine/health')

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const API = 'https://api.forsion.test/api'
const UNIT_BASE = `${API}/units/${U}/proxy/engine`
const home = { backendUrl: 'http://127.0.0.1:4100', token: 'engine-token', modelId: '' }
const sse = (...evs: Array<{ seq: number; type: string }>): string => evs.map((e) => `data: ${JSON.stringify({ ...e, payload: {} })}\n\n`).join('')
const eventsCalls = (): string[] => calls.filter((c) => c.url.includes('/events')).map((c) => c.url.replace(/^.*\/events/, '/events'))

beforeEach(() => {
  calls.length = 0
  vi.useFakeTimers()
  H.resetHealth()
  T.resetFocusForTests()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function armUnit(): ReturnType<typeof T.targetForRef> {
  vi.stubGlobal('window', { tangu: { mobile: true }, addEventListener: () => {}, removeEventListener: () => {} })
  T.installEngineHost({ cfg: () => ({ backendUrl: API, token: 'forsion-token', modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
  const t = T.targetForRef({ kind: 'unit', unitId: U })
  expect(t?.base).toBe(UNIT_BASE)
  return t
}

describe('subscribeRunEvents × 429(负对照:改造前 4xx 一律抛)', () => {
  it('home:429 按 Retry-After 续订,不计失败、不抛', async () => {
    let n = 0
    router = (url) => {
      if (!url.includes('/events')) return { status: 200, body: '{}' }
      n++
      return n === 1 ? { status: 429, body: '{"detail":"Too many requests"}', headers: { 'Retry-After': '3' } } : { status: 200, body: sse({ seq: 1, type: 'done' }) }
    }
    const got: string[] = []
    const p = run.subscribeRunEvents(home, 'r1', (ev) => got.push(ev.type))
    let settled: unknown = 'pending'
    p.then(() => { settled = 'ok' }, (e) => { settled = e })
    await vi.advanceTimersByTimeAsync(2000)
    expect(settled).toBe('pending') // 还在等 Retry-After(3s),没抛
    await vi.advanceTimersByTimeAsync(2000)
    expect(settled).toBe('ok')
    expect(got).toEqual(['done'])
    expect(eventsCalls()).toEqual(['/events?fromSeq=0', '/events?fromSeq=0'])
  })

  it('unit:429 同样续订,健康表记 rate-limited → 成功后 ready', async () => {
    const t = armUnit()!
    let n = 0
    router = (url) => {
      if (!url.includes('/events')) return { status: 200, body: '{}' }
      n++
      return n === 1 ? { status: 429, body: '{}' } : { status: 200, body: sse({ seq: 1, type: 'done' }) }
    }
    const p = run.subscribeRunEvents(t, 'r1', () => {})
    await vi.advanceTimersByTimeAsync(100)
    expect(H.healthOf(t.key).state).toBe('rate-limited')
    await vi.advanceTimersByTimeAsync(10_500) // 缺省 Retry-After 10s
    await p
    expect(H.healthOf(t.key).state).toBe('ready')
  })
})

describe('subscribeRunEvents × unit 离线(负对照:改造前 5xx 6 次 ≈ 21s 后抛)', () => {
  it('503 UNIT_OFFLINE 持续 60s → 暂停、探针、恢复后以原 lastSeq 续订,不抛', async () => {
    const t = armUnit()!
    let online = true
    let evN = 0
    router = (url) => {
      if (url.endsWith('/health') || url.includes('/agent/special/config')) {
        return online ? { status: 200, body: '{"ok":true}' } : { status: 503, body: '{"code":"UNIT_OFFLINE","detail":"Unit offline"}' }
      }
      if (!url.includes('/events')) return { status: 200, body: '{}' }
      if (!online) return { status: 503, body: '{"code":"UNIT_OFFLINE","detail":"Unit offline"}' }
      evN++
      // 第一次:一条非终态事件后干净断流(hub 1h / 15min 断流同款)→ 断线
      if (evN === 1) { online = false; return { status: 200, body: sse({ seq: 1, type: 'token' }) } }
      return { status: 200, body: sse({ seq: 2, type: 'done' }) }
    }
    const seen: number[] = []
    const p = run.subscribeRunEvents(t, 'r1', (ev) => seen.push(ev.seq))
    let settled: unknown = 'pending'
    p.then(() => { settled = 'ok' }, (e) => { settled = e })
    await vi.advanceTimersByTimeAsync(1000)
    expect(H.healthOf(t.key).state).toBe('offline')
    await vi.advanceTimersByTimeAsync(59_000) // 离线整整一分钟:改造前早就抛了
    expect(settled).toBe('pending')
    // 离线期间不锤事件流:只有断线那一次 503,其余都是探针
    expect(eventsCalls()).toEqual(['/events?fromSeq=0', '/events?fromSeq=1'])
    expect(calls.filter((c) => c.url.endsWith('/health')).length).toBeGreaterThan(1)
    online = true
    await vi.advanceTimersByTimeAsync(31_000) // 下一轮探针(退避封顶 30s)见恢复 → 续订
    expect(settled).toBe('ok')
    expect(seen).toEqual([1, 2])
    expect(eventsCalls()).toEqual(['/events?fromSeq=0', '/events?fromSeq=1', '/events?fromSeq=1']) // fromSeq 不回退
    expect(H.healthOf(t.key).state).toBe('ready')
    // unit 的请求一律带目标键(401 分流);home 的不带
    expect(calls.every((c) => (c.opts as { target?: string } | undefined)?.target === t.key)).toBe(true)
  })

  it('回前台(visibilitychange)提前探一次,不必等满退避', async () => {
    const t = armUnit()!
    const listeners: Array<() => void> = []
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (_: string, cb: () => void) => listeners.push(cb), removeEventListener: () => {} })
    let online = false
    router = (url) => {
      if (url.endsWith('/health') || url.includes('/agent/special/config')) return online ? { status: 200, body: '{}' } : { status: 503, body: '{"code":"UNIT_OFFLINE"}' }
      return online ? { status: 200, body: sse({ seq: 1, type: 'done' }) } : { status: 503, body: '{"code":"UNIT_OFFLINE"}' }
    }
    const p = run.subscribeRunEvents(t, 'r1', () => {})
    await vi.advanceTimersByTimeAsync(20_000)
    online = true
    listeners.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(100)
    await p
    expect(H.healthOf(t.key).state).toBe('ready')
  })
})

describe('subscribeRunEvents × 终局', () => {
  it('404 UNIT_NOT_FOUND → 抛,健康表记 gone(不重试)', async () => {
    const t = armUnit()!
    router = (url) => (url.includes('/events') ? { status: 404, body: '{"code":"UNIT_NOT_FOUND","detail":"Unit not found"}' } : { status: 200, body: '{}' })
    const p = run.subscribeRunEvents(t, 'r1', () => {})
    const caught = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(await caught).toBeInstanceOf(Error)
    expect(H.healthOf(t.key).state).toBe('gone')
    expect(eventsCalls().length).toBe(1)
  })

  it('503 CALLER_UNAVAILABLE(K8 中继合成)→ 抛、不无限重试,健康表记 caller-unavailable', async () => {
    const t = armUnit()!
    router = (url) => (url.includes('/events') ? { status: 503, body: '{"code":"CALLER_UNAVAILABLE"}' } : { status: 200, body: '{}' })
    const caught = run.subscribeRunEvents(t, 'r1', () => {}).catch((e) => e)
    await vi.advanceTimersByTimeAsync(120_000)
    const e = await caught
    expect(e).toBeInstanceOf(Error)
    expect(eventsCalls().length).toBe(1)
    expect(H.healthOf(t.key).state).toBe('caller-unavailable')
  })

  it('403 BAD_CALLER_ASSERTION / UNIT_CALLER_EXPIRED 同样终局', async () => {
    for (const code of ['BAD_CALLER_ASSERTION', 'UNIT_CALLER_EXPIRED']) {
      calls.length = 0
      H.resetHealth()
      const t = armUnit()!
      router = (url) => (url.includes('/events') ? { status: 403, body: JSON.stringify({ code }) } : { status: 200, body: '{}' })
      const caught = run.subscribeRunEvents(t, 'r1', () => {}).catch((e) => e)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await caught, code).toBeInstanceOf(Error)
      expect(eventsCalls().length, code).toBe(1)
      expect(H.healthOf(t.key).state, code).toBe('caller-unavailable')
    }
  })

  it('P1-KF:403 REMOTE_CALLER_UNCONFIRMED 带 reason → 终局,错误文案按 reason、健康格记下 state / reason(提示条据此出同一句)', async () => {
    const { translate } = await import('../i18n')
    const t = armUnit()!
    router = (url) => (url.includes('/events')
      ? { status: 403, body: JSON.stringify({ code: 'REMOTE_CALLER_UNCONFIRMED', detail: 'x', state: 'denied', reason: 'roster-miss' }) }
      : { status: 200, body: '{}' })
    const caught = run.subscribeRunEvents(t, 'r1', () => {}).catch((e) => e)
    await vi.advanceTimersByTimeAsync(60_000)
    const e = await caught
    expect(e.message).toBe(translate('unitpage.remoteCallerRosterMiss'))
    expect(eventsCalls().length).toBe(1)
    expect(H.healthOf(t.key)).toMatchObject({ state: 'refused', code: 'REMOTE_CALLER_UNCONFIRMED', refusal: { state: 'denied', reason: 'roster-miss' } })
    expect(run.unitFailureMessage(t, 'refused', 'REMOTE_CALLER_UNCONFIRMED', { state: 'unconfirmed', reason: 'busy' })).toBe(translate('unitpage.remoteCallerBusy'))
    expect(run.unitFailureMessage(t, 'refused', 'REMOTE_CALLER_UNCONFIRMED')).toBe(translate('unitpage.remoteCallerUnconfirmed')) // 只有码 = 旧口径
  })

  it('原生桥取调用方头失败 → 失败关闭:请求不发,抛 CALLER_UNAVAILABLE', async () => {
    vi.stubGlobal('window', { tangu: { mobile: true, unitCallerHeaders: () => Promise.reject(new Error('keystore locked')) }, addEventListener: () => {}, removeEventListener: () => {} })
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: 'forsion-token', modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    router = () => ({ status: 200, body: sse({ seq: 1, type: 'done' }) })
    const caught = run.subscribeRunEvents(t, 'r1', () => {}).catch((e) => e)
    await vi.advanceTimersByTimeAsync(60_000)
    const e = await caught
    expect(e?.code).toBe('CALLER_UNAVAILABLE')
    expect(calls.length).toBe(0)
    expect(H.healthOf(t.key).state).toBe('caller-unavailable')
  })

  it('原生桥给的调用方头只放行 X-Forsion-Caller(别的键、带换行的值一律丢)', async () => {
    vi.stubGlobal('window', {
      tangu: { mobile: true, unitCallerHeaders: async () => ({ 'x-forsion-caller': 'fuc1.a.b', 'X-Forsion-Remote': '1', Authorization: 'Bearer evil' }) },
      addEventListener: () => {}, removeEventListener: () => {},
    })
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: 'forsion-token', modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    router = () => ({ status: 200, body: sse({ seq: 1, type: 'done' }) })
    const p = run.subscribeRunEvents(t, 'r1', () => {})
    await vi.advanceTimersByTimeAsync(10)
    await p
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer forsion-token', 'X-Forsion-Caller': 'fuc1.a.b' })
  })
})

describe('home 目标的 5xx 行为不变', () => {
  it('502 连续 → 重试 6 次后抛(约 21s),不走探针', async () => {
    router = (url) => (url.includes('/events') ? { status: 502, body: '' } : { status: 200, body: '{}' })
    const caught = run.subscribeRunEvents(home, 'r1', () => {}).catch((e) => e)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await caught).toBeInstanceOf(Error)
    expect(eventsCalls().length).toBe(7)
    expect(calls.some((c) => c.url.endsWith('/health'))).toBe(false)
    expect(calls.every((c) => c.opts === undefined)).toBe(true) // 两参调用,与改造前逐字一致
  })

  it('home 的 401 照旧直接抛', async () => {
    router = () => ({ status: 401, body: '{"detail":"Unauthorized"}' })
    const caught = run.subscribeRunEvents(home, 'r1', () => {}).catch((e) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(await caught).toBeInstanceOf(Error)
    expect(eventsCalls().length).toBe(1)
  })
})
