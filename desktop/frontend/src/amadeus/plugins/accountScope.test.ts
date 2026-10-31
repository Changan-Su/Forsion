// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { usePluginStore } from './pluginStore'
import type { PluginAccount, PluginContext } from './types'

let ctx: PluginContext
const host: PluginAccount = {
  status: async () => ({ loggedIn: true }), login: vi.fn(async () => {}), logout: vi.fn(async () => {}),
  request: vi.fn(async () => new Response('private account bytes')),
  saveDownload: vi.fn(async () => ({ ok: true })), subscribe: vi.fn(() => vi.fn()),
}
afterEach(() => { usePluginStore.getState().disable('account-probe'); delete window.tangu; localStorage.clear(); vi.clearAllMocks() })
it('plugin teardown revokes account actions, old body reads and registered subscriptions', async () => {
  window.tangu = { account: host } as typeof window.tangu
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], readiness: [] })
  usePluginStore.getState().init([{ id: 'account-probe', name: 'Account probe', version: '1', builtin: false, setup(c) { ctx = c } }])
  const account = ctx!.account!
  const response = await account.request('/files')
  const clone = response.clone()
  await response.text()
  account.subscribe(() => {})
  const off = vi.mocked(host.subscribe).mock.results[0].value
  usePluginStore.getState().disable('account-probe')
  expect(off).toHaveBeenCalledOnce()
  await expect(clone.text()).rejects.toThrow(/plugin disabled/)
  await expect(account.request('/files')).rejects.toThrow(/plugin disabled/)
  await expect(account.login()).rejects.toThrow(/plugin disabled/)
  await expect(account.logout()).rejects.toThrow(/plugin disabled/)
  expect(await account.saveDownload!(new Blob(['x']), 'x')).toEqual({ ok: false, error: 'plugin disabled' })
  expect(host.saveDownload).not.toHaveBeenCalled()
  expect(await account.status()).toEqual({ loggedIn: false })
})
