import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cache = vi.hoisted(() => ({ clearCloudAccountCache: vi.fn(), syncCloudAccountCache: vi.fn() }))
vi.mock('./cloudAccountCache', () => cache)

let values: Map<string, string>
let nativeFetch: ReturnType<typeof vi.fn<typeof fetch>>
let browserWindow: { fetch: typeof fetch; addEventListener: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; tangu?: any }
let browserLocation: { href: string; origin: string; pathname: string; replace: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  values = new Map([['forsion_token', 'token-a']])
  nativeFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), 'https://forsion.test/')
    if (url.pathname.endsWith('/auth/me')) {
      const id = new Headers(init?.headers).get('Authorization')?.replace('Bearer token-', '')
      return json({ id, username: `user-${id}`, role: 'user' })
    }
    return json({ ok: true })
  })
  browserLocation = { href: 'https://forsion.test/', origin: 'https://forsion.test', pathname: '/', replace: vi.fn(), reload: vi.fn() }
  browserWindow = { fetch: nativeFetch, addEventListener: vi.fn(), open: vi.fn() }
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  vi.stubGlobal('location', browserLocation)
  vi.stubGlobal('window', browserWindow)
  vi.stubGlobal('history', { replaceState: vi.fn() })
  vi.stubGlobal('fetch', nativeFetch)
})
afterEach(() => vi.unstubAllGlobals())

describe('existing Web reuses browser Account', () => {
  it('verifies a callback before storing it and strips its URL before the first request', async () => {
    browserLocation.href = 'https://forsion.test/?token=token-b&ui=mobile'
    let resolve!: (response: Response) => void
    nativeFetch.mockImplementationOnce(() => new Promise((yes) => { resolve = yes }))
    const { captureTokenFromUrl } = await import('../../../../web/src/webShim')
    const pending = captureTokenFromUrl()
    await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalledOnce())
    expect(history.replaceState).toHaveBeenCalledWith(null, '', 'https://forsion.test/?ui=mobile')
    expect(values.get('forsion_token')).toBe('token-a')
    resolve(json({ id: 'b', username: 'user-b', role: 'user' }))
    expect(await pending).toBe(true)
    expect(values.get('forsion_token')).toBe('token-b')
    expect(cache.syncCloudAccountCache).toHaveBeenCalledWith('https://forsion.test/api', 'token-b')
  })

  it('installs the desktop AccountCard contract and keeps cloud config/token access intact', async () => {
    const { installWebShim, getToken, getWebAccount } = await import('../../../../web/src/webShim')
    expect(await installWebShim()).toBe(true)
    expect(getToken()).toBe('token-a')
    expect(await browserWindow.tangu.getConfig()).toMatchObject({ backendUrl: 'https://forsion.test/api', token: 'token-a', cloudUrl: 'https://forsion.test/api' })
    expect(await browserWindow.tangu.authStatus()).toMatchObject({ loggedIn: true, username: 'user-a', tokenSource: 'tangu-login' })
    const prepare = vi.fn(async () => {})
    const changed = vi.fn()
    browserWindow.tangu.onAuthWillChange(prepare)
    browserWindow.tangu.onAuthChanged(changed)
    await getWebAccount().adoptToken('token-b')
    expect(prepare).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ loggedIn: true, userId: 'b' }))
    expect(await browserWindow.tangu.accountQuota()).toEqual({ status: 200, json: { ok: true } })
    expect(new Headers(nativeFetch.mock.calls.at(-1)?.[1]?.headers).get('Authorization')).toBe('Bearer token-b')
  })

  it('rejects stale API response bodies and stale explicit credentials after switching', async () => {
    const { installWebShim, getWebAccount } = await import('../../../../web/src/webShim')
    await installWebShim()
    const response = await browserWindow.fetch('/api/agent/private', { headers: { Authorization: 'Bearer token-a' } })
    await getWebAccount().adoptToken('token-b')
    await expect(response.json()).rejects.toMatchObject({ name: 'AccountChangedError' })
    const count = nativeFetch.mock.calls.length
    await expect(browserWindow.fetch('/api/agent/save', { method: 'POST', headers: { Authorization: 'Bearer token-a' }, body: 'private-a' })).rejects.toMatchObject({ name: 'AccountChangedError' })
    expect(nativeFetch.mock.calls.length).toBe(count)
  })

  it('does not attach account tokens to a foreign origin or a neighboring API prefix', async () => {
    const { installWebShim } = await import('../../../../web/src/webShim')
    await installWebShim()
    nativeFetch.mockClear()
    await browserWindow.fetch('https://foreign.test/api/agent/example')
    await browserWindow.fetch('/api-other/example')
    expect(nativeFetch.mock.calls[0][1]).toBeUndefined()
    expect(nativeFetch.mock.calls[1][1]).toBeUndefined()
  })

  it('keeps the UI session and avoids redirects when remote logout fails', async () => {
    const { installWebShim, getToken } = await import('../../../../web/src/webShim')
    await installWebShim()
    nativeFetch.mockResolvedValueOnce(json({}, 503))
    await expect(browserWindow.tangu.forsionLogout()).rejects.toThrow('session was retained')
    expect(getToken()).toBe('token-a')
    expect(browserLocation.replace).not.toHaveBeenCalled()
    await browserWindow.tangu.forsionLogout()
    expect(getToken()).toBe('')
    expect(browserLocation.replace).toHaveBeenCalledWith(expect.stringContaining('/auth?redirect='))
    expect(nativeFetch.mock.calls.at(-1)?.[0]).toBe('https://forsion.test/api/auth/logout')
  })

  it('retires the previous tab state when another Web tab replaces the shared token', async () => {
    const { installWebShim, getToken } = await import('../../../../web/src/webShim')
    await installWebShim()
    const handler = browserWindow.addEventListener.mock.calls.find(([event]) => event === 'storage')?.[1]
    values.set('forsion_token', 'token-b')
    handler({ key: 'forsion_token', oldValue: 'token-a', newValue: 'token-b' })
    expect(getToken()).toBe('token-b')
    expect(cache.syncCloudAccountCache).toHaveBeenLastCalledWith('https://forsion.test/api', 'token-b')
    expect(browserLocation.reload).toHaveBeenCalledOnce()
  })
})
