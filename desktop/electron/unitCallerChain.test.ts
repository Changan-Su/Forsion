/**
 * 调用方断言整链(P1 · K1 §6):假 hub(SSE 通道 + resp/stream 回包)→ **真** UnitHost → **真** unitWeb → 假引擎。
 * 钉住:信封里的 proxyCaller 端到端变成引擎收到的 x-forsion-remote-caller;没有 proxyCaller = 不盖(账号级);
 * 同一个信封 id 重投 → 第二次 403 BAD_CALLER_ASSERTION(断言一次性);unitHost 与 unitWeb 用的是同一把 per-boot 钥。
 * 跑法:npx vitest run electron/unitCallerChain.test.ts(另跑 unitHostChain.test.ts 回归)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { startUnitWeb, type UnitWebHandle } from './unitWeb'
import { UnitHost } from './unitHost'
import type { ProxyCaller } from './unitCaller'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now()
  while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20) }
  return true
}

const PHONE: ProxyCaller = { unit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', kind: 'phone', name: '小米 14', platform: 'android', registeredAt: '2026-09-28T01:02:03.000Z' }

let engineSeen: http.IncomingHttpHeaders[] = []
let engine: http.Server
let web: UnitWebHandle
let hub: http.Server
let hubUrl = ''
let channel: http.ServerResponse | null = null
const replies = new Map<string, { status: number; body: string }>()
let unitHost: UnitHost

beforeAll(async () => {
  engine = http.createServer((req, res) => {
    engineSeen.push(req.headers)
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"sessions":[]}')
  })
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r))
  const engineUrl = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`
  web = await startUnitWeb({
    getEngine: () => ({ url: engineUrl, token: 'ENGINE', remoteMark: 'MARK' }),
    confirmPair: async () => false,
    pairedDevices: { list: () => [], add: async () => {} },
    readPlugins: async () => [], readSpaces: async () => [], readConfig: async () => ({}), writeConfig: async () => ({}), readProviders: async () => [],
    readHostFile: async () => null, readHostDir: async () => null, readHostStat: async () => null,
    meta: { instanceId: 'i', name: 'n', version: '0' }, webDistDir: () => null, vault: () => null, log: () => {},
  }, { port: 0, bindHost: '127.0.0.1' })
  // 假 hub:/channel 长挂 SSE;/resp/:did 收整包回包、/stream/:did 收流式回包(长度未知的响应走这条)
  hub = http.createServer((req, res) => {
    const url = req.url || ''
    if (url.endsWith('/channel')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\nevent: ready\ndata: {"caps":["stream-sec-headers"]}\n\n')
      channel = res
      return
    }
    const m = /\/(?:resp|stream)\/([^/?]+)/.exec(url)
    if (m) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (url.includes('/stream/')) {
          replies.set(m[1], { status: Number(new URL(url, 'http://x').searchParams.get('status')), body })
        } else {
          const j = JSON.parse(body) as { status: number; bodyB64?: string }
          replies.set(m[1], { status: j.status, body: Buffer.from(j.bodyB64 || '', 'base64').toString('utf8') })
        }
        res.writeHead(200); res.end('{}')
      })
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r))
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
  unitHost = new UnitHost({
    getCreds: () => ({ cloudUrl: hubUrl, token: 'tok' }),
    // 与 main.ts 同一种装配:url + 两把 per-boot 钥都取自这个 unitWeb 实例
    getUnitWeb: () => ({ url: `http://127.0.0.1:${web.port}`, internalSecret: web.internalSecret, proxyCallerKey: web.proxyCallerKey }),
    getLanUrl: () => null,
    getPairing: () => ({ unitId: 'target', secret: 's' }),
    savePairing: async () => {}, clearPairing: async () => {},
    log: () => {},
    readIdleMs: 0,
  })
  unitHost.start()
  expect(await until(() => channel !== null)).toBe(true)
})
afterAll(async () => {
  unitHost?.stop()
  channel?.destroy()
  hub?.closeAllConnections(); hub?.close()
  await web?.close()
  engine?.close()
})

const dispatch = (env: Record<string, unknown>): void => { channel!.write(`event: dispatch\ndata: ${JSON.stringify({ body: null, ...env })}\n\n`) }
const callerOfEngine = (h: http.IncomingHttpHeaders): unknown =>
  typeof h['x-forsion-remote-caller'] === 'string' ? JSON.parse(Buffer.from(h['x-forsion-remote-caller'], 'base64url').toString('utf8')) : undefined

describe('调用方断言整链:hub 信封 → UnitHost 签 → unitWeb 验 → 引擎头', () => {
  it('信封 proxyCaller → 引擎 x-forsion-remote-caller(隧道 + 标记);没有 proxyCaller → 不盖', async () => {
    engineSeen = []
    dispatch({ id: 'with-caller', method: 'GET', path: '/engine/agent/sessions?limit=5', proxyCaller: PHONE })
    expect(await until(() => replies.has('with-caller'))).toBe(true)
    expect(replies.get('with-caller')!.status).toBe(200)
    expect(engineSeen.length).toBe(1)
    expect(engineSeen[0]['x-forsion-remote']).toBe('tunnel')
    expect(engineSeen[0]['x-forsion-remote-mark']).toBe('MARK')
    expect(callerOfEngine(engineSeen[0])).toEqual({ u: PHONE.unit, k: 'phone', n: '小米 14', p: 'android', r: PHONE.registeredAt })
    expect(engineSeen[0]['x-unit-caller']).toBeUndefined()

    dispatch({ id: 'no-caller', method: 'GET', path: '/engine/agent/sessions' })
    expect(await until(() => replies.has('no-caller'))).toBe(true)
    expect(replies.get('no-caller')!.status).toBe(200)
    expect(engineSeen.length).toBe(2)
    expect(engineSeen[1]['x-forsion-remote']).toBe('tunnel')
    expect(engineSeen[1]['x-forsion-remote-caller']).toBeUndefined()
  })

  it('同一个信封 id 重投(断言重放)→ 第二次 403 BAD_CALLER_ASSERTION,引擎只见一次', async () => {
    engineSeen = []
    dispatch({ id: 'dup', method: 'GET', path: '/engine/agent/sessions', proxyCaller: PHONE })
    expect(await until(() => replies.has('dup'))).toBe(true)
    expect(replies.get('dup')!.status).toBe(200)
    replies.delete('dup')
    dispatch({ id: 'dup', method: 'GET', path: '/engine/agent/sessions', proxyCaller: PHONE })
    expect(await until(() => replies.has('dup'))).toBe(true)
    expect(replies.get('dup')!.status).toBe(403)
    expect(JSON.parse(replies.get('dup')!.body).code).toBe('BAD_CALLER_ASSERTION')
    expect(engineSeen.length).toBe(1)
  })
})
