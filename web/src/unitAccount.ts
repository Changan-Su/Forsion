import { AccountChangedError, AccountHttpError, createBrowserAccount } from './account'
import { contentStorageKey, setContentStorageScope } from '@lcl/engine/contentStorageScope'
import type { PluginAccount, PluginAccountStatus } from '../../desktop/frontend/src/amadeus/plugins/types'

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (n) => n.toString(16).padStart(2, '0')).join('')

export async function installUnitAccount(meta: {
  instanceId: string; account: { apiBase: string; loginPath: string }; inheritWebAccount?: boolean
}, base: URL) {
  // The official public entry keeps its login across tabs and browser restarts, as the old Web did;
  // other entries stay tab-scoped. The key is this Unit's own: /auth never reads or forwards it.
  const tokenKey = `unit:${meta.instanceId}:account`
  let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = sessionStorage
  if (meta.inheritWebAccount) {
    try {
      const shared = localStorage
      storage = {
        getItem: (key) => shared.getItem(key) ?? sessionStorage.getItem(key),
        // A full localStorage must not block sign-in: that login then stays in this tab only.
        setItem: (key, value) => {
          try { shared.setItem(key, value); sessionStorage.removeItem(key) }
          catch { shared.removeItem(key); sessionStorage.setItem(key, value) }
        },
        removeItem: (key) => { shared.removeItem(key); sessionStorage.removeItem(key) },
      }
      // Another tab can replace or clear the shared login, also while this one is still starting.
      window.addEventListener('storage', (event) => {
        if (event.key === tokenKey && event.oldValue !== event.newValue) location.reload()
      })
    } catch { /* storage denied: tab-scoped */ }
  }
  const account = createBrowserAccount({ apiBase: new URL(meta.account.apiBase, location.origin).href,
    storage, tokenKey,
    identityUrl: new URL('unit/account', base).href, allowedPaths: [new URL('unit', base).pathname] })
  const url = new URL(location.href)
  const stateKey = `unit:${meta.instanceId}:login-state`
  const callback = url.searchParams.get('token')
  if (callback) {
    const state = url.searchParams.get('account_state')
    url.searchParams.delete('token')
    url.searchParams.delete('account_state')
    history.replaceState(null, '', url.href)
    if (!state || state !== sessionStorage.getItem(stateKey)) {
      // Old Web logins can finish after its root was redirected to /web/.
      // Discard that uncorrelated credential; only verified existing storage
      // may be inherited below. Other Unit surfaces keep rejecting callbacks.
      if (!meta.inheritWebAccount || state) throw new Error('Unsolicited account callback')
    } else {
      sessionStorage.removeItem(stateKey)
      await account.adoptToken(callback)
    }
  }
  // Only the operator's official public entry may inherit the old same-origin Web
  // login. Verification goes through this Unit's authority before adopting it;
  // admin/device projections never inspect unrelated browser credentials.
  if (meta.inheritWebAccount && !account.getToken()) {
    let legacy = ''
    try { legacy = localStorage.getItem('forsion_token') || '' } catch { /* storage denied */ }
    if (legacy) {
      try { await account.adoptToken(legacy) }
      catch (error) {
        // Rejected credentials trigger the normal login flow. A transient
        // outage keeps both the old credential and this tab's account intact.
        if (!(error instanceof AccountHttpError) || ![401, 403].includes(error.status)) throw error
      }
    }
  }
  const status = await account.authStatus()
  if (account.getToken() && status.tokenValid === false) await account.clearSession()
  else if (account.getToken() && status.tokenValid !== true) throw new Error('Account service unavailable')
  const identity = account.getIdentity()
  const scope = JSON.stringify([location.origin, meta.instanceId, identity?.userId || `guest:${randomId()}`,
    identity?.tenantId, identity?.workspaceId])
  setContentStorageScope(`unit:${scope}`)
  // Preserve the old selected vault only after confirming this account can
  // still access it. Never copy unowned note/layout caches into a new scope.
  if (meta.inheritWebAccount && identity) {
    const oldKey = 'amadeus.cloudVaultId', newKey = contentStorageKey(oldKey)
    let selected: string | null = null
    try {
      if (localStorage.getItem('forsion_token') === account.getToken() && !localStorage.getItem(newKey)) selected = localStorage.getItem(oldKey)
    } catch { /* private mode */ }
    if (selected) {
      const owned = await account.request('/amadeus/vaults')
      if (!owned.ok) throw new AccountHttpError(owned.status, 'Could not verify the previous cloud vault')
      const vaults = (await owned.json()).vaults
      let accessible = Array.isArray(vaults) && vaults.some((v: { id?: unknown }) => v.id === selected)
      if (!accessible) {
        const shared = await account.request('/amadeus/shared-with-me')
        if (shared.ok) accessible = (await shared.json()).items?.some((v: { vaultId?: unknown }) => v.vaultId === selected) === true
      }
      if (accessible) { try { localStorage.setItem(newKey, selected) } catch { /* selection is optional */ } }
    }
  }
  const prepare = new Set<() => Promise<void>>()
  const listeners = new Set<(status: PluginAccountStatus) => void>()
  const emit = (status: PluginAccountStatus) => {
    for (const listener of listeners) { try { listener(status) } catch { /* isolate observers */ } }
  }
  account.subscribe(emit)
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })
  const login = async () => {
    try {
      for (const listener of prepare) await listener()
      const target = new URL(meta.account.loginPath, location.origin)
      target.searchParams.set('app', 'forsion-unit')
      target.searchParams.set('session', 'tab')
      const callbackUrl = new URL(location.href)
      const state = randomId()
      sessionStorage.setItem(stateKey, state)
      callbackUrl.searchParams.set('account_state', state)
      target.searchParams.set('redirect', callbackUrl.href)
      location.assign(target.href)
      return { ok: true }
    } catch (error) { emit(await account.authStatus()); throw error }
  }
  // A fresh document clears every view, plugin closure, subscription and captured
  // layout key. Failed logout does not advance the generation or reload the page.
  let generation = account.generation
  const bootGeneration = generation
  const request = async (path: string, init?: RequestInit) => {
    if (account.generation !== bootGeneration) throw new AccountChangedError()
    const response = await account.request(path, init)
    if (response.status === 401 && account.getToken()) {
      await response.body?.cancel()
      await account.clearSession({ prepare: false })
      throw new AccountChangedError()
    }
    return response
  }
  account.subscribe(() => {
    if (generation !== account.generation) { generation = account.generation; location.reload() }
  })
  const capability: PluginAccount = {
    status: account.authStatus, login, logout: account.logout, request,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { account, capability, scope, login,
    onAuthWillChange(callback: () => Promise<void>) {
      prepare.add(callback)
      const unsubscribe = account.beforeChange(callback)
      return () => { prepare.delete(callback); unsubscribe() }
    },
    request: (path: string, init?: RequestInit) => request(new URL(path, base).href, init),
  }
}
