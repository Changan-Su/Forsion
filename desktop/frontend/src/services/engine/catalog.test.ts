// P1-K6 S2 · 按目标的目录缓存(R-18):5 分钟缓存、force、同目标并发只拉一次、单项失败保留旧值、appStore 局部记入。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let fail = new Set<string>()
let agentsSeq = 0
const authFetch = vi.fn(async (url: string) => {
  const path = new URL(url).pathname
  const key = path.replace(/^.*\/agent\//, '')
  if ([...fail].some((f) => key.startsWith(f))) return new Response('{}', { status: 500 })
  if (key.startsWith('models')) return new Response(JSON.stringify({ models: [{ id: 'm', name: 'M' }], defaultModelId: 'm' }), { status: 200 })
  if (key === 'agents') return new Response(JSON.stringify({ agents: [{ slug: `a${++agentsSeq}`, name: 'A' }] }), { status: 200 })
  if (key.startsWith('agents-meta')) return new Response(JSON.stringify({ defaultSlug: 'a1' }), { status: 200 })
  if (key.startsWith('skills')) return new Response(JSON.stringify({ skills: [] }), { status: 200 })
  return new Response('{}', { status: 200 })
})
vi.mock('../http', () => ({ authFetch: (url: string) => authFetch(url) }))

const C = await import('./catalog')
const T = await import('./targets')
const U = '7f0e8a52-0000-4000-8000-00000000000a'
const API = 'https://api.forsion.test/api'
const KEY = `unit:${U}` as const

beforeEach(() => {
  authFetch.mockClear()
  fail = new Set()
  agentsSeq = 0
  C.forgetCatalog()
  T.resetFocusForTests()
  vi.stubGlobal('window', { tangu: { mobile: true } })
  T.installEngineHost({ cfg: () => ({ backendUrl: API, token: 'tk', modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('catalogFor / ensureCatalog', () => {
  it('没有 → null;拉一次后命中缓存 5 分钟,过期或 force 再拉', async () => {
    expect(C.catalogFor(KEY)).toBeNull()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const a = await C.ensureCatalog(KEY)
    expect(a?.agents.map((x) => x.slug)).toEqual(['a1'])
    expect(a?.models?.defaultModelId).toBe('m')
    expect(authFetch.mock.calls.every((c) => String(c[0]).startsWith(`${API}/units/${U}/proxy/engine/agent/`))).toBe(true)
    const n = authFetch.mock.calls.length
    vi.spyOn(Date, 'now').mockReturnValue(now + C.CATALOG_TTL_MS - 1)
    expect(await C.ensureCatalog(KEY)).toBe(a) // 缓存命中,不再打
    expect(authFetch.mock.calls.length).toBe(n)
    vi.spyOn(Date, 'now').mockReturnValue(now + C.CATALOG_TTL_MS + 1)
    expect((await C.ensureCatalog(KEY))?.agents.map((x) => x.slug)).toEqual(['a2'])
    expect((await C.ensureCatalog(KEY, { force: true }))?.agents.map((x) => x.slug)).toEqual(['a3'])
  })

  it('同一目标并发只拉一次', async () => {
    const [a, b] = await Promise.all([C.ensureCatalog(KEY), C.ensureCatalog(KEY)])
    expect(a).toBe(b)
    expect(authFetch.mock.calls.filter((c) => String(c[0]).endsWith('/agent/agents')).length).toBe(1)
  })

  it('单项失败保留旧值(模型 / 技能没拉到不清空;Agent 列表按 listAgents 自己的口径失败即空表)', async () => {
    await C.ensureCatalog(KEY)
    fail = new Set(['models', 'skills'])
    const again = await C.ensureCatalog(KEY, { force: true })
    expect(again?.models?.defaultModelId).toBe('m')
    expect(again?.skills).toEqual([])
    expect(again?.agents.map((x) => x.slug)).toEqual(['a2'])
  })

  it('rememberCatalog 局部记入、不收头像;forgetCatalog 清一格', () => {
    C.rememberCatalog('home', { agents: [{ slug: 'h', name: 'H' } as never] })
    C.rememberCatalog('home', { defaultAgentSlug: 'h' })
    expect(C.catalogFor('home')).toMatchObject({ agents: [{ slug: 'h' }], defaultAgentSlug: 'h' })
    expect(C.catalogFor('home')?.avatars).toBeUndefined()
    C.forgetCatalog('home')
    expect(C.catalogFor('home')).toBeNull()
  })

  it('目标解析不出来(桌面上问 unit)→ null,不外呼', async () => {
    vi.stubGlobal('window', { tangu: {} })
    expect(await C.ensureCatalog(KEY)).toBeNull()
    expect(authFetch).not.toHaveBeenCalled()
  })
})
