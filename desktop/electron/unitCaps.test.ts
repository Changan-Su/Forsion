/**
 * caps 上报器(P1-K7a,规格 K7 §3.10 / INTEGRATION R-30)。
 *   - engineCapsState 映射表;
 *   - 上报器单体:ready 之前不报、ready 之后报一次(双闸头 + 体)、值不变不重报、变了去抖后重报、断开后重连再报、404 本连接内停报;
 *   - 与真 UnitHost 接线(真 HTTP 假网关):通道响应头到了、`event: ready` 还没来 → 不报;ready 帧到了才报(S11)。
 * 跑法:npx vitest run electron/unitCaps.test.ts
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { UnitCapsReporter, engineCapsState, type EngineCapsState } from './unitCaps'
import { UnitHost } from './unitHost'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) return false
    await sleep(10)
  }
  return true
}

describe('engineCapsState', () => {
  it('maps the backend state, the seed gate and the product profile', () => {
    expect(engineCapsState({ agentBackend: false, backend: 'ready', seeded: true })).toBe('external')
    expect(engineCapsState({ agentBackend: true, backend: 'ready', seeded: true })).toBe('ready')
    // 种子没做完:unitWeb 对远端回 503 ENGINE_NOT_READY → 手机上应是「在启动」而不是「可用」
    expect(engineCapsState({ agentBackend: true, backend: 'ready', seeded: false })).toBe('starting')
    expect(engineCapsState({ agentBackend: true, backend: 'starting', seeded: true })).toBe('starting')
    expect(engineCapsState({ agentBackend: true, backend: 'stopped', seeded: true })).toBe('stopped')
    expect(engineCapsState({ agentBackend: true, backend: 'crashed', seeded: true })).toBe('stopped')
  })
})

interface Posted { url: string; headers: Record<string, string>; body: unknown }
function fakeFetch(status: () => number = () => 200): { fetch: typeof fetch; posts: Posted[] } {
  const posts: Posted[] = []
  const f = (async (url: string, init?: RequestInit) => {
    const h: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { h[k] = v })
    posts.push({ url: String(url), headers: h, body: JSON.parse(String(init?.body || 'null')) })
    return new Response('{}', { status: status() })
  }) as unknown as typeof fetch
  return { fetch: f, posts }
}

function reporter(o: { state: { v: EngineCapsState }; fetch: typeof fetch; logs?: string[] }): UnitCapsReporter {
  return new UnitCapsReporter({
    getCreds: () => ({ cloudUrl: 'https://hub.test/', token: 'tok-1' }),
    getPairing: () => ({ unitId: 'u-1', secret: 'sec-1' }),
    current: () => o.state.v,
    hubFetch: o.fetch,
    log: (m) => o.logs?.push(m),
    debounceMs: 5,
  })
}

describe('UnitCapsReporter', () => {
  it('does not post before the channel is ready; posts once after ready with both gates', async () => {
    const state = { v: 'ready' as EngineCapsState }
    const f = fakeFetch()
    const r = reporter({ state, fetch: f.fetch })
    r.engineChanged()
    await sleep(30)
    expect(f.posts).toHaveLength(0)
    r.channelReady()
    await until(() => f.posts.length === 1)
    expect(f.posts[0].url).toBe('https://hub.test/api/units/u-1/caps')
    expect(f.posts[0].headers.authorization).toBe('Bearer tok-1')
    expect(f.posts[0].headers['x-unit-secret']).toBe('sec-1')
    expect(f.posts[0].headers['content-type']).toBe('application/json')
    expect(f.posts[0].body).toEqual({ engine: 'ready', tools: [] })
  })

  it('re-posts only when the value changes (debounced)', async () => {
    const state = { v: 'starting' as EngineCapsState }
    const f = fakeFetch()
    const r = reporter({ state, fetch: f.fetch })
    r.channelReady()
    await until(() => f.posts.length === 1)
    r.engineChanged(); r.engineChanged()
    await sleep(40)
    expect(f.posts).toHaveLength(1) // 值没变
    state.v = 'ready'
    r.engineChanged(); r.engineChanged(); r.engineChanged()
    await until(() => f.posts.length === 2)
    await sleep(30)
    expect(f.posts).toHaveLength(2) // 连发三次只报一次
    expect(f.posts[1].body).toEqual({ engine: 'ready', tools: [] })
  })

  it('stops on channelDown and posts again after the next ready (capsLive resets per connection)', async () => {
    const state = { v: 'ready' as EngineCapsState }
    const f = fakeFetch()
    const r = reporter({ state, fetch: f.fetch })
    r.channelReady()
    await until(() => f.posts.length === 1)
    r.channelDown()
    state.v = 'stopped'
    r.engineChanged()
    await sleep(30)
    expect(f.posts).toHaveLength(1)
    state.v = 'ready'
    r.channelReady()
    await until(() => f.posts.length === 2)
    expect(f.posts[1].body).toEqual({ engine: 'ready', tools: [] })
  })

  it('an old gateway (404) disables reporting for this connection only', async () => {
    const state = { v: 'ready' as EngineCapsState }
    let status = 404
    const f = fakeFetch(() => status)
    const logs: string[] = []
    const r = reporter({ state, fetch: f.fetch, logs })
    r.channelReady()
    await until(() => f.posts.length === 1)
    await sleep(10)
    state.v = 'stopped'
    r.engineChanged()
    await sleep(40)
    expect(f.posts).toHaveLength(1)
    expect(logs.some((m) => /老版本/.test(m))).toBe(true)
    status = 200
    r.channelDown()
    r.channelReady() // 新连接可能落到新网关上
    await until(() => f.posts.length === 2)
    expect(f.posts[1].body).toEqual({ engine: 'stopped', tools: [] })
  })

  it('never throws into the caller (network error / creds throw)', async () => {
    const state = { v: 'ready' as EngineCapsState }
    const logs: string[] = []
    const r = new UnitCapsReporter({
      getCreds: () => ({ cloudUrl: 'https://hub.test', token: 't' }),
      getPairing: () => ({ unitId: 'u', secret: 's' }),
      current: () => state.v,
      hubFetch: (async () => { throw new TypeError('network down') }) as unknown as typeof fetch,
      log: (m) => logs.push(m),
      debounceMs: 1,
    })
    expect(() => r.channelReady()).not.toThrow()
    await until(() => logs.length > 0)
    expect(logs[0]).toMatch(/network down/)
  })
})

describe('UnitHost × UnitCapsReporter (real HTTP)', () => {
  it('reports only after the gateway sends `event: ready` on this connection (S11)', async () => {
    const capsPosts: string[] = []
    let channel: http.ServerResponse | null = null
    const server = http.createServer((req, res) => {
      const url = req.url || ''
      if (url.endsWith('/channel')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': connected\n\n') // 响应头 + 注释帧到了,ready 帧还没来
        channel = res
        return
      }
      if (url.endsWith('/caps') && req.method === 'POST') {
        let b = ''
        req.on('data', (c) => { b += c })
        req.on('end', () => { capsPosts.push(b); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') })
        return
      }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as AddressInfo
    const cloudUrl = `http://127.0.0.1:${port}`
    const pairing = { unitId: 'u-caps', secret: 'sec' }
    const caps = new UnitCapsReporter({
      getCreds: () => ({ cloudUrl, token: 'tok' }),
      getPairing: () => pairing,
      current: () => 'ready',
      log: () => {},
      debounceMs: 1,
    })
    const host = new UnitHost({
      getCreds: () => ({ cloudUrl, token: 'tok' }),
      getUnitWeb: () => ({ url: null, internalSecret: '', proxyCallerKey: '' }),
      getLanUrl: () => null,
      getPairing: () => pairing,
      savePairing: async () => {},
      clearPairing: async () => {},
      log: () => {},
      readIdleMs: 0,
      onChannelReady: () => caps.channelReady(),
      onChannelDown: () => caps.channelDown(),
    })
    try {
      host.start()
      expect(await until(() => host.status().connected)).toBe(true)
      await sleep(150)
      expect(capsPosts).toHaveLength(0) // 通道已连上,但网关还没宣告 ready → 报了也不会绑在这条连接上
      channel!.write(`event: ready\ndata: ${JSON.stringify({ caps: [] })}\n\n`)
      expect(await until(() => capsPosts.length === 1)).toBe(true)
      expect(JSON.parse(capsPosts[0])).toEqual({ engine: 'ready', tools: [] })
    } finally {
      host.stop()
      server.closeAllConnections?.()
      server.close()
    }
  })
})
