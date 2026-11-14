/**
 * Unit 网页垫片在委托管理员角色下(web/src/unitShim.ts):
 *   · whoami 回包带 role → window.tangu.delegatedAdmin;不挂文件桥(vault/asset-token、events、rpc 一条不发),
 *     不给 backendStatus(unit/meta)、listProviders / 主机文件 / spacesList,setConfig 不 PUT;
 *   · 白名单外的请求被拒是 403,不触发 401 那条「清令牌 + 整页重载」(文件桥上 403 不调 onAuthError);
 *   · 别的来路(whoami 不带 role)照旧挂桥。
 * 跑:cd desktop && npx vitest run frontend/src/unitShimDelegated.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delegatedRoleOf, installUnitShim } from '../../../web/src/unitShim'
import { createUnitAmadeusBridge } from '../../../web/src/amadeus/unitBridge'

const hits: Array<{ method: string; path: string }> = []
let whoami: Record<string, unknown> = { ok: true }
const store = (): Storage => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear(), key: () => null, length: 0 } as Storage }

beforeEach(() => {
  hits.length = 0
  vi.stubGlobal('window', { __FORSION_UNIT_PAGE__: { instanceId: 'u1', name: 'Studio Mac', version: '1', projection: 'local', localCapabilities: { vault: true, engine: true, host: true } }, addEventListener: () => {} })
  vi.stubGlobal('document', { baseURI: 'http://unit.test/web/', title: '' })
  vi.stubGlobal('location', { hash: '', pathname: '/web/', search: '', href: 'http://unit.test/web/', origin: 'http://unit.test', reload: vi.fn() })
  vi.stubGlobal('history', { replaceState: () => {} })
  vi.stubGlobal('sessionStorage', store())
  vi.stubGlobal('localStorage', store())
  vi.stubGlobal('EventSource', class { close() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    hits.push({ method: (init?.method || 'GET').toUpperCase(), path: url.pathname })
    if (url.pathname === '/web/unit/whoami') return new Response(JSON.stringify(whoami))
    if (url.pathname === '/web/unit/config') return new Response(JSON.stringify({ config: {} }))
    if (url.pathname === '/web/vault/asset-token') return new Response(JSON.stringify({ token: 'at', ttlSec: 600 }))
    return new Response(JSON.stringify({ code: 'LOCAL_ONLY' }), { status: 403 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('delegatedRoleOf', () => {
  it('只认 role === delegated-admin;显示名截 120', () => {
    expect(delegatedRoleOf({ ok: true })).toBeNull()
    expect(delegatedRoleOf(null)).toBeNull()
    expect(delegatedRoleOf({ role: 'owner', operator: { name: 'x' } })).toBeNull()
    expect(delegatedRoleOf({ role: 'delegated-admin' })).toEqual({ name: '' })
    expect(delegatedRoleOf({ role: 'delegated-admin', operator: { name: 'a'.repeat(200) } })!.name).toHaveLength(120)
  })
})

describe('installUnitShim · 委托管理员', () => {
  it('设角色键,只发 whoami 与 unit/config;不挂文件桥、不给本机面', async () => {
    whoami = { ok: true, role: 'delegated-admin', operator: { name: 'Alex' } }
    expect(await installUnitShim()).toBe(true)
    const w = (globalThis as any).window
    expect(w.tangu.delegatedAdmin).toEqual({ name: 'Alex' })
    expect(w.tangu.unitPage).toBe(true)
    expect(w.tangu.remoteCaller).toBe(true)
    expect(w.tangu.hostFiles).toBe(false)
    expect(w.amadeus).toBeUndefined()
    for (const k of ['backendStatus', 'listProviders', 'readHostFile', 'listDir', 'spacesList']) expect(w.tangu[k], k).toBeUndefined()
    await w.tangu.setConfig({ theme: 'dark' })
    expect(hits).toEqual([{ method: 'GET', path: '/web/unit/whoami' }, { method: 'GET', path: '/web/unit/config' }, { method: 'GET', path: '/web/unit/config' }].slice(0, hits.length))
    expect(hits.every((h) => h.method === 'GET' && (h.path === '/web/unit/whoami' || h.path === '/web/unit/config'))).toBe(true)
  })
  it('负对照:whoami 不带 role → 照旧挂文件桥(会去要资源令牌)', async () => {
    whoami = { ok: true }
    expect(await installUnitShim()).toBe(true)
    const w = (globalThis as any).window
    expect(w.tangu.delegatedAdmin).toBeUndefined()
    expect(w.amadeus).toBeTruthy()
    expect(hits.some((h) => h.path === '/web/vault/asset-token')).toBe(true)
  })
})

describe('被拒是 403,不进 401 的整页重载', () => {
  it('文件桥上 403 LOCAL_ONLY 抛错但不调 onAuthError;401 才调', async () => {
    const onAuthError = vi.fn()
    const bridge = await createUnitAmadeusBridge({ base: 'http://unit.test/web/', getToken: () => 'tunnel', onAuthError })
    await expect(bridge.listPages()).rejects.toThrow()
    expect(onAuthError).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(bridge.listPages()).rejects.toThrow()
    expect(onAuthError).toHaveBeenCalledTimes(1)
  })
})
