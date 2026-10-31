import { describe, expect, it, vi } from 'vitest'
import { accountApiPath, createDesktopAccount, desktopAccount } from './desktopAccount'

type Reply = { status: number; json?: unknown; error?: string }
const switchStart = vi.hoisted(() => ({ cb: (() => {}) as () => void }))
vi.mock('../../services/accountTransition', () => ({ onAccountWillChange: (cb: () => void) => { switchStart.cb = cb; return () => {} } }))

function bridge(reply: Reply | Promise<Reply> = { status: 200, json: { ok: true } }) {
  let changed: (() => void) | undefined
  const cloudFetch = vi.fn(async () => reply)
  const t = {
    cloudFetch,
    authStatus: vi.fn(async () => ({ loggedIn: true, cloudUrl: 'https://cloud.example', username: 'ada', accountId: 'local-record', tokenSource: null })),
    forsionLogin: vi.fn(async () => ({ ok: true, cloudUrl: '' })),
    forsionLogout: vi.fn(async () => ({ ok: true })),
    onAuthChanged: vi.fn((cb: () => void) => { changed = cb; return () => {} }),
  }
  return { t: t as unknown as NonNullable<typeof window.tangu>, cloudFetch, authChanged: () => changed?.() }
}

describe('request', () => {
  it('sends paths relative to /api and always asks for the long timeout, so a 20s long poll survives', async () => {
    const { t, cloudFetch } = bridge()
    await createDesktopAccount(t).request('/units/u1/proxy/x/events?since=4&wait=20')
    expect(cloudFetch).toHaveBeenCalledWith({ path: '/units/u1/proxy/x/events?since=4&wait=20', method: 'GET', timeoutMs: 120_000 })
  })

  it('parses a JSON string body exactly once, otherwise the main process would encode it twice', async () => {
    const { t, cloudFetch } = bridge()
    await createDesktopAccount(t).request('/x', { method: 'post', body: JSON.stringify({ a: 1 }) })
    expect(cloudFetch).toHaveBeenCalledWith({ path: '/x', method: 'POST', timeoutMs: 120_000, body: { a: 1 } })
  })

  it.each([['FormData', new FormData()], ['Blob', new Blob(['x'])], ['not JSON', 'plain text']])('refuses a %s body instead of dropping it', async (_name, body) => {
    const { t, cloudFetch } = bridge()
    await expect(createDesktopAccount(t).request('/x', { method: 'POST', body: body as BodyInit })).rejects.toThrow(/JSON bodies only/)
    expect(cloudFetch).not.toHaveBeenCalled()
  })

  it('answers with a Response the plugin reads the same way as on the other hosts', async () => {
    const { t } = bridge({ status: 200, json: { entitlements: ['business'] } })
    const res = await createDesktopAccount(t).request('/org/entitlements')
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual({ entitlements: ['business'] })
  })

  it('keeps server errors as responses', async () => {
    const { t } = bridge({ status: 403, json: { error: 'org_readonly' } })
    const res = await createDesktopAccount(t).request('/x')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'org_readonly' })
  })

  it('reports signed out as a 401 response, like Android', async () => {
    const { t } = bridge({ status: 401, error: 'not_signed_in' })
    const res = await createDesktopAccount(t).request('/x')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'not_signed_in' })
  })

  it('rejects like fetch when the request never left', async () => {
    const { t } = bridge({ status: 0, error: 'network down' })
    await expect(createDesktopAccount(t).request('/x')).rejects.toThrow(new TypeError('network down'))
  })

  it('handles a reply with no body', async () => {
    const { t } = bridge({ status: 204, json: null })
    const res = await createDesktopAccount(t).request('/x', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('fails the parse, not the request, on a non-JSON reply', async () => {
    const { t } = bridge({ status: 200, json: null })
    const res = await createDesktopAccount(t).request('/x')
    await expect(res.json()).rejects.toThrow()
  })

  it('rejects at once on abort while the main process is still working', async () => {
    const { t } = bridge(new Promise<Reply>(() => {}))
    const ctl = new AbortController()
    const pending = createDesktopAccount(t).request('/x', { signal: ctl.signal })
    await Promise.resolve()
    ctl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not start when already aborted', async () => {
    const { t, cloudFetch } = bridge()
    await expect(createDesktopAccount(t).request('/x', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(cloudFetch).not.toHaveBeenCalled()
  })
})

describe('account change', () => {
  it('cancels requests in flight and revokes bodies already handed out', async () => {
    const { t, authChanged } = bridge()
    const held = bridge(new Promise<Reply>(() => {}))
    const account = createDesktopAccount(t)
    const res = await account.request('/x')
    const otherAccount = createDesktopAccount(held.t)
    const inflight = otherAccount.request('/x')
    await Promise.resolve()
    held.authChanged()
    await expect(inflight).rejects.toMatchObject({ name: 'AbortError' })
    authChanged()
    await expect(res.json()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('tells subscribers signed out first, then the fresh status', async () => {
    const { t, authChanged } = bridge()
    const seen: unknown[] = []
    createDesktopAccount(t).subscribe((s) => seen.push(s.loggedIn))
    authChanged()
    await vi.waitFor(() => expect(seen).toEqual([false, true]))
  })

  it('isolates a throwing subscriber', async () => {
    const { t, authChanged } = bridge()
    const account = createDesktopAccount(t)
    const seen: boolean[] = []
    account.subscribe(() => { throw new Error('boom') })
    account.subscribe((s) => seen.push(s.loggedIn))
    authChanged()
    await vi.waitFor(() => expect(seen).toEqual([false, true]))
  })
})

describe('status', () => {
  it('gives the API base, as Android and Unit Web do', async () => {
    expect((await createDesktopAccount(bridge().t).status()).cloudUrl).toBe('https://cloud.example/api')
  })

  it('does not pass the local account record off as the server user id', async () => {
    const status = await createDesktopAccount(bridge().t).status()
    expect(status).toEqual({ loggedIn: true, cloudUrl: 'https://cloud.example/api', username: 'ada' })
  })
})

describe('accountApiPath', () => {
  it('accepts absolute URLs inside the account API only', () => {
    const cloud = 'https://cloud.example'
    expect(accountApiPath('https://cloud.example/api/org/me?x=1', cloud)).toBe('/org/me?x=1')
    expect(accountApiPath('https://other.example/api/org/me', cloud)).toBeNull()
    expect(accountApiPath('https://cloud.example/admin', cloud)).toBeNull()
    expect(accountApiPath('https://user:pw@cloud.example/api/x', cloud)).toBeNull()
    expect(accountApiPath('//other.example/api/x', cloud)).toBeNull()
    expect(accountApiPath('not a url', cloud)).toBeNull()
  })

  it('refuses an absolute URL elsewhere before sending anything', async () => {
    const { t, cloudFetch } = bridge()
    await expect(createDesktopAccount(t).request('https://other.example/api/x')).rejects.toThrow(/inside the account API/)
    expect(cloudFetch).not.toHaveBeenCalled()
  })
})

describe('account switch', () => {
  it('revokes when the switch starts, not when it ends, and recovers afterwards', async () => {
    let answer!: (r: Reply) => void
    const { t, cloudFetch, authChanged } = bridge(new Promise<Reply>((r) => { answer = r }))
    const account = createDesktopAccount(t)
    const seen: boolean[] = []
    account.subscribe((s) => seen.push(s.loggedIn))
    const inFlight = account.request('/me')
    await vi.waitFor(() => expect(cloudFetch).toHaveBeenCalledOnce())
    switchStart.cb()
    await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen).toEqual([false])
    await expect(account.request('/me')).rejects.toMatchObject({ name: 'AbortError' })
    expect(cloudFetch).toHaveBeenCalledOnce()
    expect(await account.status()).toEqual({ loggedIn: false })
    answer({ status: 200, json: { ok: true } })
    authChanged()
    await vi.waitFor(() => expect(seen.at(-1)).toBe(true))
    expect((await account.status()).loggedIn).toBe(true)
    await expect(account.request('/me')).resolves.toBeInstanceOf(Response)
  })
})

describe('presence', () => {
  it('is absent without the Extend channels', () => {
    const { t } = bridge()
    expect(desktopAccount(undefined)).toBeUndefined()
    expect(desktopAccount({ ...t, cloudFetch: undefined } as never)).toBeUndefined()
    expect(desktopAccount({ ...t, authStatus: undefined } as never)).toBeUndefined()
  })

  it('leaves hosts that bring their own account alone', () => {
    const { t } = bridge()
    expect(desktopAccount({ ...t, account: {} } as never)).toBeUndefined()
    expect(desktopAccount({ ...t, mobile: true } as never)).toBeUndefined()
  })

  it('shares one adapter across plugins in a window', () => {
    const { t } = bridge()
    expect(desktopAccount(t)).toBe(desktopAccount(t))
  })
})
