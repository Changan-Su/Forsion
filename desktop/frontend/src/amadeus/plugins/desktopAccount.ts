/** Desktop `ctx.account`. Android and Unit Web hand the plugin host a `tangu.account`; the desktop bridge cannot (a
 *  contextBridge object is read-only and cannot carry a Response), so the adapter lives here and wraps `cloudFetch`,
 *  whose token stays in the main process. Present only when Extend registered the account channels.
 *
 *  ponytail: cloud:fetch is JSON over IPC. Request bodies must be JSON strings, replies are JSON, custom headers do not
 *  travel, and an abort only drops the result: the main process runs that fetch until it answers or hits the 120s cap. */
import { leaseAccountResponse } from './accountResponse'
import type { PluginAccount, PluginAccountStatus } from './types'

type Bridge = NonNullable<typeof window.tangu>

/** cloud:fetch defaults to 15s, which a 20s long poll would never survive; 120s is its cap. */
const REQUEST_TIMEOUT_MS = 120_000

const apiBase = (cloudUrl: string): string => `${String(cloudUrl || '').replace(/\/+$/, '').replace(/\/api$/, '')}/api`

/** cloud:fetch takes paths relative to /api. Absolute URLs are accepted on the other hosts, so they work here too,
 *  inside the account API only. null = outside it. */
export function accountApiPath(path: string, cloudUrl: string): string | null {
  if (path.startsWith('/')) return path.startsWith('//') ? null : path
  try {
    const base = new URL(`${apiBase(cloudUrl)}/`), target = new URL(path)
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.username || target.password) return null
    return `/${target.pathname.slice(base.pathname.length)}${target.search}`
  } catch { return null }
}

function jsonBody(body: RequestInit['body']): unknown {
  if (body === undefined || body === null || body === '') return undefined
  if (typeof body === 'string') {
    try { return JSON.parse(body) } catch { /* reported below */ }
  }
  throw new TypeError('Account requests on desktop carry JSON bodies only')
}

function toResponse(result: { status: number; json?: unknown; error?: string } | null | undefined): Response {
  const status = result?.status
  // status 0 = never sent: fetch semantics are to reject, so callers do not mistake it for a server answer.
  if (typeof status !== 'number' || status < 200 || status > 599) throw new TypeError(result?.error || 'Account request failed')
  const headers = { 'Content-Type': 'application/json' }
  if (result!.error) return new Response(JSON.stringify({ error: result!.error }), { status, headers })
  const empty = result!.json === undefined || result!.json === null // cloud:fetch reports a non-JSON reply as null
  return new Response(empty ? null : JSON.stringify(result!.json), { status, headers })
}

export function createDesktopAccount(t: Bridge): PluginAccount {
  let epoch = 0
  const pending = new Set<AbortController>()
  const listeners = new Set<(s: PluginAccountStatus) => void>()
  const status = async (): Promise<PluginAccountStatus> => {
    const generation = epoch
    const raw = await t.authStatus!()
    if (generation !== epoch) return { loggedIn: false }
    // No userId: `accountId` here is the local account record, not the server's user id.
    return { loggedIn: raw.loggedIn === true, cloudUrl: apiBase(raw.cloudUrl),
      ...(typeof raw.username === 'string' ? { username: raw.username } : {}) }
  }
  t.onAuthChanged!(() => {
    const generation = ++epoch
    pending.forEach((ctl) => ctl.abort()); pending.clear()
    // Revoke rendered account data immediately; refresh only the current generation.
    listeners.forEach((cb) => { try { cb({ loggedIn: false }) } catch { /* one subscriber cannot block the rest */ } })
    void status().then((s) => { if (generation === epoch) listeners.forEach((cb) => { try { cb(s) } catch { /* isolated */ } }) }).catch(() => {})
  })
  return {
    status, login: () => t.forsionLogin!(), logout: () => t.forsionLogout!(),
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    async request(path, init = {}) {
      const generation = epoch
      const api = path.startsWith('/') ? accountApiPath(path, '') : accountApiPath(path, (await t.authStatus!()).cloudUrl)
      if (!api) throw new Error('Account requests must stay inside the account API')
      const body = jsonBody(init.body)
      const ctl = new AbortController(), outer = init.signal
      const abort = () => ctl.abort()
      if (outer?.aborted) abort(); else outer?.addEventListener('abort', abort, { once: true })
      pending.add(ctl)
      const cleanup = () => { pending.delete(ctl); outer?.removeEventListener('abort', abort) }
      const current = () => { if (ctl.signal.aborted || generation !== epoch) throw new DOMException('Account changed or request aborted', 'AbortError') }
      try {
        current()
        const aborted = new Promise<never>((_, reject) => {
          ctl.signal.addEventListener('abort', () => reject(new DOMException('Account changed or request aborted', 'AbortError')), { once: true })
        })
        const result = await Promise.race([
          t.cloudFetch!({ path: api, method: String(init.method || 'GET').toUpperCase(), timeoutMs: REQUEST_TIMEOUT_MS, ...(body !== undefined ? { body } : {}) }),
          aborted,
        ])
        current()
        return leaseAccountResponse(toResponse(result), current, cleanup, ctl.signal)
      } catch (e) { cleanup(); throw e }
    },
  }
}

let shared: { bridge: Bridge; account: PluginAccount } | null = null
/** One adapter per window, so every plugin shares the account generation. Absent without Extend or on another host. */
export function desktopAccount(t: Bridge | undefined): PluginAccount | undefined {
  if (!t || t.account || t.mobile || !t.cloudFetch || !t.authStatus || !t.forsionLogin || !t.forsionLogout || !t.onAuthChanged) return undefined
  if (shared?.bridge !== t) shared = { bridge: t, account: createDesktopAccount(t) }
  return shared.account
}
