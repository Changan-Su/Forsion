// @vitest-environment happy-dom
/**
 * 设备页的本页令牌:占位值绝不当令牌发,401 不会让页面一直重载。
 * 背景:普通浏览器打开中转来的设备页靠设备子域的 Cookie;请求一旦自带 Authorization,中转就不看 Cookie,
 * 回 401 → 整页重载 → 再 401,无限循环。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUnitAmadeusBridge } from '../../../web/src/amadeus/unitBridge'
import { createUnitAuthErrorHandler, UNIT_AUTH_RELOAD_WINDOW_MS } from '../../../web/src/unitAuthReload'
import { isRealUnitToken, UNIT_TOKEN_PLACEHOLDER, unitAuthHeader } from './services/unitToken'
import { connectionTarget } from './services/engine/targets'

vi.mock('./amadeus/api', () => ({ amadeus: { listPlugins: async () => [], listPages: async () => [], listFiles: async () => [] } }))

type Seen = { path: string; auth: string | null }
function stubNetwork(rpcStatus = 200): Seen[] {
  const seen: Seen[] = []
  vi.stubGlobal('EventSource', class { close(): void {} })
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push({ path: url.pathname, auth: new Headers(init?.headers).get('Authorization') })
    if (url.pathname.endsWith('/vault/asset-token')) return new Response(JSON.stringify({ token: 'at1', ttlSec: 600 }))
    if (url.pathname.endsWith('/vault/rpc')) return new Response(JSON.stringify({ ok: true, result: [] }), { status: rpcStatus })
    if (url.pathname.endsWith('/unit/plugins')) return new Response(JSON.stringify({ plugins: [] }))
    return new Response('{}', { status: 404 })
  }))
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { __FORSION_UNIT_PAGE__?: unknown }).__FORSION_UNIT_PAGE__
  delete (window as unknown as { __FORSION_UNIT_TOKEN__?: unknown }).__FORSION_UNIT_TOKEN__
  delete (window as unknown as { tangu?: unknown }).tangu
  sessionStorage.clear()
})

describe('isRealUnitToken', () => {
  it('only a non-empty, non-placeholder token counts', () => {
    expect(isRealUnitToken(UNIT_TOKEN_PLACEHOLDER)).toBe(false)
    expect(isRealUnitToken('')).toBe(false)
    expect(isRealUnitToken(undefined)).toBe(false)
    expect(isRealUnitToken('pair-abc')).toBe(true)
    expect(unitAuthHeader(UNIT_TOKEN_PLACEHOLDER)).toBeUndefined()
    expect(unitAuthHeader('pair-abc')).toEqual({ Authorization: 'Bearer pair-abc' })
  })
})

describe('unitBridge', () => {
  it('placeholder: vault/rpc and vault/asset-token carry no Authorization', async () => {
    const seen = stubNetwork()
    const bridge = await createUnitAmadeusBridge({ base: 'http://unit.test/u/', getToken: () => UNIT_TOKEN_PLACEHOLDER, onAuthError: vi.fn() })
    await bridge.listPages()
    const paths = seen.map((s) => s.path)
    expect(paths).toContain('/u/vault/asset-token')
    expect(paths).toContain('/u/vault/rpc')
    expect(seen.every((s) => s.auth === null)).toBe(true)
  })

  it('real token: both carry the bearer', async () => {
    const seen = stubNetwork()
    const bridge = await createUnitAmadeusBridge({ base: 'http://unit.test/u/', getToken: () => 'pair-abc', onAuthError: vi.fn() })
    await bridge.listPages()
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.every((s) => s.auth === 'Bearer pair-abc')).toBe(true)
  })
})

describe('pluginStore device-page source', () => {
  const run = async (token: string): Promise<Seen[]> => {
    const seen = stubNetwork()
    const w = window as unknown as { __FORSION_UNIT_PAGE__?: unknown; __FORSION_UNIT_TOKEN__?: string }
    w.__FORSION_UNIT_PAGE__ = { instanceId: 'u1', name: 'U', version: '9.9.9' }
    w.__FORSION_UNIT_TOKEN__ = token
    const { resolveExternalSources } = await import('./amadeus/plugins/pluginStore')
    await resolveExternalSources()
    return seen.filter((s) => s.path.endsWith('/unit/plugins'))
  }
  it('placeholder: unit/plugins carries no Authorization', async () => {
    const seen = await run(UNIT_TOKEN_PLACEHOLDER)
    expect(seen).toHaveLength(1)
    expect(seen[0].auth).toBeNull()
  })
  it('real token: unit/plugins carries the bearer', async () => {
    expect((await run('pair-abc'))[0].auth).toBe('Bearer pair-abc')
  })
})

describe('engine target on a device page', () => {
  it('placeholder: no Authorization; real token: bearer as before', async () => {
    ;(window as unknown as { tangu?: unknown }).tangu = { unitPage: true }
    const conn = (token: string) => connectionTarget({ backendUrl: 'http://unit.test/u/engine', token })
    expect(await conn(UNIT_TOKEN_PLACEHOLDER).headers(true)).toEqual({ 'Content-Type': 'application/json' })
    expect(await conn(UNIT_TOKEN_PLACEHOLDER).headers(false)).toEqual({})
    expect(await conn('pair-abc').headers(false)).toEqual({ Authorization: 'Bearer pair-abc' })
  })
  it('outside a device page the header shape is unchanged', async () => {
    const conn = connectionTarget({ backendUrl: 'http://127.0.0.1:1/engine', token: UNIT_TOKEN_PLACEHOLDER })
    expect(await conn.headers(false)).toEqual({ Authorization: `Bearer ${UNIT_TOKEN_PLACEHOLDER}` })
  })
})

describe('401 reload guard', () => {
  const handler = (token: string, now: () => number, reload = vi.fn(), clearToken = vi.fn()) => ({
    reload, clearToken,
    fire: createUnitAuthErrorHandler({ token, clearToken, reload, storage: sessionStorage, storageKey: 'unit_auth_reload_u1', now }),
  })

  it('placeholder: two 401s in a row, and the 401 after the reload, reload only once', async () => {
    let t = 1_000_000
    const first = handler(UNIT_TOKEN_PLACEHOLDER, () => t)
    first.fire(); first.fire()
    expect(first.reload).toHaveBeenCalledTimes(1)
    expect(first.clearToken).not.toHaveBeenCalled()
    // 重载后的新页面又收到 401(Cookie 仍然无效)
    t += 5_000
    const second = handler(UNIT_TOKEN_PLACEHOLDER, () => t)
    second.fire()
    expect(second.reload).not.toHaveBeenCalled()
    // 窗口过后才允许再试一次
    t += UNIT_AUTH_RELOAD_WINDOW_MS
    const third = handler(UNIT_TOKEN_PLACEHOLDER, () => t)
    third.fire()
    expect(third.reload).toHaveBeenCalledTimes(1)
  })

  it('placeholder: a 401 suppressed inside the window does not disable the same page forever', () => {
    let t = 2_000_000
    sessionStorage.setItem('unit_auth_reload_u1', String(t - 5_000)) // 上一页 5 秒前重载过
    const page = handler(UNIT_TOKEN_PLACEHOLDER, () => t)
    page.fire(); page.fire()
    expect(page.reload).not.toHaveBeenCalled()
    // 同一页、同一个处理器,窗口过后再收到 401 → 再试一次,之后不再重复
    t += UNIT_AUTH_RELOAD_WINDOW_MS
    page.fire(); page.fire()
    expect(page.reload).toHaveBeenCalledTimes(1)
  })

  it('placeholder via the real bridge: two failing calls reload once', async () => {
    stubNetwork(401)
    const reload = vi.fn()
    const onAuthError = createUnitAuthErrorHandler({ token: UNIT_TOKEN_PLACEHOLDER, clearToken: vi.fn(), reload, storage: sessionStorage, storageKey: 'unit_auth_reload_u2' })
    const bridge = await createUnitAmadeusBridge({ base: 'http://unit.test/u/', getToken: () => UNIT_TOKEN_PLACEHOLDER, onAuthError })
    await expect(bridge.listPages()).rejects.toThrow()
    await expect(bridge.listPages()).rejects.toThrow()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('placeholder without readable storage: never reloads', () => {
    const reload = vi.fn()
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } } as unknown as Storage
    createUnitAuthErrorHandler({ token: UNIT_TOKEN_PLACEHOLDER, clearToken: vi.fn(), reload, storage: broken, storageKey: 'k' })()
    createUnitAuthErrorHandler({ token: UNIT_TOKEN_PLACEHOLDER, clearToken: vi.fn(), reload, storageKey: 'k' })()
    expect(reload).not.toHaveBeenCalled()
  })

  it('real pairing token: clears it and reloads into pairing, as before', () => {
    const { fire, reload, clearToken } = handler('pair-abc', () => 1)
    sessionStorage.setItem('unit_auth_reload_u1', '1') // 占位那条的窗口不影响真令牌
    fire()
    expect(clearToken).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
