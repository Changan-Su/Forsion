/** Account authority that verifies Forsion logins with a Forsion server reached over HTTPS.
 * A public Unit that does not run the server in-process uses this instead of a backend plugin. */
import { createHash } from 'node:crypto'
import type { BackendAccount, BackendIdentity } from './backendTypes'

export interface RemoteAccountConfig {
  /** Origin of the Forsion server that owns the accounts, e.g. https://api.example.com. No path. */
  origin: string
  /** Optional sign-in page on another public entry of the same operator. Visitors without a login
   *  are sent there and come back with a one-time handoff code (see the web account adapter). */
  loginVia?: string
}

export interface RemoteAccountOptions extends RemoteAccountConfig {
  timeoutMs?: number
  /** How long a verified identity is reused. Revocation takes up to this long to apply. */
  cacheMs?: number
  maxEntries?: number
  fetch?: typeof fetch
  now?: () => number
}

/** Thrown when the account service cannot answer. Callers must not treat it as "signed out". */
export class RemoteAccountUnavailable extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function checkedOrigin(value: unknown, what: string): URL {
  if (typeof value !== 'string') throw new Error(`${what} must be a URL`)
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${what} must be a URL`) }
  // Plain HTTP only for a server on this machine (development and tests).
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error(`${what} must use HTTPS`)
  if (url.username || url.password || url.search || url.hash) throw new Error(`${what} must not carry credentials, a query or a fragment`)
  if (!LOOPBACK.has(url.hostname) && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname)) throw new Error(`${what} must name a plain host`)
  return url
}

export function validateRemoteAccount(config: unknown): RemoteAccountConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('remoteAccount must be an object')
  const { origin, loginVia } = config as Record<string, unknown>
  const server = checkedOrigin(origin, 'remoteAccount.origin')
  if (server.pathname !== '/') throw new Error('remoteAccount.origin must be an origin without a path')
  const result: RemoteAccountConfig = { origin: server.origin }
  if (loginVia !== undefined) result.loginVia = checkedOrigin(loginVia, 'remoteAccount.loginVia').href
  return result
}

const isText = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

/** Only the fields a Unit uses, copied from a server reply; anything else is dropped. */
function parseIdentity(body: unknown): BackendIdentity | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (!isText(b.userId) || !isText(b.username) || !isText(b.role, 64)) return null
  const identity: BackendIdentity = { userId: b.userId, username: b.username, role: b.role }
  for (const key of ['tenantId', 'workspaceId', 'adminAccessRole'] as const) if (isText(b[key])) identity[key] = b[key] as string
  if (Array.isArray(b.adminPermissions) && b.adminPermissions.every((p) => isText(p, 128))) identity.adminPermissions = [...b.adminPermissions as string[]]
  return identity
}

export function createRemoteAccount(options: RemoteAccountOptions): Required<Pick<BackendAccount, 'metadata'>> & BackendAccount & { loginVia?: string } {
  const { origin, loginVia } = validateRemoteAccount(options)
  const timeoutMs = options.timeoutMs ?? 8000
  const cacheMs = options.cacheMs ?? 30_000
  const maxEntries = options.maxEntries ?? 2000
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const cache = new Map<string, { identity: BackendIdentity; expires: number }>()
  const pending = new Map<string, Promise<BackendIdentity | null>>()

  // One lookup may serve several callers, so it runs under its own deadline, not any one caller's signal.
  async function ask(token: string, purpose: 'administration' | undefined): Promise<BackendIdentity | null> {
    const url = new URL('/api/auth/unit-identity', origin)
    if (purpose) url.searchParams.set('purpose', purpose)
    let response: Response
    try {
      response = await doFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new RemoteAccountUnavailable(`Account service unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Only an explicit refusal means "not signed in". Anything else keeps the visitor's login intact.
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return null }
    if (response.status !== 200) { await response.body?.cancel(); throw new RemoteAccountUnavailable(`Account service answered ${response.status}`) }
    const identity = parseIdentity(await response.json().catch(() => null))
    if (!identity) throw new RemoteAccountUnavailable('Account service sent an unreadable identity')
    return identity
  }

  return {
    metadata: { apiBase: '/api', loginPath: '/auth' },
    ...(loginVia ? { loginVia } : {}),
    async resolve(token, opts = {}) {
      opts.signal?.throwIfAborted()
      // Bearer values are header-safe by construction; anything else is not a Forsion token.
      if (!/^[\x21-\x7e]{1,8192}$/.test(token)) return null
      const purpose = opts.purpose === 'administration' ? 'administration' : undefined
      const key = createHash('sha256').update(`${purpose || ''}\0${token}`).digest('hex')
      const hit = cache.get(key)
      if (hit && hit.expires > now()) return structuredClone(hit.identity)
      if (hit) cache.delete(key)
      // Concurrent requests with one token share one lookup; the caller's own signal still applies.
      let job = pending.get(key)
      if (!job) {
        job = ask(token, purpose).then((identity) => {
          if (identity && cacheMs > 0) {
            if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!)
            cache.set(key, { identity, expires: now() + cacheMs })
          }
          return identity
        }).finally(() => pending.delete(key))
        pending.set(key, job)
      }
      const result = await (opts.signal
        ? Promise.race([job, new Promise<never>((_, reject) => opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason), { once: true }))])
        : job)
      return result ? structuredClone(result) : null
    },
  }
}
