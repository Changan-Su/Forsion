/** Execute the real main-process handlers with isolated host/network dependencies. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'
import { describe, expect, it, vi } from 'vitest'
import { forsionAccountId } from '../shared/forsionAccount'

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
const section = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
const statusCode = section("  ipcMain.handle('auth:status'", "  ipcMain.handle('app:version'")
const refreshCode = section('  const refreshAuthSliding =', '  // 最近一次**成功**')
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const key = (url: string, token: string) => `${url.replace(/\/+$/, '')}\u0000${token}`

function harness() {
  let credentials = { cloudUrl: 'https://a.test', token: 'token-a' }
  const who = deferred<unknown>(), refreshed = deferred<string | null>()
  let status!: () => Promise<any>
  const context = {
    authIntent: 0, whoProfileCache: null, lastAuthKey: '',
    ipcMain: { handle: (_channel: string, handler: () => Promise<any>) => { status = handler } },
    loadConfig: async () => ({ cloudUrl: credentials.cloudUrl, mode: 'external' }),
    loadTanguCreds: () => ({ ...credentials }),
    saveTanguCreds: vi.fn((creds: typeof credentials) => { credentials = creds }),
    currentAuthKey: () => key(credentials.cloudUrl, credentials.token),
    forsionWhoami: () => who.promise,
    forsionRefreshToken: () => refreshed.promise,
    shouldRefreshToken: () => true, app: { getVersion: () => 'test' },
    forsionAccountId, rememberForsionAccount: vi.fn(), credKey: key,
    PRODUCT: { agentBackend: false },
    runAuthTransition: (fn: () => Promise<unknown>) => fn(),
    withPreparedAccount: (fn: () => Promise<unknown>) => fn(),
    forsionLogout: vi.fn(() => { credentials = { ...credentials, token: '' } }),
    refreshUnitHost: vi.fn(), console: { log: vi.fn() },
  }
  runInNewContext(transform(statusCode, { transforms: ['typescript'] }).code, context)
  const refresh = runInNewContext(transform(refreshCode + '\nrefreshAuthSliding', { transforms: ['typescript'] }).code, context) as () => Promise<void>
  return { context, status, refresh, who, refreshed, setCredentials: (creds: typeof credentials) => { credentials = creds } }
}

describe('main-process auth concurrency', () => {
  it('late successful whoami returns signed-out state after logout', async () => {
    const h = harness(), status = h.status()
    await Promise.resolve()
    h.setCredentials({ cloudUrl: 'https://a.test', token: '' })
    h.who.resolve({ status: 'ok', user: { username: 'alice' } })
    expect(await status).toMatchObject({ loggedIn: false, username: null, tokenSource: null })
    expect(h.context.rememberForsionAccount).not.toHaveBeenCalled()
  })

  it('an old expired whoami cannot clear a newly selected account', async () => {
    const h = harness(), status = h.status()
    await Promise.resolve()
    h.setCredentials({ cloudUrl: 'https://b.test', token: 'token-b' })
    h.who.resolve({ status: 'expired' })
    expect(await status).toMatchObject({ loggedIn: true, cloudUrl: 'https://b.test', username: null })
    expect(h.context.forsionLogout).not.toHaveBeenCalled()
  })

  it('a token refresh cannot restore the old endpoint after an external account change', async () => {
    const h = harness(), refresh = h.refresh()
    await Promise.resolve()
    h.setCredentials({ cloudUrl: 'https://b.test', token: 'token-a' })
    h.refreshed.resolve('fresh-from-a')
    await refresh
    expect(h.context.saveTanguCreds).not.toHaveBeenCalled()
  })

  it('a token refresh cannot restore credentials after sign-out intent starts', async () => {
    const h = harness(), refresh = h.refresh()
    await Promise.resolve()
    h.context.authIntent++
    h.refreshed.resolve('fresh-from-a')
    await refresh
    expect(h.context.saveTanguCreds).not.toHaveBeenCalled()
  })
})
