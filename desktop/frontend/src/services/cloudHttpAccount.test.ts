import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudHttp } from '../../../../web/src/amadeus/cloudHttp'

const jwt = (userId: string, jti = '1') => `header.${btoa(JSON.stringify({ userId, jti }))}.signature`
afterEach(() => vi.unstubAllGlobals())

describe('cloud HTTP account boundary', () => {
  it('does not dispatch a cached bridge’s write under the next account', async () => {
    let token = jwt('a')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const http = createCloudHttp({ apiBase: 'https://cloud.test/api', getToken: () => token, clientId: 'test', onUnauthorized: vi.fn() })
    token = jwt('b')
    await expect(http.put('/amadeus/private.md', { content: 'a content' })).rejects.toMatchObject({ body: { code: 'ACCOUNT_CHANGED' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('drops a delayed previous-account result without signing out the current account', async () => {
    let token = jwt('a')
    let respond!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve })))
    const onUnauthorized = vi.fn()
    const http = createCloudHttp({ apiBase: 'https://cloud.test/api', getToken: () => token, clientId: 'test', onUnauthorized })
    const request = http.get('/amadeus/vaults')
    token = jwt('b')
    respond(new Response('', { status: 401 }))
    await expect(request).rejects.toMatchObject({ body: { code: 'ACCOUNT_CHANGED' } })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('accepts a refreshed token for the same user', async () => {
    let token = jwt('a')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')))
    const http = createCloudHttp({ apiBase: 'https://cloud.test/api', getToken: () => token, clientId: 'test', onUnauthorized: vi.fn() })
    token = jwt('a', 'refreshed')
    await expect(http.get('/amadeus/vaults')).resolves.toEqual({ ok: true })
  })

  it('preserves path prefixes in requests and rejects reusing a bridge at another backend path', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    const config = { apiBase: 'https://cloud.test/one/api', getToken: () => jwt('a'), clientId: 'test', onUnauthorized: vi.fn() }
    const http = createCloudHttp(config)
    await http.get('/amadeus/vaults')
    expect(fetch).toHaveBeenCalledWith('https://cloud.test/one/api/amadeus/vaults', expect.anything())
    config.apiBase = 'https://cloud.test/two/api'
    await expect(http.put('/amadeus/private.md', { content: 'private to one' })).rejects.toMatchObject({ body: { code: 'ACCOUNT_CHANGED' } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
