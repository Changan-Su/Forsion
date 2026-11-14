/**
 * 调用方断言(P1 · K1 §3.3.1)纯函数:签 / 验(全部 reason)、重放表清理、encodeEngineCaller 中文名往返、
 * callerOf / callerPrincipal(R-09:P2P 不高于配对)、/unit/mcp* 不签的规整判据;
 * makeCallerHeaders(隧道那一跳的签发策略,2026-09-28 随 UnitHost 搬进 Forsion Extend 时从 unitHost.test 的 K1 S7 / S8 挪来)。
 * 跑法:npx vitest run electron/unitCaller.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  callerOf, callerPrincipal, encodeEngineCaller, gcSeenCallers, makeCallerHeaders, proxyAssertionAllowed, sanitizeProxyCaller, sanitizeProxyOperator, signProxyCaller, verifyProxyCaller,
  type ProxyCaller, type ProxyOperator,
} from './unitCaller'

const KEY = 'k'.repeat(64)
const PHONE: ProxyCaller = { unit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', kind: 'phone', name: '小米 14 Pro', platform: 'android', registeredAt: '2026-09-28T01:02:03.000Z' }
const REQ = { method: 'POST', url: '/engine/agent/runs?x=1' }
const sign = (over: Partial<Parameters<typeof signProxyCaller>[1]> = {}, key = KEY) =>
  signProxyCaller(key, { dispatchId: 'd-1', method: 'POST', target: '/engine/agent/runs?x=1', caller: PHONE, nowMs: 1_000_000, ...over })
/** 用真钥给任意 payload 签(证「MAC 对但内容不对」的分支)。 */
function signRaw(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `v1.${body}.${createHmac('sha256', KEY).update('v1.' + body).digest('base64url')}`
}

describe('unitCaller', () => {
  it('往返:签出的断言在同方法 / 同目标 / 60s 窗内验过,调用方原样回来', () => {
    const seen = new Map<string, number>()
    const r = verifyProxyCaller(KEY, sign(), REQ, seen, 1_000_000 + 59_000)
    expect(r).toEqual({ ok: true, caller: PHONE, operator: null, dispatchId: 'd-1' })
    expect(seen.get('d-1')).toBe(1_000_000 + 59_000 + 120_000)
  })

  it('每一种失败都有自己的 reason;失败不写重放表', () => {
    const seen = new Map<string, number>()
    const now = 1_000_000
    expect(verifyProxyCaller('x'.repeat(64), sign(), REQ, seen, now)).toEqual({ ok: false, reason: 'bad-mac' })
    expect(verifyProxyCaller(KEY, sign(), { ...REQ, method: 'GET' }, seen, now)).toEqual({ ok: false, reason: 'method' })
    expect(verifyProxyCaller(KEY, sign(), { ...REQ, url: '/engine/agent/runs?x=2' }, seen, now)).toEqual({ ok: false, reason: 'target' })
    expect(verifyProxyCaller(KEY, sign(), REQ, seen, now + 60_001)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyProxyCaller(KEY, sign(), REQ, seen, now - 60_001)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyProxyCaller(KEY, signRaw({ pur: 'mcp', d: 'd', m: 'POST', t: REQ.url, c: PHONE, iat: now }), REQ, seen, now)).toEqual({ ok: false, reason: 'purpose' })
    expect(verifyProxyCaller(KEY, signRaw({ pur: 'proxy', d: 'd', m: 'POST', t: REQ.url, c: { ...PHONE, unit: 'nope' }, iat: now }), REQ, seen, now)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyProxyCaller(KEY, signRaw({ pur: 'proxy', d: '', m: 'POST', t: REQ.url, c: PHONE, iat: now }), REQ, seen, now)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyProxyCaller(KEY, signRaw({ pur: 'proxy', d: 'd', m: 'POST', t: REQ.url, c: PHONE, iat: 'now' }), REQ, seen, now)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyProxyCaller(KEY, signRaw([1]), REQ, seen, now)).toEqual({ ok: false, reason: 'malformed' })
    for (const bad of ['', 'v1.', 'v2.a.b', 'v1.a.b.c', 'v1.a', 'v1.@@.b', sign().slice(0, -3), `${sign()}, ${sign()}`]) {
      expect(verifyProxyCaller(KEY, bad, REQ, seen, now).ok, bad.slice(0, 30)).toBe(false)
    }
    expect(verifyProxyCaller('', sign(), REQ, seen, now)).toEqual({ ok: false, reason: 'malformed' })
    expect(seen.size).toBe(0)
  })

  it('同一个派发 id 只能用一次(重放);过期后 gc 清掉', () => {
    const seen = new Map<string, number>()
    expect(verifyProxyCaller(KEY, sign(), REQ, seen, 1_000_000).ok).toBe(true)
    expect(verifyProxyCaller(KEY, sign(), REQ, seen, 1_000_001)).toEqual({ ok: false, reason: 'replay' })
    // 换一个 iat 重签同一个 d 也不行(重放表按 d 记,不按整串)
    expect(verifyProxyCaller(KEY, sign({ nowMs: 1_000_500 }), REQ, seen, 1_000_600)).toEqual({ ok: false, reason: 'replay' })
    expect(verifyProxyCaller(KEY, sign({ dispatchId: 'd-2' }), REQ, seen, 1_000_001).ok).toBe(true)
    gcSeenCallers(seen, 1_000_000 + 119_999)
    expect([...seen.keys()].sort()).toEqual(['d-1', 'd-2'])
    gcSeenCallers(seen, 1_000_001 + 120_000)
    expect(seen.size).toBe(0)
  })

  it('sanitizeProxyCaller:uuid / kind 必须过;名字剥控制符、零宽与双向覆写并截 120;平台 / 登记时间截 40', () => {
    expect(sanitizeProxyCaller(PHONE)).toEqual(PHONE)
    expect(sanitizeProxyCaller({ ...PHONE, unit: PHONE.unit.toUpperCase() })?.unit).toBe(PHONE.unit)
    for (const bad of [null, 'x', [PHONE], { ...PHONE, unit: 'x' }, { ...PHONE, kind: 'server' }, { ...PHONE, kind: undefined }]) {
      expect(sanitizeProxyCaller(bad)).toBeNull()
    }
    const weird = sanitizeProxyCaller({ ...PHONE, name: `Pix\u0000el‮​ 9 ${'x'.repeat(200)}`, platform: 'a'.repeat(99), registeredAt: 5 })!
    expect(weird.name.startsWith('Pixel 9 ')).toBe(true)
    expect(weird.name.length).toBe(120)
    expect(weird.platform).toBe('a'.repeat(40))
    expect(weird.registeredAt).toBeNull()
    expect(sanitizeProxyCaller({ unit: PHONE.unit, kind: 'desktop' })).toEqual({ unit: PHONE.unit, kind: 'desktop', name: '', platform: null, registeredAt: null })
  })

  it('encodeEngineCaller:ASCII 安全的 b64url,中文名往返不丢字', () => {
    const h = encodeEngineCaller(PHONE)
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))).toEqual({ u: PHONE.unit, k: 'phone', n: '小米 14 Pro', p: 'android', r: PHONE.registeredAt })
  })

  it('callerOf / callerPrincipal:隧道 + 断言 = unit;隧道无断言 = account;配对 = lan;P2P 单列,断言在别的来路不作数', () => {
    expect(callerOf('tunnel', null, PHONE)).toEqual({ kind: 'unit', caller: PHONE })
    expect(callerPrincipal(callerOf('tunnel', null, PHONE))).toBe(`unit:${PHONE.unit}`)
    expect(callerOf('tunnel', null, null)).toEqual({ kind: 'account' })
    expect(callerPrincipal({ kind: 'account' })).toBe('account')
    expect(callerOf('lan', { pairId: 'p1', name: 'iPad' }, null)).toEqual({ kind: 'paired', pairId: 'p1', name: 'iPad' })
    expect(callerPrincipal(callerOf('lan', { pairId: 'p1', name: 'iPad' }, null))).toBe('lan')
    // P2P 信道可由局域网配对设备开出:带着断言也不升成 unit,也不当 account
    expect(callerOf('p2p', null, PHONE)).toEqual({ kind: 'p2p' })
    expect(callerPrincipal({ kind: 'p2p' })).toBe('p2p')
    expect(callerOf('lan', { pairId: 'p1', name: 'iPad' }, PHONE).kind).toBe('paired')
    // 来路缺失 / 配对记录已被回收 → 最低档
    expect(callerOf(null, null, PHONE)).toEqual({ kind: 'paired', pairId: '', name: '' })
    expect(callerOf('lan', null, null)).toEqual({ kind: 'paired', pairId: '', name: '' })
  })

  it('/unit/mcp* 永不签:大小写、重复斜杠、百分号编码都绕不过;别的路径照签', () => {
    for (const p of ['/unit/mcp', '/unit/mcp/', '/unit/mcp/tools/call', '/UNIT/MCP', '/unit//mcp', '//unit/mcp', '/unit/%6dcp', '/unit%2fmcp', '/unit\\mcp']) {
      expect(proxyAssertionAllowed(p), p).toBe(false)
    }
    for (const p of ['/engine/agent/runs', '/unit/remote-access', '/unit/mcpx', '/unit/hostfile', '/', '/unit/%zz']) {
      expect(proxyAssertionAllowed(p), p).toBe(true)
    }
  })

  describe('makeCallerHeaders(隧道信封 → x-unit-caller)', () => {
    const at = (path: string): URL => new URL(`http://127.0.0.1:8791${path}`)

    it('K1 S8 签的是**实际发出**的目标(URL 规整后的点段 / 空格 query),unitWeb 收到的 req.url 验得过;按信封原始 path 验不过', () => {
      const headers = makeCallerHeaders(() => KEY, () => {})
      const target = at('/engine/./agent/runs?q=a b&x=%41')
      expect(target.pathname + target.search).toBe('/engine/agent/runs?q=a%20b&x=%41')
      const h = headers({ dispatchId: 'env-s8', method: 'POST', target, proxyCaller: PHONE })
      expect(Object.keys(h)).toEqual(['x-unit-caller'])
      expect(verifyProxyCaller(KEY, h['x-unit-caller'], { method: 'POST', url: '/engine/agent/runs?q=a%20b&x=%41' }, new Map()))
        .toEqual({ ok: true, caller: PHONE, operator: null, dispatchId: 'env-s8' })
      expect(verifyProxyCaller(KEY, h['x-unit-caller'], { method: 'POST', url: '/engine/./agent/runs?q=a b&x=%41' }, new Map()).ok).toBe(false)
    })

    it('K1 S7 /unit/mcp* 永不签;没有 proxyCaller / 钥未就绪不签;畸形 proxyCaller 丢弃并只记一次日志', () => {
      const logs: string[] = []
      const headers = makeCallerHeaders(() => KEY, (m) => logs.push(m))
      for (const path of ['/unit/mcp', '/unit/mcp/tools/call', '/UNIT//mcp', '/unit/%6dcp']) {
        expect(headers({ dispatchId: `mcp-${path}`, method: 'POST', target: at(path), proxyCaller: PHONE }), path).toEqual({})
      }
      expect(headers({ dispatchId: 'plain', method: 'GET', target: at('/engine/agent/sessions'), proxyCaller: undefined })).toEqual({})
      expect(headers({ dispatchId: 'bad-1', method: 'GET', target: at('/engine/agent/sessions'), proxyCaller: { unit: 'not-a-uuid', kind: 'phone' } })).toEqual({})
      expect(headers({ dispatchId: 'bad-2', method: 'GET', target: at('/engine/agent/sessions'), proxyCaller: 'phone' })).toEqual({})
      expect(Object.keys(headers({ dispatchId: 'ok', method: 'GET', target: at('/unit/remote-access'), proxyCaller: PHONE }))).toEqual(['x-unit-caller'])
      expect(logs.filter((l) => l.includes('调用方字段不合法')).length).toBe(1)
      // 钥未就绪(unitWeb 还没起好)= 不签
      expect(makeCallerHeaders(() => '', () => {})({ dispatchId: 'nokey', method: 'GET', target: at('/engine/agent/sessions'), proxyCaller: PHONE })).toEqual({})
    })
  })

  describe('操作者声明(载荷键 o,与调用方同一枚 MAC)', () => {
    const ADMIN: ProxyOperator = { uid: 'user-42', role: 'admin', name: '王 管理员' }
    const at = (path: string): URL => new URL(`http://127.0.0.1:8791${path}`)
    const decode = (h: string): Record<string, unknown> => JSON.parse(Buffer.from(h.split('.')[1], 'base64url').toString('utf8'))

    it('清洗:uid 1–64 的字符串(不截断)、role 只认 admin、name 去控制符截 120;不合格 = 当没有', () => {
      expect(sanitizeProxyOperator(ADMIN)).toEqual(ADMIN)
      expect(sanitizeProxyOperator({ uid: 'u', role: 'admin' })).toEqual({ uid: 'u', role: 'admin', name: '' })
      expect(sanitizeProxyOperator({ ...ADMIN, name: 'a\u202eb\u0000' + 'x'.repeat(200) })!.name).toBe('ab' + 'x'.repeat(118))
      for (const bad of [null, 'admin', [ADMIN], { ...ADMIN, uid: '' }, { ...ADMIN, uid: 'x'.repeat(65) }, { ...ADMIN, uid: 7 },
        { ...ADMIN, uid: 'a\u0000b' }, { ...ADMIN, role: 'member' }, { ...ADMIN, role: 'owner' }, { uid: 'u' }]) {
        expect(sanitizeProxyOperator(bad), JSON.stringify(bad)).toBeNull()
      }
    })

    it('只有调用方时载荷与改版前逐字节一致(没有 o 键,键序不变)', () => {
      const p = decode(sign())
      expect(Object.keys(p)).toEqual(['pur', 'd', 'm', 't', 'c', 'iat'])
    })

    it('只有操作者也签(没有 c 键);两者同在则一枚 MAC 盖住两者;验方交出 operator', () => {
      const seen = new Map<string, number>()
      const onlyOp = signProxyCaller(KEY, { dispatchId: 'op-1', method: 'POST', target: REQ.url, operator: ADMIN, nowMs: 1_000_000 })
      expect(Object.keys(decode(onlyOp))).toEqual(['pur', 'd', 'm', 't', 'o', 'iat'])
      expect(verifyProxyCaller(KEY, onlyOp, REQ, seen, 1_000_000)).toEqual({ ok: true, caller: null, operator: ADMIN, dispatchId: 'op-1' })
      const both = signProxyCaller(KEY, { dispatchId: 'op-2', method: 'POST', target: REQ.url, caller: PHONE, operator: ADMIN, nowMs: 1_000_000 })
      expect(verifyProxyCaller(KEY, both, REQ, seen, 1_000_000)).toEqual({ ok: true, caller: PHONE, operator: ADMIN, dispatchId: 'op-2' })
      expect(() => signProxyCaller(KEY, { dispatchId: 'x', method: 'GET', target: '/', nowMs: 1 })).toThrow()
    })

    it('MAC 被改 / 载荷里换操作者 / 重放 / 换方法 / 换路径 → 失败', () => {
      const now = 1_000_000
      const good = signProxyCaller(KEY, { dispatchId: 'op-3', method: 'POST', target: REQ.url, operator: ADMIN, nowMs: now })
      const [v, body, mac] = good.split('.')
      const swapped = Buffer.from(JSON.stringify({ ...decode(good), o: { ...ADMIN, uid: 'someone-else' } })).toString('base64url')
      expect(verifyProxyCaller(KEY, `${v}.${swapped}.${mac}`, REQ, new Map(), now)).toEqual({ ok: false, reason: 'bad-mac' })
      expect(verifyProxyCaller(KEY, `${v}.${body}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, REQ, new Map(), now).ok).toBe(false)
      expect(verifyProxyCaller(KEY, good, { ...REQ, method: 'GET' }, new Map(), now)).toEqual({ ok: false, reason: 'method' })
      expect(verifyProxyCaller(KEY, good, { ...REQ, url: '/engine/agent/sessions' }, new Map(), now)).toEqual({ ok: false, reason: 'target' })
      const seen = new Map<string, number>()
      expect(verifyProxyCaller(KEY, good, REQ, seen, now).ok).toBe(true)
      expect(verifyProxyCaller(KEY, good, REQ, seen, now + 1)).toEqual({ ok: false, reason: 'replay' })
    })

    it('MAC 对但字段不合格 = 畸形(签方只签清洗过的):role 不是 admin、c / o 都没有、o 畸形而 c 合格', () => {
      const now = 1_000_000
      const base = { pur: 'proxy', d: 'd', m: 'POST', t: REQ.url, iat: now }
      expect(verifyProxyCaller(KEY, signRaw({ ...base, o: { ...ADMIN, role: 'member' } }), REQ, new Map(), now)).toEqual({ ok: false, reason: 'malformed' })
      expect(verifyProxyCaller(KEY, signRaw(base), REQ, new Map(), now)).toEqual({ ok: false, reason: 'malformed' })
      expect(verifyProxyCaller(KEY, signRaw({ ...base, c: PHONE, o: { uid: '' } }), REQ, new Map(), now)).toEqual({ ok: false, reason: 'malformed' })
    })

    it('makeCallerHeaders:proxyCaller 缺席而 proxyOperator 在也签;畸形的各自丢弃(各记一次日志)、剩下合格的照签;/unit/mcp* 照旧不签', () => {
      const logs: string[] = []
      const headers = makeCallerHeaders(() => KEY, (m) => logs.push(m))
      const onlyOp = headers({ dispatchId: 'e-1', method: 'GET', target: at('/web/engine/agent/agents'), proxyCaller: undefined, proxyOperator: ADMIN })
      expect(verifyProxyCaller(KEY, onlyOp['x-unit-caller'], { method: 'GET', url: '/web/engine/agent/agents' }, new Map()))
        .toMatchObject({ ok: true, caller: null, operator: ADMIN })
      // 调用方畸形、操作者合格 → 只签操作者
      const badCaller = headers({ dispatchId: 'e-2', method: 'GET', target: at('/x'), proxyCaller: { unit: 'nope' }, proxyOperator: ADMIN })
      expect(decode(badCaller['x-unit-caller'])).toMatchObject({ o: ADMIN })
      expect(decode(badCaller['x-unit-caller']).c).toBeUndefined()
      // 操作者畸形、调用方合格 → 只签调用方
      const badOp = headers({ dispatchId: 'e-3', method: 'GET', target: at('/x'), proxyCaller: PHONE, proxyOperator: { uid: 'u', role: 'member' } })
      expect(decode(badOp['x-unit-caller']).o).toBeUndefined()
      headers({ dispatchId: 'e-4', method: 'GET', target: at('/x'), proxyCaller: PHONE, proxyOperator: 'admin' })
      expect(headers({ dispatchId: 'e-5', method: 'GET', target: at('/x'), proxyCaller: null, proxyOperator: { role: 'admin' } })).toEqual({})
      expect(headers({ dispatchId: 'e-6', method: 'POST', target: at('/unit/mcp'), proxyCaller: undefined, proxyOperator: ADMIN })).toEqual({})
      expect(logs.filter((l) => l.includes('操作者声明不合法')).length).toBe(1)
      expect(logs.filter((l) => l.includes('调用方字段不合法')).length).toBe(1)
    })
  })
})
