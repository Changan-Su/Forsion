/** Host-owned account transport. Never forwards credentials to caller-selected hosts or follows redirects. */
import { resolveCloudApiUrl } from './cloudFetch'
import { leaseAccountResponse } from '../../desktop/frontend/src/amadeus/plugins/accountResponse'
import type { PluginAccount, PluginAccountStatus } from '../../desktop/frontend/src/amadeus/plugins/types'

export function accountApiUrl(base: string, path: string): string | null {
  if (/^https?:\/\//i.test(path)) {
    try {
      const root = new URL(base), target = new URL(path)
      if (root.origin !== target.origin || !target.pathname.startsWith('/api/') || target.username || target.password) return null
      return target.toString()
    } catch { return null }
  }
  return resolveCloudApiUrl(base, path)
}

export function createMobileAccount(deps: {
  cloudApiBase: () => string
  token: () => string
  status: () => Promise<Record<string, unknown>>
  login: () => Promise<unknown>
  logout: () => Promise<unknown>
  onAuthChanged: (cb: () => void) => () => void
  fetch: (input: string, init: RequestInit) => Promise<Response>
  saveDownload: (blob: Blob, name: string) => Promise<{ ok: boolean; error?: string }>
}): PluginAccount {
  let epoch = 0
  const pending = new Set<AbortController>()
  const listeners = new Set<(s: PluginAccountStatus) => void>()
  const status = async (): Promise<PluginAccountStatus> => {
    const generation = epoch
    const raw = await deps.status()
    if (generation !== epoch) return { loggedIn: false }
    return { loggedIn: raw.loggedIn === true, cloudUrl: deps.cloudApiBase(),
      ...(typeof raw.userId === 'string' || typeof raw.userId === 'number' ? { userId: String(raw.userId) } : {}),
      ...(typeof raw.username === 'string' ? { username: raw.username } : {}) }
  }
  deps.onAuthChanged(() => {
    const generation = ++epoch
    pending.forEach((ctl) => ctl.abort()); pending.clear()
    // Revoke rendered account data immediately; refresh only the current generation.
    listeners.forEach((cb) => { try { cb({ loggedIn: false }) } catch { /* one subscriber cannot block the rest */ } })
    void status().then((s) => { if (generation === epoch) listeners.forEach((cb) => { try { cb(s) } catch { /* isolated */ } }) }).catch(() => {})
  })
  return {
    status, login: deps.login, logout: deps.logout,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    async request(path, init = {}) {
      const url = accountApiUrl(deps.cloudApiBase(), path)
      if (!url) throw new Error('Account requests must stay inside the account API')
      const token = deps.token(), generation = epoch
      if (!token) return new Response('{"error":"not_signed_in"}', { status: 401, headers: { 'Content-Type': 'application/json' } })
      const ctl = new AbortController(), outer = init.signal
      const abort = () => ctl.abort()
      if (outer?.aborted) abort(); else outer?.addEventListener('abort', abort, { once: true })
      const headers = new Headers(init.headers)
      for (const name of ['Authorization', 'Cookie', 'Proxy-Authorization']) headers.delete(name)
      headers.set('Authorization', `Bearer ${token}`)
      pending.add(ctl)
      const cleanup = () => { pending.delete(ctl); outer?.removeEventListener('abort', abort) }
      const current = () => { if (ctl.signal.aborted || generation !== epoch || token !== deps.token()) throw new DOMException('Account changed', 'AbortError') }
      try {
        const response = await deps.fetch(url, { method: init.method || 'GET', body: init.body, headers, signal: ctl.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
        return leaseAccountResponse(response, current, cleanup, ctl.signal)
      } catch (e) { cleanup(); throw e }
    },
    saveDownload: deps.saveDownload,
  }
}
