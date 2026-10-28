import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installUnitAccount } from '../../../../web/src/unitAccount'
import { contentStorageKey } from '@lcl/engine/contentStorageScope'

const meta = { instanceId: 'unit-one', account: { apiBase: '/api', loginPath: '/auth' } }
const base = new URL('https://forsion.test/admin/')
const tokenKey = 'unit:unit-one:account'
const stateKey = 'unit:unit-one:login-state'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
let values: Map<string, string>
let shared: Map<string, string>
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
let browserLocation: { origin: string; href: string; assign: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> }
let pageEvents: ReturnType<typeof vi.fn>

beforeEach(() => {
  values = new Map()
  browserLocation = { origin: 'https://forsion.test', href: base.href, assign: vi.fn(), reload: vi.fn() }
  pageEvents = vi.fn()
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === '/admin/unit/account') {
      const id = new Headers(init?.headers).get('Authorization')?.replace('Bearer token-', '')
      if (id !== 'a' && id !== 'b') return json({}, 401)
      return json({ userId: id, username: `user-${id}`, role: id === 'a' ? 'admin' : 'user', tenantId: `personal:${id}`, workspaceId: `personal:${id}` })
    }
    return json({ ok: true })
  })
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  shared = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => shared.get(key) ?? null,
    setItem: (key: string, value: string) => { shared.set(key, value) },
    removeItem: (key: string) => { shared.delete(key) },
  })
  vi.stubGlobal('location', browserLocation)
  vi.stubGlobal('history', { replaceState: vi.fn((_state, _title, url) => { browserLocation.href = String(url) }) })
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('window', { addEventListener: pageEvents })
})
afterEach(() => vi.unstubAllGlobals())

describe('Unit visitor Account adapter', () => {
  it('inherits an existing Web login only for the configured official entry, after Unit verification', async () => {
    shared.set('forsion_token', 'token-b')
    shared.set('old-note-cache', 'keep')
    await installUnitAccount(meta, base)
    expect(fetcher).not.toHaveBeenCalled()
    const inherited = await installUnitAccount({ ...meta, inheritWebAccount: true }, base)
    expect(inherited.account.getIdentity()?.userId).toBe('b')
    expect(shared.get(tokenKey)).toBe('token-b')
    expect(shared.get('old-note-cache')).toBe('keep')
    expect(shared.get('forsion_token')).toBe('token-b')
    expect(fetcher.mock.calls[0][0]).toBe('https://forsion.test/admin/unit/account')
  })

  it('keeps the entry account instead of replacing it with another old Web login', async () => {
    shared.set(tokenKey, 'token-a')
    shared.set('forsion_token', 'token-b')
    const inherited = await installUnitAccount({ ...meta, inheritWebAccount: true }, base)
    expect(inherited.account.getIdentity()?.userId).toBe('a')
    expect(shared.get(tokenKey)).toBe('token-a')
  })

  it('keeps the official entry signed in across tabs while other entries stay tab-scoped', async () => {
    const official = { ...meta, inheritWebAccount: true }
    await (await installUnitAccount(official, base)).login()
    const callback = new URL(new URL(browserLocation.assign.mock.calls[0][0]).searchParams.get('redirect')!)
    callback.searchParams.set('token', 'token-b')
    browserLocation.href = callback.href
    await installUnitAccount(official, base)
    expect(shared.get(tokenKey)).toBe('token-b')
    values.clear() // a new tab or a restarted browser starts with empty sessionStorage
    browserLocation.href = base.href
    expect((await installUnitAccount(official, base)).account.getIdentity()?.userId).toBe('b')
    expect((await installUnitAccount(meta, base)).account.getIdentity()).toBeNull()
  })

  it('reloads the official entry when another tab replaces or clears its login', async () => {
    shared.set(tokenKey, 'token-a')
    await installUnitAccount({ ...meta, inheritWebAccount: true }, base)
    const onStorage = pageEvents.mock.calls.find(([event]) => event === 'storage')?.[1]
    onStorage({ key: 'other', oldValue: null, newValue: 'x' })
    expect(browserLocation.reload).not.toHaveBeenCalled()
    onStorage({ key: tokenKey, oldValue: 'token-a', newValue: null })
    expect(browserLocation.reload).toHaveBeenCalledOnce()
    pageEvents.mockClear()
    await installUnitAccount(meta, base)
    expect(pageEvents.mock.calls.some(([event]) => event === 'storage')).toBe(false)
  })

  it('recovers through a reload when another tab changes the login while this one is still starting', async () => {
    shared.set(tokenKey, 'token-a')
    fetcher.mockResolvedValueOnce(json({}, 503))
    await expect(installUnitAccount({ ...meta, inheritWebAccount: true }, base)).rejects.toThrow()
    const onStorage = pageEvents.mock.calls.find(([event]) => event === 'storage')?.[1]
    onStorage({ key: tokenKey, oldValue: 'token-a', newValue: null })
    expect(browserLocation.reload).toHaveBeenCalledOnce()
  })

  it('still signs in, for this tab only, when localStorage is full', async () => {
    const official = { ...meta, inheritWebAccount: true }
    shared.set(tokenKey, 'token-a')
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => shared.get(key) ?? null,
      setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') },
      removeItem: (key: string) => { shared.delete(key) },
    })
    values.set(stateKey, 'once')
    browserLocation.href = base.href + '?token=token-b&account_state=once'
    expect((await installUnitAccount(official, base)).account.getIdentity()?.userId).toBe('b')
    expect(shared.has(tokenKey)).toBe(false)
    expect(values.get(tokenKey)).toBe('token-b')
    browserLocation.href = base.href
    expect((await installUnitAccount(official, base)).account.getIdentity()?.userId).toBe('b')
  })

  it.each(['owned', 'shared', 'unrelated'])('restores only a server-authorized old vault selection (%s)', async (kind) => {
    const legacy = shared
    for (const [k, v] of [['forsion_token', 'token-b'], ['amadeus.cloudVaultId', 'previous-vault'], ['amadeus_tree_snap', 'private old cache']]) legacy.set(k, v)
    const authority = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/amadeus/vaults') return json({ vaults: kind === 'owned' ? [{ id: 'previous-vault' }] : [] })
      if (path === '/api/amadeus/shared-with-me') return json({ items: kind === 'shared' ? [{ vaultId: 'previous-vault' }] : [] })
      return authority(input, init)
    })
    await installUnitAccount({ ...meta, inheritWebAccount: true }, base)
    expect(legacy.get(contentStorageKey('amadeus.cloudVaultId'))).toBe(kind === 'unrelated' ? undefined : 'previous-vault')
    expect(legacy.get(contentStorageKey('amadeus_tree_snap'))).toBeUndefined()
    expect(legacy.get('amadeus_tree_snap')).toBe('private old cache')
  })

  it('does not adopt a rejected old credential or overwrite its storage', async () => {
    shared.set('forsion_token', 'invalid-old-token')
    const inherited = await installUnitAccount({ ...meta, inheritWebAccount: true }, base)
    expect(inherited.account.getIdentity()).toBeNull()
    expect(shared.has(tokenKey)).toBe(false)
    expect(shared.get('forsion_token')).toBe('invalid-old-token')
  })

  it('preserves credentials and surfaces temporary authority failures during migration', async () => {
    shared.set('forsion_token', 'token-b')
    fetcher.mockResolvedValueOnce(json({}, 503))
    await expect(installUnitAccount({ ...meta, inheritWebAccount: true }, base)).rejects.toMatchObject({ status: 503 })
    expect(shared.has(tokenKey)).toBe(false)
  })

  it('retries an interrupted vault-pointer migration with the already adopted tab identity', async () => {
    const legacy = shared
    legacy.set('forsion_token', 'token-b')
    legacy.set('amadeus.cloudVaultId', 'previous-vault')
    const authority = fetcher.getMockImplementation()!
    let available = false
    fetcher.mockImplementation(async (input, init) => new URL(String(input)).pathname === '/api/amadeus/vaults'
      ? json({ vaults: [{ id: 'previous-vault' }] }, available ? 200 : 503) : authority(input, init))
    await expect(installUnitAccount({ ...meta, inheritWebAccount: true }, base)).rejects.toMatchObject({ status: 503 })
    expect(shared.get(tokenKey)).toBe('token-b')
    available = true
    await installUnitAccount({ ...meta, inheritWebAccount: true }, base)
    expect(legacy.get(contentStorageKey('amadeus.cloudVaultId'))).toBe('previous-vault')
  })

  it('discards an old uncorrelated URL callback and inherits only the independently verified stored user', async () => {
    shared.set('forsion_token', 'token-a')
    browserLocation.href = base.href + '?token=token-b'
    const inherited = await installUnitAccount({ ...meta, inheritWebAccount: true }, base)
    expect(inherited.account.getIdentity()?.userId).toBe('a')
    expect(browserLocation.href).toBe(base.href)
    expect(fetcher.mock.calls.some(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer token-b')).toBe(false)
  })
  it('uses a one-time login state and the existing auth page in a tab session', async () => {
    const unit = await installUnitAccount(meta, base)
    expect(fetcher).not.toHaveBeenCalled()
    await unit.login()
    const auth = new URL(browserLocation.assign.mock.calls[0][0])
    expect(auth.pathname).toBe('/auth')
    expect(auth.searchParams.get('session')).toBe('tab')
    expect(auth.searchParams.get('app')).toBe('forsion-unit')
    const callback = new URL(auth.searchParams.get('redirect')!)
    expect(callback.searchParams.get('account_state')).toBe(values.get(stateKey))
    expect(values.get(stateKey)).toBeTruthy()
    callback.searchParams.set('token', 'token-b')
    browserLocation.href = callback.href
    const signedIn = await installUnitAccount(meta, base)
    expect(signedIn.account.getIdentity()?.userId).toBe('b')
    expect(values.get(tokenKey)).toBe('token-b')
    expect(values.has(stateKey)).toBe(false)
    expect(browserLocation.href).toBe(base.href)
    expect(history.replaceState).toHaveBeenCalled()
  })

  it.each(['unknown-state', null])('rejects an unsolicited callback (%s), strips credentials, and retains the existing account', async (state) => {
    values.set(tokenKey, 'token-a')
    values.set(stateKey, 'expected-state')
    const callback = new URL(base.href)
    callback.searchParams.set('token', 'token-b')
    callback.searchParams.set('ui', 'mobile')
    if (state) callback.searchParams.set('account_state', state)
    browserLocation.href = callback.href
    await expect(installUnitAccount(meta, base)).rejects.toThrow('Unsolicited account callback')
    expect(values.get(tokenKey)).toBe('token-a')
    expect(fetcher).not.toHaveBeenCalled()
    expect(browserLocation.href).toBe(base.href + '?ui=mobile')
  })

  it('does not reuse a consumed login state', async () => {
    values.set(stateKey, 'once')
    browserLocation.href = base.href + '?token=token-a&account_state=once'
    await installUnitAccount(meta, base)
    fetcher.mockClear()
    browserLocation.href = base.href + '?token=token-b&account_state=once'
    await expect(installUnitAccount(meta, base)).rejects.toThrow('Unsolicited account callback')
    expect(values.get(tokenKey)).toBe('token-a')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('derives separate content scopes from verified users on the same Unit', async () => {
    values.set(tokenKey, 'token-a')
    const a = await installUnitAccount(meta, base)
    const aLayout = contentStorageKey('tangu2_layout_v4')
    values.set(tokenKey, 'token-b')
    const b = await installUnitAccount(meta, base)
    const bLayout = contentStorageKey('tangu2_layout_v4')
    expect(JSON.parse(a.scope)).toEqual(['https://forsion.test', 'unit-one', 'a', 'personal:a', 'personal:a'])
    expect(JSON.parse(b.scope)).toEqual(['https://forsion.test', 'unit-one', 'b', 'personal:b', 'personal:b'])
    expect(aLayout).not.toBe(bLayout)
    expect(aLayout).not.toContain('token-a')
    expect(bLayout).not.toContain('token-b')
  })

  it('rejects calls from the old page generation after logout before sending another request', async () => {
    values.set(tokenKey, 'token-a')
    const unit = await installUnitAccount(meta, base)
    await unit.capability.logout()
    expect(values.has(tokenKey)).toBe(false)
    expect(browserLocation.reload).toHaveBeenCalledOnce()
    const count = fetcher.mock.calls.length
    await expect(unit.capability.request('/admin/private')).rejects.toMatchObject({ name: 'AccountChangedError' })
    await expect(unit.request('unit/config')).rejects.toMatchObject({ name: 'AccountChangedError' })
    expect(fetcher.mock.calls.length).toBe(count)
  })

  it('clears a rejected session and reloads without attempting a flush with revoked credentials', async () => {
    values.set(tokenKey, 'token-a')
    const unit = await installUnitAccount(meta, base)
    const prepare = vi.fn(async () => { throw new Error('Cannot save with revoked credentials') })
    const changed = vi.fn()
    unit.onAuthWillChange(prepare)
    unit.capability.subscribe(changed)
    fetcher.mockResolvedValueOnce(json({}, 401))
    await expect(unit.capability.request('/admin/private')).rejects.toMatchObject({ name: 'AccountChangedError' })
    expect(prepare).not.toHaveBeenCalled()
    expect(values.has(tokenKey)).toBe(false)
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ loggedIn: false }))
    expect(browserLocation.reload).toHaveBeenCalledOnce()
  })

  it('releases account-change listeners when preparing login fails', async () => {
    values.set(tokenKey, 'token-a')
    const unit = await installUnitAccount(meta, base)
    const changed = vi.fn()
    unit.capability.subscribe(changed)
    unit.onAuthWillChange(async () => { throw new Error('Save failed') })
    await expect(unit.login()).rejects.toThrow('Save failed')
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ loggedIn: true, userId: 'a' }))
    expect(browserLocation.assign).not.toHaveBeenCalled()
    expect(values.get(tokenKey)).toBe('token-a')
  })

  it('reloads a restored page from the back-forward cache before retaining its prior visitor state', async () => {
    await installUnitAccount(meta, base)
    const onPageShow = pageEvents.mock.calls.find(([event]) => event === 'pageshow')?.[1]
    onPageShow({ persisted: false })
    expect(browserLocation.reload).not.toHaveBeenCalled()
    onPageShow({ persisted: true })
    expect(browserLocation.reload).toHaveBeenCalledOnce()
  })
})
