import type { AuthStatusInfo } from '../../desktop/frontend/src/types'

export interface BrowserIdentity {
  userId: string
  username: string
  role: string
  tenantId?: string
  workspaceId?: string
  nickname?: string | null
  avatar?: string | null
  membershipTier?: string | null
}

export type BrowserAuthStatus = AuthStatusInfo & Partial<Pick<BrowserIdentity, 'userId' | 'role' | 'tenantId' | 'workspaceId'>>
type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type ChangeListener = (status: BrowserAuthStatus) => void
export interface BrowserAccountOptions {
  apiBase: string
  storage?: TokenStorage
  tokenKey?: string
  /** The host may resolve identities outside /api, but only on this API's origin. */
  identityUrl?: string
  /** Explicit host-owned namespaces in addition to /api; each stays same-origin. */
  allowedPaths?: string[]
  beforeChange?: () => void | Promise<void>
  onChange?: ChangeListener
  fetch?: typeof fetch
}

export class AccountChangedError extends Error {
  constructor() { super('The account changed while the request was in progress'); this.name = 'AccountChangedError' }
}

export class AccountHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'AccountHttpError' }
}

/** Shared browser adapter for the existing Forsion login/session endpoints.
 * Storage selection is a host decision: Web shares localStorage; Unit visitors
 * use their own sessionStorage key. This module never decodes JWTs for authority.
 */
export function createBrowserAccount(options: BrowserAccountOptions) {
  const base = new URL(options.apiBase, typeof location === 'undefined' ? undefined : location.href)
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid account API base')
  base.pathname = base.pathname.replace(/\/+$/, '') + '/'
  const apiBase = base.href.replace(/\/$/, '')
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const tokenKey = options.tokenKey ?? 'forsion_token'
  const storage = options.storage
  const listeners = new Set<ChangeListener>(options.onChange ? [options.onChange] : [])
  const preparations = new Set<() => void | Promise<void>>(options.beforeChange ? [options.beforeChange] : [])
  const requests = new Set<AbortController>()
  let token = readStorage()
  let identity: BrowserIdentity | null = null
  let generation = 0
  let transitions: Promise<unknown> = Promise.resolve()

  function readStorage(): string {
    if (!storage) return ''
    try { return storage.getItem(tokenKey) || '' } catch { return '' }
  }
  function invalidate(): void {
    generation++
    for (const controller of requests) controller.abort(new AccountChangedError())
    requests.clear()
  }
  function getToken(): string {
    if (storage) {
      const stored = readStorage()
      if (stored !== token) {
        invalidate()
        token = stored
        identity = null
      }
    }
    return token
  }
  function snapshot(valid?: boolean | null): BrowserAuthStatus {
    const current = getToken()
    const tokenValid = valid === undefined ? (identity ? true : null) : valid
    return {
      loggedIn: !!current && tokenValid !== false,
      tokenValid: current ? tokenValid : null,
      cloudUrl: apiBase,
      tokenSource: current ? 'tangu-login' : null,
      username: identity?.username ?? null,
      accountId: identity ? `${apiBase}::${identity.userId}` : null,
      ...(identity ?? {}),
    }
  }
  function notify(): void {
    const status = snapshot()
    for (const listener of listeners) {
      try { listener(status) } catch (error) { console.error('[account] Change listener failed:', error) }
    }
  }
  function assertCurrent(expectedGeneration: number, expectedToken: string): void {
    if (getToken() !== expectedToken || generation !== expectedGeneration) throw new AccountChangedError()
  }
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = transitions.then(operation)
    transitions = pending.catch(() => {})
    return pending
  }
  /** Relative paths are API-relative, including '/auth/me'. Absolute URLs must
   * remain inside the exact API base; protocol-relative URLs and traversal fail. */
  const allowedPaths = (options.allowedPaths ?? []).map((path) => {
    const url = new URL(path, base)
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('%') ||
      url.origin !== base.origin || url.search || url.hash || url.pathname !== path || path === '/') throw new Error('Invalid account request namespace')
    return path.replace(/\/+$/, '')
  })
  const inNamespace = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/')
  const allowedPath = (path: string) => inNamespace(path, base.pathname.slice(0, -1)) || allowedPaths.some((prefix) => inNamespace(path, prefix))
  function apiUrl(path: string): URL {
    const pathPart = path.split(/[?#]/, 1)[0]
    if (!path || path.startsWith('//') || pathPart.includes('\\')) throw new Error('Request must stay inside the account API base')
    const explicitNamespace = allowedPaths.some((prefix) => inNamespace(pathPart, prefix))
    const url = /^[a-z][a-z\d+.-]*:/i.test(path) ? new URL(path) : new URL(explicitNamespace ? path : path.replace(/^\//, ''), base)
    // File names and query parameters legitimately contain encoded slashes.
    // Normalize only the pathname to detect an encoded escape across namespaces.
    let decoded: URL
    try { decoded = new URL(decodeURIComponent(url.pathname).replace(/\\/g, '/'), base.origin) }
    catch { throw new Error('Request must stay inside the account API base') }
    if (url.origin !== base.origin || url.username || url.password || url.hash || !allowedPath(url.pathname) ||
      decoded.origin !== base.origin || !allowedPath(decoded.pathname)) {
      throw new Error('Request must stay inside the account API base')
    }
    return url
  }
  const identityUrl = options.identityUrl ? new URL(options.identityUrl, base) : apiUrl('/auth/me')
  if (identityUrl.origin !== base.origin || identityUrl.username || identityUrl.password || identityUrl.hash) throw new Error('Identity endpoint must use the account API origin')

  function guardedResponse(response: Response, check: () => void, release: () => void): Response {
    const reader = response.body?.getReader()
    const body = reader ? new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          check()
          const part = await reader.read()
          check()
          if (part.done) { controller.close(); release() }
          else controller.enqueue(part.value)
        } catch (error) {
          controller.error(error)
          void reader.cancel(error).catch(() => {})
          release()
        }
      },
      async cancel(reason) { release(); await reader.cancel(reason) },
    }, { highWaterMark: 0 }) : null
    if (!reader) release()
    const guarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    Object.defineProperties(guarded, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    })
    // Check after decoding too: body delivery and its awaiting consumer may be
    // separated by a switch in another microtask, even for an already buffered body.
    for (const method of ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const) {
      const consume = guarded[method].bind(guarded)
      Object.defineProperty(guarded, method, { value: async () => { check(); const value = await consume(); check(); return value } })
    }
    const clone = guarded.clone.bind(guarded)
    Object.defineProperty(guarded, 'clone', { value: () => { check(); return guardedResponse(clone(), check, () => {}) } })
    return guarded
  }

  async function boundRequest(url: URL, init: RequestInit = {}, credential = getToken()): Promise<Response> {
    const currentToken = getToken()
    const expectedGeneration = generation
    const controller = new AbortController()
    const check = () => {
      assertCurrent(expectedGeneration, currentToken)
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('The request was aborted', 'AbortError')
    }
    const abort = () => controller.abort(init.signal?.reason)
    if (init.signal?.aborted) abort()
    else init.signal?.addEventListener('abort', abort, { once: true })
    requests.add(controller)
    const release = () => { requests.delete(controller); init.signal?.removeEventListener('abort', abort) }
    const headers = new Headers(init.headers)
    headers.delete('Authorization')
    if (credential) headers.set('Authorization', `Bearer ${credential}`)
    try {
      check()
      const response = await fetcher(url.href, { ...init, headers, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' })
      check()
      return guardedResponse(response, check, release)
    } catch (error) { release(); check(); throw error }
  }
  function request(path: string, init?: RequestInit): Promise<Response> {
    const supplied = new Headers(init?.headers).get('Authorization')
    if (supplied && supplied !== `Bearer ${getToken()}`) throw new AccountChangedError()
    return boundRequest(apiUrl(path), init)
  }
  function parseIdentity(value: unknown): BrowserIdentity {
    const user = value as Partial<BrowserIdentity> & { id?: unknown }
    const id = user?.userId ?? user?.id
    if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim() || typeof user.username !== 'string' || !user.username) {
      throw new Error('The account endpoint returned an invalid identity')
    }
    return {
      userId: String(id), username: user.username, role: typeof user.role === 'string' ? user.role : 'user',
      ...(typeof user.tenantId === 'string' ? { tenantId: user.tenantId } : {}),
      ...(typeof user.workspaceId === 'string' ? { workspaceId: user.workspaceId } : {}),
      nickname: typeof user.nickname === 'string' ? user.nickname : null,
      avatar: typeof user.avatar === 'string' ? user.avatar : null,
      membershipTier: typeof user.membershipTier === 'string' ? user.membershipTier : null,
    }
  }
  async function verify(credential: string): Promise<BrowserIdentity> {
    const response = await boundRequest(identityUrl, {}, credential)
    if (!response.ok) { void response.body?.cancel(); throw new AccountHttpError(response.status, 'Could not verify the account session') }
    return parseIdentity(await response.json())
  }
  async function authStatus(): Promise<BrowserAuthStatus> {
    const currentToken = getToken()
    const expectedGeneration = generation
    if (!currentToken) return snapshot()
    try {
      const verified = await verify(currentToken)
      assertCurrent(expectedGeneration, currentToken)
      identity = verified
      return snapshot(true)
    } catch (error) {
      assertCurrent(expectedGeneration, currentToken)
      if (error instanceof AccountHttpError && (error.status === 401 || error.status === 403)) {
        identity = null
        return snapshot(false)
      }
      if (error instanceof AccountChangedError) throw error
      return snapshot(null) // Offline or 5xx is uncertainty, never a new identity.
    }
  }
  async function prepare(): Promise<void> {
    for (const listener of preparations) await listener()
  }
  function commit(nextToken: string, nextIdentity: BrowserIdentity | null): void {
    // A storage failure leaves the old account intact and is reported to the caller.
    if (storage) {
      if (nextToken) storage.setItem(tokenKey, nextToken)
      else storage.removeItem(tokenKey)
    }
    invalidate()
    token = nextToken
    identity = nextIdentity
    notify()
  }
  async function adoptVerified(candidate: string): Promise<BrowserAuthStatus> {
    if (!candidate.trim()) throw new Error('An account token is required')
    const currentToken = getToken()
    const expectedGeneration = generation
    const verified = await verify(candidate)
    assertCurrent(expectedGeneration, currentToken)
    if (candidate === currentToken) { identity = verified; return snapshot(true) }
    try {
      await prepare()
      assertCurrent(expectedGeneration, currentToken)
      commit(candidate, verified)
      return snapshot(true)
    } catch (error) { notify(); throw error }
  }
  function adoptToken(candidate: string): Promise<BrowserAuthStatus> { return enqueue(() => adoptVerified(candidate)) }
  function signIn(credentials: { username: string; password: string; captchaVerifyParam?: string }): Promise<BrowserAuthStatus> {
    return enqueue(async () => {
      const response = await boundRequest(apiUrl('/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }, '')
      if (!response.ok) { void response.body?.cancel(); throw new AccountHttpError(response.status, 'Account sign-in failed') }
      const result = await response.json()
      if (typeof result?.token !== 'string') throw new Error('Sign-in did not return an account token')
      return adoptVerified(result.token)
    })
  }
  function logout(): Promise<void> {
    const requestedToken = getToken()
    const requestedGeneration = generation
    return enqueue(async () => {
      assertCurrent(requestedGeneration, requestedToken)
      const currentToken = getToken()
      const expectedGeneration = generation
      if (!currentToken) return
      try {
        await prepare()
        assertCurrent(expectedGeneration, currentToken)
        const response = await request('/auth/logout', { method: 'POST' })
        if (!response.ok && response.status !== 401) {
          void response.body?.cancel()
          throw new AccountHttpError(response.status, 'Account sign-out failed; the session was retained')
        }
        if (response.ok && response.status !== 204) {
          const acknowledgement = await response.json()
          if (acknowledgement?.ok !== true) throw new Error('Account sign-out was not acknowledged; the session was retained')
        } else void response.body?.cancel()
        assertCurrent(expectedGeneration, currentToken)
        commit('', null)
      } catch (error) { notify(); throw error }
    })
  }
  /** Forget an already rejected/revoked session, e.g. a 401 guard. This is not logout. */
  function clearSession(options: string | { expectedToken?: string; prepare?: boolean } = {}): Promise<void> {
    const expectedToken = typeof options === 'string' ? options : options.expectedToken ?? getToken()
    const shouldPrepare = typeof options === 'string' || options.prepare !== false
    return enqueue(async () => {
      if (getToken() !== expectedToken) return
      try {
        if (shouldPrepare) await prepare()
        if (getToken() === expectedToken) commit('', null)
      } catch (error) { notify(); throw error }
    })
  }
  return {
    getToken,
    getIdentity: (): BrowserIdentity | null => { getToken(); return identity ? { ...identity } : null },
    get generation(): number { getToken(); return generation },
    authStatus, adoptToken, signIn,
    login: (username: string, password: string) => signIn({ username, password }),
    logout, clearSession, request,
    subscribe(listener: ChangeListener): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    beforeChange(listener: () => void | Promise<void>): () => void { preparations.add(listener); return () => { preparations.delete(listener) } },
  }
}

export type BrowserAccount = ReturnType<typeof createBrowserAccount>
