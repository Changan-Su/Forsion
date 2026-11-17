/**
 * Unit 网页垫片在委托管理员角色下(web/src/unitShim.ts):
 *   · whoami 回包带 role → window.tangu.delegatedAdmin;不挂文件桥(vault/asset-token、events、rpc 一条不发),
 *     不给 backendStatus(unit/meta)、listProviders / 主机文件 / spacesList,setConfig 不 PUT;
 *   · 白名单外的请求被拒是 403,不触发 401 那条「清令牌 + 整页重载」(文件桥上 403 不调 onAuthError);
 *   · 别的来路(whoami 不带 role)照旧挂桥;
 *   · 身份读不准(502 / 超时 / 回包不是 JSON / role 不认识)→ 抛错停在启动失败页:不设 window.tangu、不写任何本地存储、
 *     除了给 whoami 用的配对令牌键之外什么也不读 —— 只在经云端中转打开的页面上(管理员只可能从这条来路进来);
 *   · 局域网 / 本机直接打开:whoami 的各种失败照改动前的走法(网络失败进配对流、502 / 畸形照常启动、不认 role、无超时)。
 * 跑:cd desktop && npx vitest run frontend/src/unitShimDelegated.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WHOAMI_TIMEOUT_MS, installUnitShim, openedViaRelay, whoamiVerdict } from '../../../web/src/unitShim'
import { createUnitAmadeusBridge } from '../../../web/src/amadeus/unitBridge'

const UID = '0f8fad5b-d9cb-469f-a165-70867728950e'
/** 真环境的中转页:Unit 带 `/web/` 投影基址 */
const RELAY = `https://cloud.test/api/units/${UID}/proxy/web/`
/** 桌面托管的设备:没有投影基址 */
const RELAY_BARE = `https://cloud.test/api/units/${UID}/proxy/`
const LAN = 'http://unit.test/web/'
let pageBase = RELAY
vi.mock('../../../web/src/unitOwnerAccess', () => ({ ownerAccess: vi.fn(async () => null) }))
const { ownerAccess } = await import('../../../web/src/unitOwnerAccess')
let whoamiFails = false
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
  whoamiFails = false
  vi.mocked(ownerAccess).mockClear()
  vi.stubGlobal('window', { __FORSION_UNIT_PAGE__: { instanceId: 'u1', name: 'Studio Mac', version: '1', projection: 'local', localCapabilities: { vault: true, engine: true, host: true } }, addEventListener: () => {} })
  const b = new URL(pageBase)
  vi.stubGlobal('document', { baseURI: pageBase, title: '' })
  vi.stubGlobal('location', { hash: '', pathname: b.pathname, search: '', href: pageBase, origin: b.origin, reload: vi.fn() })
  vi.stubGlobal('history', { replaceState: () => {} })
  vi.stubGlobal('sessionStorage', store('session'))
  vi.stubGlobal('localStorage', store('local'))
  vi.stubGlobal('EventSource', class { close() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = '/' + url.pathname.slice(new URL(pageBase).pathname.length)
    hits.push({ method: (init?.method || 'GET').toUpperCase(), path })
    if (path === '/unit/whoami') {
      if (whoamiFails) throw new TypeError('Failed to fetch')
      if (whoamiRaw === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      if (whoamiRaw) return new Response(whoamiRaw.text, { status: whoamiRaw.status })
      return new Response(JSON.stringify(whoami))
    }
    if (path === '/unit/config') return new Response(JSON.stringify({ config: {} }))
    if (path === '/vault/asset-token') return new Response(JSON.stringify({ token: 'at', ttlSec: 600 }))
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

describe('openedViaRelay', () => {
  it('只认中转地址 /api/units/<uuid>/proxy/(带不带投影基址、深链、云端带路径前缀都认)', () => {
    expect(openedViaRelay(RELAY)).toBe(true)
    expect(openedViaRelay(RELAY_BARE)).toBe(true)
    expect(openedViaRelay(`${RELAY}space/agents`)).toBe(true)
    expect(openedViaRelay(`https://cloud.test/forsion/api/units/${UID}/proxy/web/`)).toBe(true)
    expect(openedViaRelay(`https://cloud.test/api/units/${UID.toUpperCase()}/proxy/web/`)).toBe(false) // id 必须是小写 uuid
    expect(openedViaRelay('https://cloud.test/api/units/../proxy/web/')).toBe(false)
    expect(openedViaRelay(`https://cloud.test/api/units/${UID}/web/`)).toBe(false)
    expect(openedViaRelay(LAN)).toBe(false)
    expect(openedViaRelay('http://127.0.0.1:8792/')).toBe(false)
    expect(openedViaRelay('https://cloud.test/api/units/not-a-uuid/proxy/')).toBe(false)
    expect(openedViaRelay('https://cloud.test/api/units/0f8fad5b-d9cb-469f-a165-70867728950e/')).toBe(false)
  })
})

describe.each([['带 /web/ 投影基址', RELAY], ['不带投影基址(桌面托管)', RELAY_BARE]])('installUnitShim · 经中转打开(%s)时身份读不准就停', (_name, relayBase) => {
  beforeEach(() => {
    pageBase = relayBase
    const b = new URL(pageBase)
    vi.stubGlobal('document', { baseURI: pageBase, title: '' })
    vi.stubGlobal('location', { hash: '', pathname: b.pathname, search: '', href: pageBase, origin: b.origin, reload: vi.fn() })
  })
  afterEach(() => { pageBase = RELAY })
  const stopped = async (): Promise<void> => {
    await expect(installUnitShim()).rejects.toThrow(/identity/)
    const w = (globalThis as any).window
    expect(w.tangu).toBeUndefined()
    expect(w.amadeus).toBeUndefined()
    expect(hits).toEqual([{ method: 'GET', path: '/unit/whoami' }])
    // 只读了给 whoami 用的配对令牌键;一条写都没有
    expect(storageOps).toEqual(['session.get unit_owner_u1'])
  }
  it('网络失败', async () => { whoamiFails = true; await stopped() })
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
    expect(hits).toEqual([{ method: 'GET', path: '/unit/whoami' }, { method: 'GET', path: '/unit/config' }, { method: 'GET', path: '/unit/config' }].slice(0, hits.length))
    expect(hits.every((h) => h.method === 'GET' && (h.path === '/unit/whoami' || h.path === '/unit/config'))).toBe(true)
  })
  it('负对照:whoami 不带 role → 照旧挂文件桥(会去要资源令牌)', async () => {
    whoami = { ok: true }
    expect(await installUnitShim()).toBe(true)
    const w = (globalThis as any).window
    expect(w.tangu.delegatedAdmin).toBeUndefined()
    expect(w.amadeus).toBeTruthy()
    expect(hits.some((h) => h.path === '/vault/asset-token')).toBe(true)
  })
})

describe('installUnitShim · 局域网 / 本机直接打开:与改动前一致', () => {
  beforeEach(() => { pageBase = LAN })
  afterEach(() => { pageBase = RELAY })
  // beforeEach 顺序:外层先跑(按当时的 pageBase 装了 RELAY 的桩),这里换基址后重装一遍 document / location
  beforeEach(() => {
    const b = new URL(pageBase)
    vi.stubGlobal('document', { baseURI: pageBase, title: '' })
    vi.stubGlobal('location', { hash: '', pathname: b.pathname, search: '', href: pageBase, origin: b.origin, reload: vi.fn() })
  })
  it('whoami 网络失败 → 进配对流程(主人进入)', async () => {
    whoamiFails = true
    expect(await installUnitShim()).toBe(false) // ownerAccess 桩返回 null = 用户没完成
    expect(ownerAccess).toHaveBeenCalledTimes(1)
  })
  it('502 → 照常启动(挂文件桥)', async () => {
    whoamiRaw = { status: 502, text: 'Bad gateway' }
    expect(await installUnitShim()).toBe(true)
    expect((globalThis as any).window.amadeus).toBeTruthy()
    expect(ownerAccess).not.toHaveBeenCalled()
  })
  it('200 但回包不是 JSON → 照常启动', async () => {
    whoamiRaw = { status: 200, text: '<html>oops' }
    expect(await installUnitShim()).toBe(true)
    expect((globalThis as any).window.amadeus).toBeTruthy()
  })
  it('回包带管理员 role 也不认(管理员只可能经中转来)', async () => {
    whoami = { ok: true, role: 'delegated-admin', operator: { name: 'Alex' } }
    expect(await installUnitShim()).toBe(true)
    expect((globalThis as any).window.tangu.delegatedAdmin).toBeUndefined()
    expect((globalThis as any).window.amadeus).toBeTruthy()
  })
  it('请求挂住:没有超时(15s 后仍在等)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      whoamiRaw = 'hang'
      let settled = false
      void installUnitShim().then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(WHOAMI_TIMEOUT_MS * 2)
      expect(settled).toBe(false)
    } finally { vi.useRealTimers() }
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
