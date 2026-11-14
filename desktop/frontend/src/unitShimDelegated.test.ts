/**
 * Unit 网页垫片在委托管理员角色下(web/src/unitShim.ts):
 *   · whoami 回包带 role → window.tangu.delegatedAdmin;不挂文件桥(vault/asset-token、events、rpc 一条不发),
 *     不给 backendStatus(unit/meta)、listProviders / 主机文件 / spacesList,setConfig 不 PUT;
 *   · 白名单外的请求被拒是 403,不触发 401 那条「清令牌 + 整页重载」(文件桥上 403 不调 onAuthError);
 *   · 别的来路(whoami 不带 role)照旧挂桥;
 *   · 身份读不准(502 / 超时 / 回包不是 JSON / role 不认识)→ 抛错停在启动失败页:不设 window.tangu、不写任何本地存储、
 *     除了给 whoami 用的配对令牌键之外什么也不读。
 * 跑:cd desktop && npx vitest run frontend/src/unitShimDelegated.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WHOAMI_TIMEOUT_MS, installUnitShim, whoamiVerdict } from '../../../web/src/unitShim'
import { createUnitAmadeusBridge } from '../../../web/src/amadeus/unitBridge'

const hits: Array<{ method: string; path: string }> = []
let whoami: Record<string, unknown> = { ok: true }
/** whoami 的整条回包(状态 + 原文);null = 照 whoami 对象回 200。'hang' = 永不回(只认 abort)。 */
let whoamiRaw: { status: number; text: string } | 'hang' | null = null
const storageOps: string[] = []
const store = (name: string): Storage => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => { storageOps.push(`${name}.get ${k}`); return m.get(k) ?? null },
    setItem: (k: string, v: string) => { storageOps.push(`${name}.set ${k}`); m.set(k, v) },
    removeItem: (k: string) => { storageOps.push(`${name}.remove ${k}`); m.delete(k) },
    clear: () => { storageOps.push(`${name}.clear`); m.clear() }, key: () => null, length: 0,
  } as Storage
}

beforeEach(() => {
  hits.length = 0
  storageOps.length = 0
  whoamiRaw = null
  vi.stubGlobal('window', { __FORSION_UNIT_PAGE__: { instanceId: 'u1', name: 'Studio Mac', version: '1', projection: 'local', localCapabilities: { vault: true, engine: true, host: true } }, addEventListener: () => {} })
  vi.stubGlobal('document', { baseURI: 'http://unit.test/web/', title: '' })
  vi.stubGlobal('location', { hash: '', pathname: '/web/', search: '', href: 'http://unit.test/web/', origin: 'http://unit.test', reload: vi.fn() })
  vi.stubGlobal('history', { replaceState: () => {} })
  vi.stubGlobal('sessionStorage', store('session'))
  vi.stubGlobal('localStorage', store('local'))
  vi.stubGlobal('EventSource', class { close() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    hits.push({ method: (init?.method || 'GET').toUpperCase(), path: url.pathname })
    if (url.pathname === '/web/unit/whoami') {
      if (whoamiRaw === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      if (whoamiRaw) return new Response(whoamiRaw.text, { status: whoamiRaw.status })
      return new Response(JSON.stringify(whoami))
    }
    if (url.pathname === '/web/unit/config') return new Response(JSON.stringify({ config: {} }))
    if (url.pathname === '/web/vault/asset-token') return new Response(JSON.stringify({ token: 'at', ttlSec: 600 }))
    return new Response(JSON.stringify({ code: 'LOCAL_ONLY' }), { status: 403 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('whoamiVerdict', () => {
  it('401 = 未配对;{ok:true} 不带 role = 原路径;认得的角色 = 管理员;其余一律「不知道」', () => {
    expect(whoamiVerdict(401, null)).toEqual({ kind: 'unpaired' })
    expect(whoamiVerdict(200, { ok: true })).toEqual({ kind: 'owner' })
    expect(whoamiVerdict(200, { ok: true, role: 'delegated-admin', operator: { name: 'a'.repeat(200) } })).toEqual({ kind: 'delegated', name: 'a'.repeat(120) })
    for (const [status, body] of [[null, null], [502, null], [500, { ok: true }], [403, { ok: true }], [200, undefined], [200, null], [200, []], [200, 'x'],
      [200, { ok: false }], [200, {}], [200, { ok: true, role: 'owner' }], [200, { ok: true, role: 'delegated-admin' }], [200, { ok: true, role: 'delegated-admin', operator: { name: 1 } }]] as const) {
      expect(whoamiVerdict(status, body), JSON.stringify([status, body])).toEqual({ kind: 'unknown' })
    }
  })
})

describe('installUnitShim · 身份读不准就停', () => {
  const stopped = async (): Promise<void> => {
    await expect(installUnitShim()).rejects.toThrow(/identity/)
    const w = (globalThis as any).window
    expect(w.tangu).toBeUndefined()
    expect(w.amadeus).toBeUndefined()
    expect(hits).toEqual([{ method: 'GET', path: '/web/unit/whoami' }])
    // 只读了给 whoami 用的配对令牌键;一条写都没有
    expect(storageOps).toEqual(['session.get unit_owner_u1'])
  }
  it('502', async () => { whoamiRaw = { status: 502, text: 'Bad gateway' }; await stopped() })
  it('200 但回包不是 JSON', async () => { whoamiRaw = { status: 200, text: '<html>oops' }; await stopped() })
  it('200 但 role 不认识', async () => { whoami = { ok: true, role: 'super-admin', operator: { name: 'x' } }; await stopped() })
  it('超时(请求挂住)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      whoamiRaw = 'hang'
      const run = stopped()
      await vi.advanceTimersByTimeAsync(WHOAMI_TIMEOUT_MS + 10)
      await run
    } finally { vi.useRealTimers() }
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
