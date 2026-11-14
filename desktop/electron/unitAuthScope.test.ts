/**
 * 设备页补登录头的范围(unitAuthScope.ts):判定矩阵 + 绑定处理器。
 */
import { describe, expect, it, vi } from 'vitest'
import { adoptFromOpenGrant, createUnitFrameScope, createUnitOpenGrants, grantUrlKey, UNIT_OPEN_GRANT_TTL_MS, handleUnitFrameBind, normalizeCloudBase, shouldInjectUnitAuth, unitAllowedPrefixes, urlInPrefixes, type UnitFrameBinding, type UnitFrameBindDeps } from './unitAuthScope'

const CLOUD = 'https://api.example.test'
const A = '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c'
const B = '8b1d0c2e-1111-4e8a-9c21-000000000002'
const ACCT = 'user-1'
const bound: UnitFrameBinding = { unitId: A, accountKey: ACCT, cloudBase: CLOUD }

const decide = (url: string, over: Partial<Parameters<typeof shouldInjectUnitAuth>[0]> = {}): boolean =>
  shouldInjectUnitAuth({ url, binding: bound, accountKey: ACCT, cloudBase: CLOUD, secFetchSite: 'same-origin', ...over })

describe('shouldInjectUnitAuth', () => {
  it('已绑定那台的 proxy 路径 → 补(文档、子资源、接口、带查询串)', () => {
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`)).toBe(true)
    expect(decide(`${CLOUD}/api/units/${A}/proxy/assets/app.js`)).toBe(true)
    expect(decide(`${CLOUD}/api/units/${A}/proxy/agent/runs?x=1`)).toBe(true)
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { secFetchSite: 'none' })).toBe(true)
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { secFetchSite: '' })).toBe(true)
  })

  it('别台的 proxy → 不补', () => {
    expect(decide(`${CLOUD}/api/units/${B}/proxy/`)).toBe(false)
    expect(decide(`${CLOUD}/api/units/${B}/proxy/agent/runs`)).toBe(false)
  })

  it('名册与管理接口 → 不补(列表、改 / 删别台、改 / 删自己、调用方凭据、通道、caps、open / session)', () => {
    for (const u of [
      `${CLOUD}/api/units`, `${CLOUD}/api/units/`, `${CLOUD}/api/units?all=1`,
      `${CLOUD}/api/units/${B}`, `${CLOUD}/api/units/${A}`,
      `${CLOUD}/api/units/${B}/caller-token`, `${CLOUD}/api/units/${A}/caller-token`, `${CLOUD}/api/units/${A}/caller-secret`,
      `${CLOUD}/api/units/${A}/channel`, `${CLOUD}/api/units/${A}/caps`, `${CLOUD}/api/units/${A}/attention`,
      `${CLOUD}/api/units/${A}/open`, `${CLOUD}/api/units/${A}/session`, `${CLOUD}/api/units/register`,
      `${CLOUD}/api/units/${A}/proxy`, // 没有尾斜杠:服务端路由是 proxy/*
      `${CLOUD}/api/brain/users/me`,
    ]) expect(decide(u), u).toBe(false)
  })

  it('没绑定的 webContents(同分区的普通标签页 / Service Worker)→ 不补', () => {
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { binding: undefined })).toBe(false)
  })

  it('换号 / 登出 / 换云端之后 → 不补', () => {
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { accountKey: 'user-2' })).toBe(false)
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { accountKey: null })).toBe(false)
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { cloudBase: 'https://other.example.test' })).toBe(false)
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { cloudBase: null })).toBe(false)
  })

  it('第三方页发起(cross-site / same-site)→ 不补', () => {
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { secFetchSite: 'cross-site' })).toBe(false)
    expect(decide(`${CLOUD}/api/units/${A}/proxy/`, { secFetchSite: 'same-site' })).toBe(false)
  })

  it('前缀混淆 → 不补', () => {
    for (const u of [
      `${CLOUD}/api/units/${A}x/proxy/`, // id 后面多字符
      `${CLOUD}/api/units/${A.slice(0, -1)}/proxy/`, // id 是前缀
      `${CLOUD}/api/units/${A}/../${B}/proxy/`, // 点段(解析后落到别台)
      `${CLOUD}/api/units/${A}/proxy/../../${B}/proxy/`,
      `${CLOUD}/api/units/${A}/proxy/%2e%2e/%2e%2e/${B}/proxy/`, // 编码的点段(URL 解析当 .. 处理)
      `${CLOUD}/api/units/${A}/proxy/..%2f..%2f${B}%2fproxy%2f`, // 解码后才冒出来的上跳
      `${CLOUD}/api/units/${A}/proxy/x%5c..%5c..%5c${B}`, // 编码的反斜杠
      `${CLOUD}/api/units/${A}/proxy/%E0%A4%A`, // 坏的百分号编码
      `${CLOUD}/api/units/${A}%2Fproxy/`, // 编码的分隔符
      `${CLOUD}/api/units/%33f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c/proxy/`, // id 被编码
      `${CLOUD}/API/units/${A}/proxy/`, `${CLOUD}/api/Units/${A}/proxy/`, `${CLOUD}/api/units/${A.toUpperCase()}/proxy/`, `${CLOUD}/api/units/${A}/PROXY/`, // 大小写
      `${CLOUD}//api/units/${A}/proxy/`, `${CLOUD}/api//units/${A}/proxy/`, `${CLOUD}/api/units//${A}/proxy/`, `${CLOUD}/api/units/${A}//proxy/`, // 多余斜杠
      `${CLOUD}/api/units/${B}/proxy/?next=/api/units/${A}/proxy/`, // 查询串里带路径
      `${CLOUD}/api/units?x=/api/units/${A}/proxy/`,
      `${CLOUD}/api/units/${B}/proxy/#/api/units/${A}/proxy/`,
      `https://api.example.test.evil.test/api/units/${A}/proxy/`, `https://evil.test/api/units/${A}/proxy/`, // 别的主机
      `http://api.example.test/api/units/${A}/proxy/`, `https://api.example.test:8443/api/units/${A}/proxy/`, // 别的协议 / 端口
      `https://user:pw@api.example.test/api/units/${A}/proxy/`, // 带凭据
      'not a url',
    ]) expect(decide(u), u).toBe(false)
  })

  it('主机名大小写、默认端口由 URL 解析规整后照常匹配', () => {
    expect(decide(`https://API.Example.TEST/api/units/${A}/proxy/`)).toBe(true)
    expect(decide(`https://api.example.test:443/api/units/${A}/proxy/x`)).toBe(true)
  })
})

describe('前缀与云端地址', () => {
  it('unitAllowedPrefixes:今天只有中转 proxy/;id 不合法 = 空', () => {
    expect(unitAllowedPrefixes(CLOUD, A)).toEqual([`${CLOUD}/api/units/${A}/proxy/`])
    expect(unitAllowedPrefixes(CLOUD, '../x')).toEqual([])
    expect(unitAllowedPrefixes(CLOUD, 'short')).toEqual([])
  })
  it('normalizeCloudBase:去尾斜杠、保留路径前缀;非 http(s) / 带凭据 / 解析不了 = null', () => {
    expect(normalizeCloudBase('https://api.example.test/')).toBe(CLOUD)
    expect(normalizeCloudBase('https://API.example.test:443')).toBe(CLOUD)
    expect(normalizeCloudBase('https://h.test/forsion//')).toBe('https://h.test/forsion')
    expect(normalizeCloudBase('file:///x')).toBeNull()
    expect(normalizeCloudBase('https://u:p@h.test')).toBeNull()
    expect(normalizeCloudBase('')).toBeNull()
    expect(normalizeCloudBase('::')).toBeNull()
  })
  it('云端地址带路径前缀时也按整段比', () => {
    const base = 'https://h.test/forsion'
    expect(urlInPrefixes(`${base}/api/units/${A}/proxy/`, unitAllowedPrefixes(base, A))).toBe(true)
    expect(urlInPrefixes(`https://h.test/api/units/${A}/proxy/`, unitAllowedPrefixes(base, A))).toBe(false)
  })
})

describe('handleUnitFrameBind', () => {
  const deps = (over: Partial<UnitFrameBindDeps> = {}): UnitFrameBindDeps & { bind: ReturnType<typeof vi.fn> } => ({
    trusted: true,
    guestAlive: () => true,
    accountKey: () => ACCT,
    cloudBase: () => CLOUD,
    readRoster: async () => ({ ok: true, units: [{ id: A }, { id: B }] }),
    bind: vi.fn(),
    ...over,
  }) as UnitFrameBindDeps & { bind: ReturnType<typeof vi.fn> }

  it('名册里有这台 → 绑定(账号 / 云端取发起时的)', async () => {
    const d = deps()
    expect(await handleUnitFrameBind(A, d)).toEqual({ ok: true })
    expect(d.bind).toHaveBeenCalledWith({ unitId: A, accountKey: ACCT, cloudBase: CLOUD })
  })
  it('发起方不可信 → 拒,名册都不读', async () => {
    const readRoster = vi.fn()
    const d = deps({ trusted: false, readRoster })
    expect(await handleUnitFrameBind(A, d)).toEqual({ ok: false, code: 'untrusted' })
    expect(readRoster).not.toHaveBeenCalled()
    expect(d.bind).not.toHaveBeenCalled()
  })
  it('id 不过正则 → not_found,名册都不读', async () => {
    for (const id of ['short', `${A}/../${B}`, `${A}?`, 42, null, undefined, 'x'.repeat(65)]) {
      const readRoster = vi.fn()
      const d = deps({ readRoster })
      expect(await handleUnitFrameBind(id, d)).toEqual({ ok: false, code: 'not_found' })
      expect(readRoster).not.toHaveBeenCalled()
    }
  })
  it('名册里没有 → not_found;名册读失败 / 抛错 = 不知道 → 不绑定', async () => {
    const gone = 'aaaaaaaa-0000-4000-8000-000000000009'
    let d = deps()
    expect(await handleUnitFrameBind(gone, d)).toEqual({ ok: false, code: 'not_found' })
    d = deps({ readRoster: async () => ({ ok: false, code: 'roster_unavailable' }) })
    expect(await handleUnitFrameBind(A, d)).toEqual({ ok: false, code: 'roster_unavailable' })
    expect(d.bind).not.toHaveBeenCalled()
    d = deps({ readRoster: async () => { throw new Error('net') } })
    expect(await handleUnitFrameBind(A, d)).toEqual({ ok: false, code: 'roster_unavailable' })
    d = deps({ readRoster: async () => ({ ok: false, code: 'signed_out' }) })
    expect(await handleUnitFrameBind(A, d)).toEqual({ ok: false, code: 'signed_out' })
    expect(d.bind).not.toHaveBeenCalled()
  })
  it('没登录 / 云端地址不知道 → 不读名册', async () => {
    const readRoster = vi.fn()
    expect(await handleUnitFrameBind(A, deps({ accountKey: () => null, readRoster }))).toEqual({ ok: false, code: 'signed_out' })
    expect(await handleUnitFrameBind(A, deps({ cloudBase: () => null, readRoster }))).toEqual({ ok: false, code: 'roster_unavailable' })
    expect(readRoster).not.toHaveBeenCalled()
  })
  it('名册回来时换了号 / 换了云端 → account_changed;webview 已经没了 → gone', async () => {
    let acct = ACCT
    let d = deps({ accountKey: () => acct, readRoster: async () => { acct = 'user-2'; return { ok: true, units: [{ id: A }] } } })
    expect(await handleUnitFrameBind(A, d)).toEqual({ ok: false, code: 'account_changed' })
    expect(d.bind).not.toHaveBeenCalled()
    let cloud = CLOUD
    d = deps({ cloudBase: () => cloud, readRoster: async () => { cloud = 'https://other.test'; return { ok: true, units: [{ id: A }] } } })
    expect(await handleUnitFrameBind(A, d)).toEqual({ ok: false, code: 'account_changed' })
    d = deps({ guestAlive: () => false })
    expect(await handleUnitFrameBind(A, d)).toEqual({ ok: false, code: 'gone' })
    expect(d.bind).not.toHaveBeenCalled()
  })
})

describe('createUnitFrameScope', () => {
  it('按 webContents id 存取;unbind / clear 之后取不到;undefined id 取不到', () => {
    const s = createUnitFrameScope()
    s.bind(5, bound)
    s.bind(6, { ...bound, unitId: B })
    expect(s.get(5)).toEqual(bound)
    expect(s.get(undefined)).toBeUndefined()
    s.unbind(5)
    expect(s.get(5)).toBeUndefined()
    expect(s.get(6)?.unitId).toBe(B)
    s.clear()
    expect(s.size()).toBe(0)
  })
  it('全链:绑 A 的 webContents 去打 B / 名册 → 不补;清空(换号)后打 A → 不补', () => {
    const s = createUnitFrameScope()
    s.bind(9, bound)
    const at = (wc: number | undefined, url: string): boolean => shouldInjectUnitAuth({ url, binding: s.get(wc), accountKey: ACCT, cloudBase: CLOUD, secFetchSite: 'same-origin' })
    expect(at(9, `${CLOUD}/api/units/${A}/proxy/`)).toBe(true)
    expect(at(9, `${CLOUD}/api/units/${B}/proxy/`)).toBe(false)
    expect(at(9, `${CLOUD}/api/units/`)).toBe(false)
    expect(at(10, `${CLOUD}/api/units/${A}/proxy/`)).toBe(false)
    s.clear()
    expect(at(9, `${CLOUD}/api/units/${A}/proxy/`)).toBe(false)
  })
})

describe('设备页自己开的窗口:一次性许可', () => {
  const own = `${CLOUD}/api/units/${A}/proxy/?view=chat&popout=1`
  const mk = () => { let t = 1000; const g = createUnitOpenGrants(() => t); return { g, tick: (ms: number) => { t += ms } } }
  const adopt = (g: ReturnType<typeof createUnitOpenGrants>, url: string, over: Partial<Parameters<typeof adoptFromOpenGrant>[1]> = {}) =>
    adoptFromOpenGrant(g, { url, isMainFrame: true, isGuest: true, alreadyBound: false, firstMainFrame: true, accountKey: ACCT, cloudBase: CLOUD, ...over })

  it('已绑定的页面开自己中转下的地址 → 发许可;新 webview 主框架第一次请求恰好这个地址 → 绑到同一台;只能用一次', () => {
    const { g } = mk()
    expect(g.issue(bound, own, ACCT, CLOUD)).toBe(true)
    expect(adopt(g, own)).toEqual(bound)
    expect(adopt(g, own)).toBeUndefined()
    expect(g.size()).toBe(0)
  })
  it('片段不上网络:开的地址带 #,请求里没有 → 认;主机名大小写规整后相等 → 认', () => {
    const { g } = mk()
    g.issue(bound, `${own}#tab=2`, ACCT, CLOUD)
    expect(adopt(g, own)).toEqual(bound)
    g.issue(bound, own.replace('api.example.test', 'API.example.test'), ACCT, CLOUD)
    expect(adopt(g, own)).toEqual(bound)
  })
  it('目标不在这台自己的前缀里 → 不发许可(别台的中转、名册接口、管理接口、外站、混淆路径)', () => {
    const { g } = mk()
    for (const u of [
      `${CLOUD}/api/units/${B}/proxy/`, `${CLOUD}/api/units`, `${CLOUD}/api/units/`, `${CLOUD}/api/units/${A}`,
      `${CLOUD}/api/units/${A}/caller-token`, `${CLOUD}/api/units/${A}/open`, 'https://evil.test/', `${CLOUD}/api/units/${A}/proxy/..%2f..%2f${B}`,
      `${CLOUD}/api/units/${B}/proxy/?next=/api/units/${A}/proxy/`, 'not a url',
    ]) expect(g.issue(bound, u, ACCT, CLOUD), u).toBe(false)
    expect(g.size()).toBe(0)
  })
  it('发起页没绑定 / 账号或云端已经变了 → 不发', () => {
    const { g } = mk()
    expect(g.issue(undefined, own, ACCT, CLOUD)).toBe(false)
    expect(g.issue(bound, own, 'user-2', CLOUD)).toBe(false)
    expect(g.issue(bound, own, null, CLOUD)).toBe(false)
    expect(g.issue(bound, own, ACCT, 'https://other.test')).toBe(false)
    expect(g.size()).toBe(0)
  })
  it('过期 → 不认', () => {
    const { g, tick } = mk()
    g.issue(bound, own, ACCT, CLOUD)
    tick(UNIT_OPEN_GRANT_TTL_MS + 1)
    expect(adopt(g, own)).toBeUndefined()
  })
  it('地址不完全相等(多一个查询参数、少斜杠、别的路径)→ 不认,许可留着', () => {
    const { g } = mk()
    g.issue(bound, own, ACCT, CLOUD)
    expect(adopt(g, `${own}&x=1`)).toBeUndefined()
    expect(adopt(g, `${CLOUD}/api/units/${A}/proxy/`)).toBeUndefined()
    expect(adopt(g, `${CLOUD}/api/units/${A}/proxy/other`)).toBeUndefined()
    expect(g.size()).toBe(1)
  })
  it('不是主框架 / 不是 webview / 已绑定 / 不是第一次主框架请求 → 不认,也不消耗许可', () => {
    const { g } = mk()
    g.issue(bound, own, ACCT, CLOUD)
    expect(adopt(g, own, { isMainFrame: false })).toBeUndefined()
    expect(adopt(g, own, { isGuest: false })).toBeUndefined()
    expect(adopt(g, own, { alreadyBound: true })).toBeUndefined()
    expect(adopt(g, own, { firstMainFrame: false })).toBeUndefined()
    expect(g.size()).toBe(1)
    expect(adopt(g, own)).toEqual(bound)
  })
  it('换号 / 换云端后消费 → 不认;clear(换号握手)后 → 没有许可', () => {
    const { g } = mk()
    g.issue(bound, own, ACCT, CLOUD)
    expect(adopt(g, own, { accountKey: 'user-2' })).toBeUndefined()
    expect(adopt(g, own, { accountKey: null })).toBeUndefined()
    expect(adopt(g, own, { cloudBase: 'https://other.test' })).toBeUndefined()
    g.clear()
    expect(adopt(g, own)).toBeUndefined()
  })
  it('许可绑的是发起页那台:消费后的绑定照样只给那台补头', () => {
    const { g } = mk()
    g.issue(bound, own, ACCT, CLOUD)
    const b = adopt(g, own)
    expect(shouldInjectUnitAuth({ url: own, binding: b, accountKey: ACCT, cloudBase: CLOUD, secFetchSite: 'none' })).toBe(true)
    expect(shouldInjectUnitAuth({ url: `${CLOUD}/api/units/${B}/proxy/`, binding: b, accountKey: ACCT, cloudBase: CLOUD, secFetchSite: 'same-origin' })).toBe(false)
  })
  it('grantUrlKey:去片段、拒带凭据与解析不了的', () => {
    expect(grantUrlKey(`${own}#x`)).toBe(own)
    expect(grantUrlKey('https://u:p@h.test/')).toBeNull()
    expect(grantUrlKey('::')).toBeNull()
  })
})
