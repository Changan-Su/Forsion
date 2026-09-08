import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installUnitAccount } from '../../../../web/src/unitAccount'
import { contentStorageKey } from '@lcl/engine/contentStorageScope'

const meta = { instanceId: 'unit-one', account: { apiBase: '/api', loginPath: '/auth' } }
const base = new URL('https://forsion.test/admin/')
const tokenKey = 'unit:unit-one:account'
const stateKey = 'unit:unit-one:login-state'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
let values: Map<string, string>
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
  vi.stubGlobal('location', browserLocation)
  vi.stubGlobal('history', { replaceState: vi.fn((_state, _title, url) => { browserLocation.href = String(url) }) })
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('window', { addEventListener: pageEvents })
})
afterEach(() => vi.unstubAllGlobals())

describe('Unit visitor Account adapter', () => {
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
