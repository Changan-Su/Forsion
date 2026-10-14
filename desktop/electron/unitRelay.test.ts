/**
 * 桌面作为调用方的中转口(electron/unitRelay.ts)× 假 hub。钉住:
 *  - 没口令 / 口令不对 → 401,一个字节都不发往 hub;路径不在语法里(别的面、`..`、大写 id、unit/mcp)→ 404,同样不发;
 *  - 头从零重建:渲染层的口令不出门,换成 forsion_token;渲染层自带的 X-Forsion-Caller / 别的头一律不转发;
 *  - 调用方票:登记过设备 → 签发凭据(带 X-Unit-Secret)→ 换票 → 调用方面带票、设备辅助面不带;票缓存复用,过期前续;
 *    hub 拒票(EXPIRED / INVALID)→ 重取一次再发;取不到票 / 配对锁着 → 503 CALLER_UNAVAILABLE 且不发请求(失败关闭);
 *    没登记过设备 → 不带票照发(未识别调用方);没登录 → 401 NOT_SIGNED_IN。
 *  - 流式回包逐块到达;渲染层断开 → 上游被掐。
 * 跑法:npx vitest run electron/unitRelay.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createUnitRelay, type UnitRelay } from './unitRelay'

const SELF = '11111111-2222-4333-8444-555555555555'
const PEER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

let hub: http.Server
let api = ''
let seen: Seen[] = []
let relay: UnitRelay
let base = ''
let token = ''
/** 假 hub 的可调行为 */
let hubState: { callerSecrets: number; tickets: number; rejectTicketOnce: '' | 'UNIT_CALLER_EXPIRED' | 'UNIT_CALLER_INVALID'; mintStatus: number; secretMismatchOnce: boolean; streamAborted: boolean; holdMintFor: string; releaseMint: (() => void) | null }
let deps: { token: string; pairing: { unitId: string; secret: string } | null | 'locked'; now: number }

beforeEach(async () => {
  seen = []
  hubState = { callerSecrets: 0, tickets: 0, rejectTicketOnce: '', mintStatus: 200, secretMismatchOnce: false, streamAborted: false, holdMintFor: '', releaseMint: null }
  deps = { token: 'forsion-jwt', pairing: { unitId: SELF, secret: 'device-secret' }, now: 1_000_000 }
  hub = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = req.url || ''
      seen.push({ method: req.method || '', url, headers: req.headers, body })
      const send = (status: number, j: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)) }
      if (url === `/api/units/${SELF}/caller-secret`) {
        if (req.headers['x-unit-secret'] !== 'device-secret') return send(403, { code: 'UNIT_SECRET_MISMATCH' })
        return send(200, { unitId: SELF, callerSecret: `cs-${++hubState.callerSecrets}` })
      }
      if (url === `/api/units/${SELF}/caller-token`) {
        // 扣住某个账号的换票:放行时回 401(那个账号的登录已失效)
        if (hubState.holdMintFor && req.headers.authorization === `Bearer ${hubState.holdMintFor}`) { hubState.releaseMint = () => send(401, { code: 'UNAUTHORIZED' }); return }
        if (hubState.mintStatus !== 200) return send(hubState.mintStatus, { code: 'BOOM' })
        if (hubState.secretMismatchOnce) { hubState.secretMismatchOnce = false; return send(403, { code: 'UNIT_CALLER_SECRET_MISMATCH' }) }
        if (req.headers['x-unit-caller-secret'] !== `cs-${hubState.callerSecrets}`) return send(403, { code: 'UNIT_CALLER_SECRET_MISMATCH' })
        return send(200, { unitId: SELF, token: `ticket-${++hubState.tickets}`, expiresAt: Math.floor(deps.now / 1000) + 600 })
      }
      if (url.startsWith(`/api/units/${PEER}/proxy/engine/agent/stream`)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: one\n\n')
        res.on('close', () => { hubState.streamAborted = true })
        return // 一直挂着,等对面断开
      }
      if (url.startsWith(`/api/units/${PEER}/proxy/`)) {
        if (req.headers['x-forsion-caller'] && hubState.rejectTicketOnce) {
          const code = hubState.rejectTicketOnce
          hubState.rejectTicketOnce = ''
          return send(403, { code })
        }
        if (url.endsWith('/engine/agent/denied')) return send(403, { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending' })
        return send(200, { ok: true, caller: req.headers['x-forsion-caller'] ?? null })
      }
      send(404, { code: 'NOPE' })
    })
  })
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r))
  api = `http://127.0.0.1:${(hub.address() as AddressInfo).port}/api`
  // 账号身份 = 令牌本身(够测:换令牌 = 换账号)
  relay = createUnitRelay({ apiBase: () => api, token: () => deps.token, account: () => deps.token || null, pairing: async () => deps.pairing, now: () => deps.now })
  ;({ base, token } = (await relay.open())!)
})

afterEach(async () => {
  await relay.close()
  hub.closeAllConnections()
  await new Promise<void>((r) => hub.close(() => r()))
})

const call = (path: string, init: RequestInit = {}, auth: string | null = `Bearer ${token}`): Promise<Response> =>
  fetch(`${base}${path}`, { ...init, headers: { ...(auth ? { Authorization: auth } : {}), ...(init.headers as Record<string, string> | undefined) } })
const proxied = (): Seen[] => seen.filter((s) => s.url.includes('/proxy/'))
const raw = (path: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const u = new URL(base)
  const req = http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => resolve({ status: res.statusCode || 0, body }))
  })
  req.on('error', reject)
  req.end()
})

describe('unitRelay', () => {
  it('open() is idempotent and binds loopback only', async () => {
    expect(await relay.open()).toEqual({ base, token })
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a missing / wrong relay token without contacting the hub', async () => {
    expect((await call(`/units/${PEER}/proxy/engine/agent/sessions`, {}, null)).status).toBe(401)
    expect((await call(`/units/${PEER}/proxy/engine/agent/sessions`, {}, 'Bearer nope')).status).toBe(401)
    expect((await call(`/units/${PEER}/proxy/engine/agent/sessions`, {}, `Bearer ${deps.token}`)).status).toBe(401)
    expect(seen).toEqual([])
  })

  it.each([
    `/units/${PEER}/proxy/unit/mcp`,
    `/units/${PEER}/proxy/unit/remote-access/other`,
    `/units/${PEER}/proxy/unit/hostfile/../../engine/agent/runs`,
    `/units/${PEER}/proxy/engine/%2e%2e/unit/mcp`,
    `/units/${PEER}/proxy/engine%2fagent`,
    `/units/${PEER.toUpperCase()}/proxy/engine/agent/sessions`,
    `/units/not-a-uuid/proxy/engine/agent/sessions`,
    `/units/${PEER}/channel`,
    `/auth/me`,
  ])('refuses %s (outside the grammar) without contacting the hub', async (path) => {
    // 裸 http.request:fetch 会先把 `..` 规范化掉,到不了中转口眼前(渲染层那一道由 targets.ts 的 assertEnginePath 管)
    const r = await raw(path)
    expect(r.status).toBe(404)
    expect((JSON.parse(r.body) as { code: string }).code).toBe('RELAY_PATH')
    expect(seen).toEqual([])
  })

  it('answers the CORS preflight itself', async () => {
    const r = await fetch(`${base}/units/${PEER}/proxy/engine/agent/runs`, { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-headers')).toContain('Authorization')
    expect(seen).toEqual([])
  })

  it('rebuilds headers: forsion token in, relay token and renderer-supplied caller header out', async () => {
    const r = await call(`/units/${PEER}/proxy/engine/agent/runs?x=1`, {
      method: 'POST', body: '{"hello":"世界"}',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Forsion-Caller': 'forged', 'X-Forsion-Remote': 'forged', Cookie: 'a=b' },
    })
    expect(r.status).toBe(200)
    const [p] = proxied()
    expect(p.url).toBe(`/api/units/${PEER}/proxy/engine/agent/runs?x=1`)
    expect(p.method).toBe('POST')
    expect(p.body).toBe('{"hello":"世界"}')
    expect(p.headers.authorization).toBe('Bearer forsion-jwt')
    expect(p.headers['x-forsion-caller']).toBe('ticket-1')
    expect(p.headers['content-type']).toBe('application/json')
    expect(p.headers.accept).toBe('text/event-stream')
    expect(p.headers['x-forsion-remote']).toBeUndefined()
    expect(p.headers.cookie).toBeUndefined()
    expect(JSON.stringify(p.headers)).not.toContain(token)
  })

  it('issues the caller secret with the device secret, then reuses the ticket', async () => {
    await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    await call(`/units/${PEER}/proxy/unit/remote-access`)
    expect(hubState).toMatchObject({ callerSecrets: 1, tickets: 1 })
    expect(seen.find((s) => s.url.endsWith('/caller-secret'))!.headers['x-unit-secret']).toBe('device-secret')
    expect(proxied().map((s) => s.headers['x-forsion-caller'])).toEqual(['ticket-1', 'ticket-1'])
  })

  it('renews the ticket 60s before it expires', async () => {
    await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    deps.now += 600_000 - 59_000
    await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(hubState).toMatchObject({ callerSecrets: 1, tickets: 2 })
    expect(proxied()[1].headers['x-forsion-caller']).toBe('ticket-2')
  })

  it('device surface goes out anonymous (no caller ticket) and is GET-only', async () => {
    const r = await call(`/units/${PEER}/proxy/unit/hostfile?path=%2Ftmp%2Fa.txt`)
    expect(r.status).toBe(200)
    expect(proxied()[0].headers['x-forsion-caller']).toBeUndefined()
    expect(proxied()[0].headers.authorization).toBe('Bearer forsion-jwt')
    expect(hubState.tickets).toBe(0)
    expect((await call(`/units/${PEER}/proxy/unit/config`, { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it.each(['UNIT_CALLER_EXPIRED', 'UNIT_CALLER_INVALID'] as const)('a ticket the hub rejects (%s) is re-minted once and the request resent', async (code) => {
    await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    hubState.rejectTicketOnce = code
    const r = await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(r.status).toBe(200)
    expect((await r.json() as { caller: string }).caller).toBe('ticket-2')
    expect(hubState.callerSecrets).toBe(code === 'UNIT_CALLER_INVALID' ? 2 : 1)
  })

  it('other 403s from the device pass through untouched', async () => {
    const r = await call(`/units/${PEER}/proxy/engine/agent/denied`)
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending' })
    expect(hubState.tickets).toBe(1)
  })

  it('rotates the caller secret once when the hub says it no longer matches', async () => {
    hubState.secretMismatchOnce = true
    const r = await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(r.status).toBe(200)
    expect(hubState).toMatchObject({ callerSecrets: 2, tickets: 1 })
  })

  it('fails closed when a registered device cannot get a ticket', async () => {
    hubState.mintStatus = 500
    const r = await call(`/units/${PEER}/proxy/engine/agent/runs`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(503)
    expect((await r.json() as { code: string }).code).toBe('CALLER_UNAVAILABLE')
    expect(proxied()).toEqual([])
  })

  it('fails closed when the device pairing is locked', async () => {
    deps.pairing = 'locked'
    const r = await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(r.status).toBe(503)
    expect((await r.json() as { code: string }).code).toBe('CALLER_UNAVAILABLE')
    expect(seen).toEqual([])
  })

  it('a desktop that never registered as a device calls unidentified', async () => {
    deps.pairing = null
    const r = await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(r.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0].headers['x-forsion-caller']).toBeUndefined()
    expect(seen[0].headers.authorization).toBe('Bearer forsion-jwt')
  })

  it('signed out → the relay token is dead (401), nothing sent, and open() hands out nothing', async () => {
    deps.token = ''
    const r = await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(r.status).toBe(401)
    expect(seen).toEqual([])
    expect(await relay.open()).toBeNull()
  })

  // Codex 评审 10-14 P1:口令跟着账号走 —— 换号后攥着旧口令的在途请求不许被盖上新账号的令牌发出去
  it('account switch: the old relay token stops working; a fresh open() gives the new account its own', async () => {
    await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    const old = token
    deps.token = 'another-jwt'
    const stale = await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(stale.status).toBe(401)
    expect((await stale.json() as { code: string }).code).toBe('RELAY_UNAUTHORIZED')
    expect(proxied()).toHaveLength(1) // 旧口令的那条没出门
    ;({ token } = (await relay.open())!)
    expect(token).not.toBe(old)
    await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(hubState).toMatchObject({ callerSecrets: 2, tickets: 2 }) // 调用方凭据也按新账号重新签发
    expect(proxied()[1].headers.authorization).toBe('Bearer another-jwt')
    // 换回原账号:最初那枚口令也不复活
    deps.token = 'forsion-jwt'
    expect((await call(`/units/${PEER}/proxy/engine/agent/sessions`, { headers: { Authorization: `Bearer ${old}` } })).status).toBe(401)
    expect((await call(`/units/${PEER}/proxy/engine/agent/sessions`)).status).toBe(401) // 新账号那枚同理
    expect(proxied()).toHaveLength(2)
  })

  // Codex 评审 10-14 P2:在途的换票按账号分 —— 新账号的第一条请求不许搭上个账号那一趟、替它背 401
  it('account switch while a ticket is being minted: the new account mints its own', async () => {
    hubState.holdMintFor = 'forsion-jwt'
    const first = call(`/units/${PEER}/proxy/engine/agent/sessions`)
    for (let i = 0; i < 50 && !hubState.releaseMint; i++) await sleep(10)
    expect(hubState.releaseMint).toBeTypeOf('function')
    deps.token = 'another-jwt'
    ;({ token } = (await relay.open())!)
    const second = await call(`/units/${PEER}/proxy/engine/agent/sessions`)
    expect(second.status).toBe(200)
    expect(proxied().map((p) => p.headers.authorization)).toEqual(['Bearer another-jwt'])
    hubState.releaseMint!()
    expect((await first).status).toBe(401) // 上个账号那条:票没换成,也没被改用新账号发出去
    expect(proxied()).toHaveLength(1)
  })

  it('streams the response and aborts upstream when the renderer goes away', async () => {
    const ac = new AbortController()
    const r = await call(`/units/${PEER}/proxy/engine/agent/stream/s1`, { signal: ac.signal })
    expect(r.headers.get('content-type')).toBe('text/event-stream')
    const reader = r.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n')
    ac.abort()
    for (let i = 0; i < 100 && !hubState.streamAborted; i++) await sleep(20)
    expect(hubState.streamAborted).toBe(true)
  })
})
