// @vitest-environment happy-dom
// `null` must never turn into `false`: that is the difference between "we could not tell" and "you do not have this".
// The entitlement is read from the plugin's own manifest, not from anything the plugin passes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readEntitlement } from './entitlement'
import { usePluginStore } from './pluginStore'
import type { PluginContext } from './types'

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

describe('readEntitlement', () => {
  it('is true when the account holds it and false only when the server says it does not', async () => {
    expect(await readEntitlement(async () => json({ entitlements: ['business'] }), 'business')).toEqual({ granted: true })
    expect(await readEntitlement(async () => json({ entitlements: [] }), 'business')).toEqual({ granted: false })
    expect(await readEntitlement(async () => json({ entitlements: ['other'] }), 'business')).toEqual({ granted: false })
  })

  it.each<[string, () => Promise<Response>]>([
    ['the network fails', async () => { throw new TypeError('offline') }],
    ['the server errors', async () => json({ error: 'boom' }, 500)],
    ['signed out', async () => json({ error: 'not_signed_in' }, 401)],
    ['an older server has no such route', async () => json({ error: 'not found' }, 404)],
    ['the reply is not JSON', async () => new Response('<html>')],
    ['the reply has no body', async () => new Response(null)],
    ['the shape is wrong', async () => json({ entitlements: 'business' })],
    ['the reply is null', async () => json(null)],
  ])('is unknown, not false, when %s', async (_name, request) => {
    expect(await readEntitlement(request, 'business')).toEqual({ granted: null })
  })

  it('needs no request when nothing is declared', async () => {
    const request = vi.fn(async () => json({}))
    expect(await readEntitlement(request, undefined)).toEqual({ granted: true })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('ctx.account on the desktop bridge', () => {
  let ctx: PluginContext
  const cloudFetch = vi.fn(async () => ({ status: 200, json: { entitlements: ['business'] } }))
  const load = (entitlement?: string): void => {
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], readiness: [] })
    usePluginStore.getState().init([{ id: 'probe', name: 'Probe', version: '1', builtin: false, entitlement, setup(c) { ctx = c } }])
  }
  beforeEach(() => {
    window.tangu = {
      cloudFetch,
      authStatus: async () => ({ loggedIn: true, cloudUrl: 'https://cloud.example', username: 'ada', tokenSource: null }),
      forsionLogin: async () => ({ ok: true, cloudUrl: '' }),
      forsionLogout: async () => ({ ok: true }),
      onAuthChanged: () => () => {},
    } as unknown as typeof window.tangu
  })
  afterEach(() => { usePluginStore.getState().disable('probe'); delete window.tangu; localStorage.clear(); vi.clearAllMocks() })

  it('reaches plugins, and reads the declared entitlement over the scoped request', async () => {
    load('business')
    expect(ctx.account).toBeDefined()
    expect(await ctx.account!.entitlements!()).toEqual({ granted: true })
    expect(cloudFetch).toHaveBeenCalledWith(expect.objectContaining({ path: '/org/entitlements', method: 'GET' }))
  })

  it('compares against the manifest, not whichever entitlement the account happens to have', async () => {
    load('another')
    expect(await ctx.account!.entitlements!()).toEqual({ granted: false })
  })

  it('stops working when the plugin is disabled', async () => {
    load('business')
    const account = ctx.account!
    usePluginStore.getState().disable('probe')
    cloudFetch.mockClear()
    expect(await account.entitlements!()).toEqual({ granted: null })
    expect(cloudFetch).not.toHaveBeenCalled()
  })

  it('is absent when the Extend channels are not there', () => {
    window.tangu = {} as typeof window.tangu
    load('business')
    expect(ctx.account).toBeUndefined()
  })
})
