import { describe, it, expect, vi, afterEach } from 'vitest'
import { authFetch } from './http'
import { getProjectSettings } from './backendService'
import type { TanguDesktopConfig } from '../types'

// fetch 桩:signal abort 时按真实 fetch 行为 reject(reason);否则挂起不 resolve。
const hangUntilAbort = (_url: any, init: any): Promise<any> =>
  new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () =>
      rej((init.signal as AbortSignal).reason ?? new DOMException('aborted', 'AbortError')))
  })

afterEach(() => vi.restoreAllMocks())

describe('authFetch opt-in timeout', () => {
  it('aborts a hung request after timeoutMs (TimeoutError)', async () => {
    vi.stubGlobal('fetch', hangUntilAbort)
    await expect(authFetch('https://x.test', {}, { timeoutMs: 30 }))
      .rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('attaches NO signal when timeoutMs is absent (SSE/long-poll stay open)', async () => {
    let seen: any = 'unset'
    vi.stubGlobal('fetch', (_url: any, init: any) => { seen = init?.signal; return Promise.resolve({ status: 200 }) })
    await authFetch('https://x.test')
    expect(seen).toBeUndefined()
  })

  it('caller cancel wins over timeout (AbortError)', async () => {
    vi.stubGlobal('fetch', hangUntilAbort)
    const ac = new AbortController()
    const p = authFetch('https://x.test', { signal: ac.signal }, { timeoutMs: 5000 })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/*
 * 超时要管到调用方读完响应体:头到了、体卡住(半截 JSON 后连接挂着)时 r.json() 必须按时失败,
 * 而不是永远等下去(Codex 09-24:Chrome 扩展设置卡片的换码按钮会永远置灰、状态轮询越叠越多)。
 * 真 Chromium / Electron 里「abort 让未读完的体报错、已读完的不受影响」另有实测,见 docs/Log 09-25 那条。
 */

/** 假 fetch:立刻给响应头,体只吐半截 JSON 就挂着;signal abort 时像真 Chromium 一样让体以**通用 AbortError** 报错(不带 abort 原因)。 */
function stalledBody(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"partial":'))
      init?.signal?.addEventListener('abort', () => c.error(new DOMException('BodyStreamBuffer was aborted', 'AbortError')), { once: true })
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
}

/** 等到 promise 落定或 ms 到点,返回 resolved / rejected:<错误名> / hung。 */
const settle = (p: Promise<unknown>, ms: number): Promise<string> => Promise.race([
  p.then(() => 'resolved', (e: { name?: string }) => `rejected:${e?.name}`),
  new Promise<string>((r) => setTimeout(() => r('hung'), ms)),
])

describe('authFetch opt-in timeout × response body', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('covers the body: headers arrive, body stalls → r.json() rejects with TimeoutError instead of hanging', async () => {
    vi.stubGlobal('fetch', stalledBody())
    const r = await authFetch('http://engine.test/agent/x', undefined, { timeoutMs: 50 })
    expect(await settle(r.json(), 1000)).toBe('rejected:TimeoutError')
  })

  it('request() callers that opted in fail on time too (getProjectSettings)', async () => {
    vi.stubGlobal('fetch', stalledBody())
    const cfg = { backendUrl: 'http://engine.test', token: 't' } as TanguDesktopConfig
    expect(await settle(getProjectSettings(cfg, { sessionId: 's' }, { timeoutMs: 50 }), 1000)).toBe('rejected:TimeoutError')
  })

  it('a caller\'s own cancel during the body read stays the caller\'s abort, not a timeout', async () => {
    vi.stubGlobal('fetch', stalledBody())
    const ac = new AbortController()
    const r = await authFetch('http://engine.test/agent/x', { signal: ac.signal }, { timeoutMs: 5000 })
    const read = settle(r.json(), 1000)
    ac.abort()
    expect(await read).toBe('rejected:AbortError')
  })

  it('without timeoutMs a slow body is left alone (SSE / long polls keep streaming)', async () => {
    vi.stubGlobal('fetch', stalledBody())
    const r = await authFetch('http://engine.test/agent/sse')
    expect(await settle(r.json(), 200)).toBe('hung')
  })

  it('tolerates test stubs that return a bare object instead of a Response', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) }))
    const r = await authFetch('http://engine.test/agent/x', undefined, { timeoutMs: 1000 })
    await expect(r.json()).resolves.toEqual({ ok: true })
  })
})
