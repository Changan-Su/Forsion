import { AccountChangedError } from './account'

/** Attach one existing visitor session to its declared API namespace. Other
 * requests retain native fetch and never receive visitor credentials. */
export function createAccountFetch(options: {
  apiBase: string
  getToken(): string
  request(path: string, init?: RequestInit): Promise<Response>
  fallback: typeof fetch
}): typeof fetch {
  const api = new URL(options.apiBase)
  const apiPath = api.pathname.replace(/\/+$/, '')
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
    const insideApi = url.origin === api.origin && (url.pathname === apiPath || url.pathname.startsWith(apiPath + '/'))
    if (!insideApi) return options.fallback(input, init)
    const token = options.getToken()
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const supplied = headers.get('Authorization')
    if (supplied && supplied !== `Bearer ${token}`) throw new AccountChangedError()
    let requestInit = init
    if (input instanceof Request) {
      const merged = new Request(input, init)
      requestInit = { method: merged.method, headers: merged.headers, signal: merged.signal, body: merged.body,
        ...(merged.body ? { duplex: 'half' } : {}) } as RequestInit
    }
    return options.request(url.href, requestInit)
  }
}
