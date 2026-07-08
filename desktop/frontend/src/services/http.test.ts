import { describe, it, expect, vi, afterEach } from 'vitest'
import { authFetch } from './http'

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
