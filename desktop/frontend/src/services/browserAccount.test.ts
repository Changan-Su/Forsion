import { describe, expect, it, vi } from 'vitest'
import { AccountChangedError, AccountHttpError, createBrowserAccount } from '../../../../web/src/account'

function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const user = (id: string) => ({ id, username: `user-${id}`, role: id === 'a' ? 'admin' : 'user', nickname: `Name ${id}`, avatar: null })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function fixture(options: Partial<Parameters<typeof createBrowserAccount>[0]> = {}) {
  const storage = memoryStorage()
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/auth/me')) {
      const id = new Headers(init?.headers).get('Authorization')?.replace('Bearer token-', '')
      return id === 'a' || id === 'b' ? json(user(id)) : json({}, 401)
    }
    if (url.pathname.endsWith('/auth/logout')) return json({ ok: true })
    return json({ token: 'token-b' })
  })
  const account = createBrowserAccount({ apiBase: 'https://forsion.test/api', storage, fetch: fetcher, ...options })
  return { account, storage, fetcher }
}

describe('shared browser Account', () => {
  it('uses existing login and verified identity endpoints with the desktop status contract', async () => {
    const { account, fetcher, storage } = fixture()
    const changed = vi.fn()
    account.subscribe(changed)
    const status = await account.login('user-b', 'test-password')
    expect(fetcher.mock.calls[0][0]).toBe('https://forsion.test/api/auth/login')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ username: 'user-b', password: 'test-password' })
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
    expect(fetcher.mock.calls[1][0]).toBe('https://forsion.test/api/auth/me')
    expect(status).toMatchObject({ loggedIn: true, tokenValid: true, tokenSource: 'tangu-login', userId: 'b', username: 'user-b', nickname: 'Name b', accountId: 'https://forsion.test/api::b' })
    expect(storage.getItem('forsion_token')).toBe('token-b')
    expect(changed).toHaveBeenCalledWith(status)
  })

  it('does not accept a candidate token or change the old identity before remote verification', async () => {
    const { account, storage } = fixture()
    await account.adoptToken('token-a')
    const prepare = vi.fn()
    account.beforeChange(prepare)
    await expect(account.adoptToken('forged-jwt-with-admin-claims')).rejects.toBeInstanceOf(AccountHttpError)
    expect(storage.getItem('forsion_token')).toBe('token-a')
    expect(account.getIdentity()?.userId).toBe('a')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('awaits before-change saves under the old identity and invalidates only when the switch commits', async () => {
    const { account, fetcher } = fixture()
    await account.adoptToken('token-a')
    const saving = deferred<void>()
    const entered = deferred<void>()
    account.beforeChange(async () => { entered.resolve(); await saving.promise })
    const switching = account.adoptToken('token-b')
    await entered.promise
    expect(account.getToken()).toBe('token-a')
    const response = await account.request('/private/save', { method: 'POST', body: 'old-account-work' })
    expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get('Authorization')).toBe('Bearer token-a')
    saving.resolve()
    await switching
    expect(account.getToken()).toBe('token-b')
    await expect(response.text()).rejects.toBeInstanceOf(AccountChangedError)
  })

  it('aborts old requests and rejects late responses even if the transport ignores abort', async () => {
    const { account, fetcher } = fixture()
    await account.adoptToken('token-a')
    const late = deferred<Response>()
    fetcher.mockImplementationOnce(() => late.promise)
    const pending = account.request('/private/a')
    const signal = fetcher.mock.calls.at(-1)?.[1]?.signal
    await account.adoptToken('token-b')
    expect(signal?.aborted).toBe(true)
    late.resolve(json({ secret: 'account-a' }))
    await expect(pending).rejects.toBeInstanceOf(AccountChangedError)
  })

  it('guards delayed body consumption and clones, including a body that finishes after switching', async () => {
    const { account, fetcher } = fixture()
    await account.adoptToken('token-a')
    const contents = deferred<Uint8Array>()
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({
      async pull(controller) { controller.enqueue(await contents.promise); controller.close() },
    })))
    const response = await account.request('/private/a')
    const clone = response.clone()
    const pending = response.json()
    await account.adoptToken('token-b')
    contents.resolve(new TextEncoder().encode('{"secret":"account-a"}'))
    await expect(pending).rejects.toBeInstanceOf(AccountChangedError)
    await expect(clone.json()).rejects.toBeInstanceOf(AccountChangedError)
  })

  it.each(['offline', 'server error'])('retains the session and reports failure when logout has %s', async (mode) => {
    const { account, fetcher } = fixture()
    await account.adoptToken('token-a')
    const changed = vi.fn()
    account.subscribe(changed)
    if (mode === 'offline') fetcher.mockRejectedValueOnce(new TypeError('Offline'))
    else fetcher.mockResolvedValueOnce(json({}, 503))
    await expect(account.logout()).rejects.toThrow()
    expect(account.getToken()).toBe('token-a')
    expect(account.getIdentity()?.userId).toBe('a')
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ loggedIn: true, userId: 'a' }))
  })

  it.each([200, 401])('clears the session only after logout confirms success or existing invalidation (%i)', async (status) => {
    const { account, fetcher, storage } = fixture()
    await account.adoptToken('token-a')
    const ending = deferred<Response>()
    const entered = deferred<void>()
    fetcher.mockImplementationOnce(async () => { entered.resolve(); return ending.promise })
    const logout = account.logout()
    await entered.promise
    expect(account.getToken()).toBe('token-a')
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://forsion.test/api/auth/logout')
    expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe('POST')
    ending.resolve(json({ ok: true }, status))
    await logout
    expect(storage.getItem('forsion_token')).toBeNull()
    expect(account.getIdentity()).toBeNull()
    expect(await account.authStatus()).toMatchObject({ loggedIn: false, username: null, tokenSource: null })
  })

  it('keeps different visitor stores and keys isolated while detecting external shared-Web changes', async () => {
    const shared = memoryStorage()
    const a = fixture({ storage: shared, tokenKey: 'unit:visitor-a' })
    const b = fixture({ storage: shared, tokenKey: 'unit:visitor-b' })
    await a.account.adoptToken('token-a')
    await b.account.adoptToken('token-b')
    expect(a.account.getIdentity()?.userId).toBe('a')
    expect(b.account.getIdentity()?.userId).toBe('b')
    const response = await a.account.request('/private/data')
    shared.setItem('unit:visitor-a', 'token-b')
    await expect(response.json()).rejects.toBeInstanceOf(AccountChangedError)
    expect(a.account.getIdentity()).toBeNull()
    expect(b.account.getIdentity()?.userId).toBe('b')
  })

  it('does not let a delayed 401 cleanup discard a newly installed account', async () => {
    const { account } = fixture()
    await account.adoptToken('token-a')
    const switching = account.adoptToken('token-b')
    const cleanup = account.clearSession('token-a')
    await Promise.all([switching, cleanup])
    expect(account.getToken()).toBe('token-b')
  })

  it('does not revoke a newer account for a queued logout of the previous account', async () => {
    const { account } = fixture()
    await account.adoptToken('token-a')
    const switching = account.adoptToken('token-b')
    const logout = account.logout()
    await switching
    await expect(logout).rejects.toBeInstanceOf(AccountChangedError)
    expect(account.getToken()).toBe('token-b')
    expect(() => account.request('/private/save', { headers: { Authorization: 'Bearer token-a' }, body: 'old private changes', method: 'POST' })).toThrow(AccountChangedError)
  })

  it('requires the logout acknowledgement before discarding the local session', async () => {
    const { account, fetcher } = fixture()
    await account.adoptToken('token-a')
    fetcher.mockResolvedValueOnce(json({ ok: false }))
    await expect(account.logout()).rejects.toThrow('not acknowledged')
    expect(account.getToken()).toBe('token-a')
  })

  it('never sends credentials outside its configured API or explicit host namespace', async () => {
    const { account, fetcher } = fixture({ allowedPaths: ['/admin/unit'] })
    await account.adoptToken('token-a')
    fetcher.mockClear()
    for (const path of ['https://evil.test/api/x', '//evil.test/api/x', 'https://forsion.test/api-other/x', '../private', '/%2e%2e/private', 'https://forsion.test/admin/unit-other/x', 'https://forsion.test/admin/unit/../../private', 'https://token@forsion.test/api/x', '/x%2f..%2f..%2fprivate']) {
      expect(() => account.request(path)).toThrow('Request must stay inside')
    }
    expect(fetcher).not.toHaveBeenCalled()
    await (await account.request('/admin/unit/config')).json()
    expect(fetcher.mock.calls[0][0]).toBe('https://forsion.test/admin/unit/config')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer token-a')
  })

  it('preserves encoded cloud note paths inside the API, in both paths and query parameters', async () => {
    const { account, fetcher } = fixture()
    await account.adoptToken('token-a')
    await (await account.request('/amadeus/files/Folder%2FPage.md')).json()
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://forsion.test/api/amadeus/files/Folder%2FPage.md')
    await (await account.request('/amadeus/file?path=Folder%2FPage.md')).json()
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://forsion.test/api/amadeus/file?path=Folder%2FPage.md')
  })

  it('forgets an already rejected session without flushing writes with an invalid token', async () => {
    const { account } = fixture()
    await account.adoptToken('token-a')
    const prepare = vi.fn(async () => { throw new Error('Cannot save with a revoked token') })
    const changed = vi.fn()
    account.beforeChange(prepare)
    account.subscribe(changed)
    const previousGeneration = account.generation
    await account.clearSession({ prepare: false })
    expect(prepare).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ loggedIn: false }))
    expect(account.generation).toBeGreaterThan(previousGeneration)
    expect(account.getToken()).toBe('')
  })

  it('accepts the host identity resolver without opening the rest of that origin', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ userId: 'b', username: 'user-b', role: 'user', tenantId: 'personal:b', workspaceId: 'personal:b' }))
    const account = createBrowserAccount({ apiBase: 'https://forsion.test/api', identityUrl: '/admin/unit/account', fetch: fetcher })
    expect(await account.adoptToken('token-b')).toMatchObject({ userId: 'b', tenantId: 'personal:b', workspaceId: 'personal:b' })
    expect(fetcher.mock.calls[0][0]).toBe('https://forsion.test/admin/unit/account')
    expect(() => account.request('https://forsion.test/admin/anything')).toThrow()
    expect(() => createBrowserAccount({ apiBase: 'https://forsion.test/api', identityUrl: 'https://elsewhere.test/me' })).toThrow('Identity endpoint')
  })

  it('retains the current account if pre-switch saving fails and does not revoke it', async () => {
    const { account, fetcher } = fixture()
    await account.adoptToken('token-a')
    account.beforeChange(async () => { throw new Error('Save failed') })
    fetcher.mockClear()
    await expect(account.logout()).rejects.toThrow('Save failed')
    expect(fetcher).not.toHaveBeenCalled()
    expect(account.getToken()).toBe('token-a')
  })

  it('treats offline status as unknown and never substitutes a late old-account status', async () => {
    const { account, fetcher } = fixture()
    await account.adoptToken('token-a')
    fetcher.mockRejectedValueOnce(new TypeError('Offline'))
    expect(await account.authStatus()).toMatchObject({ loggedIn: true, tokenValid: null })
    const late = deferred<Response>()
    fetcher.mockImplementationOnce(() => late.promise)
    const status = account.authStatus()
    await account.adoptToken('token-b')
    late.resolve(json(user('a')))
    await expect(status).rejects.toBeInstanceOf(AccountChangedError)
    expect(account.getIdentity()?.userId).toBe('b')
  })
})
