import { afterEach, expect, it, vi } from 'vitest'
import { createCloudHttp } from '../../../../web/src/amadeus/cloudHttp'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const http = (signal?: AbortSignal) => createCloudHttp({ apiBase: 'https://test/api', getToken: () => 'token', clientId: 'test', onUnauthorized: vi.fn(), signal })
function stalled() {
  let signal: AbortSignal
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    signal = init.signal
    return { status: 200, ok: true, text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }
  }))
  return () => signal!
}
it('times out after headers while reading a stalled body', async () => {
  vi.useFakeTimers(); const signal = stalled()
  const result = expect(http().get('/file')).rejects.toMatchObject({ status: 0 })
  await vi.advanceTimersByTimeAsync(30_000); await result; expect(signal().aborted).toBe(true)
})
it('propagates session cancellation after headers', async () => {
  const signal = stalled(), scope = new AbortController()
  const result = expect(http(scope.signal).get('/file')).rejects.toMatchObject({ body: { code: 'ACCOUNT_CHANGED' } })
  await Promise.resolve(); scope.abort(); await result; expect(signal().aborted).toBe(true)
})
it('body failures reject, but valid empty responses succeed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, text: async () => { throw Error('body disconnected') } })))
  await expect(http().put('/file', {})).rejects.toMatchObject({ status: 0 })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  await expect(http().del('/file')).resolves.toBeUndefined()
})
