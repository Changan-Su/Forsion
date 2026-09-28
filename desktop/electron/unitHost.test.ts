/**
 * unitHost 通道在线真实性(设备能力 MCP 方案 §3.2 / P0 ⑦),真 HTTP、零 electron:
 *   - 读看门狗:通道一段时间一个字节都没有(网关 15s 心跳停了 = 半开连接)→ 断开重连;有心跳则不动;
 *   - reconnect()(powerMonitor resume):立即重拨,不等看门狗、不等退避;
 *   - 每信封 AbortController:abortEnvelope(id) 中止在飞的本机请求;通道拆除时这条连接收下的在飞信封全部中止。
 * 跑法:npx vitest run electron/unitHost.test.ts
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { UnitHost } from './unitHost'
import { verifyProxyCaller, type ProxyCaller } from './unitCaller'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) return false
    await sleep(20)
  }
  return true
}

type ChannelMode = 'silent' | 'heartbeat' | 'noheaders'
interface Hub {
  url: string
  channels: http.ServerResponse[]
  registers: http.ServerResponse[]
  streamed: string[]
  /** holdResp = /resp/ 收下不回(网关半开);respClosed 记下被客户端掐掉的 /resp/ 请求。 */
  holdResp: boolean
  respClosed: string[]
  mode: ChannelMode
  dispatch: (env: { id: string; method: string; path: string; accept?: string; proxyCaller?: unknown }) => void
  endChannel: () => void
  close: () => void
}

/** 假网关:/channel 按 mode 保持静默或每 50ms 写 `: hb`;/stream 与 /resp 收下并记账。 */
function fakeHub(): Promise<Hub> {
  const channels: http.ServerResponse[] = []
  const registers: http.ServerResponse[] = []
  const streamed: string[] = []
  const timers = new Set<ReturnType<typeof setInterval>>()
  const respClosed: string[] = []
  const hub: Partial<Hub> = { channels, registers, streamed, respClosed, holdResp: false, mode: 'silent' }
  const server = http.createServer((req, res) => {
    const url = req.url || ''
    if (url.endsWith('/units/register')) { registers.push(res); return } // 挂住:由测试决定何时回
    if (url.endsWith('/channel')) {
      if (hub.mode === 'noheaders') { channels.push(res); return } // TCP 接了,响应头永远不来
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      channels.push(res)
      if (hub.mode === 'heartbeat') {
        const t = setInterval(() => { try { res.write(': hb\n\n') } catch { /* closed */ } }, 50)
        timers.add(t)
        res.on('close', () => { clearInterval(t); timers.delete(t) })
      }
      return
    }
    if (url.includes('/resp/') && hub.holdResp) {
      streamed.push(url.split('?')[0])
      req.on('data', () => {})
      res.on('close', () => { if (!res.writableEnded) respClosed.push(url) })
      return
    }
    if (url.includes('/stream/') || url.includes('/resp/')) {
      streamed.push(url.split('?')[0])
      req.on('data', () => {})
      req.on('end', () => { res.writeHead(200); res.end() })
      req.on('error', () => {})
      return
    }
    res.writeHead(404); res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      Object.assign(hub, {
        url: `http://127.0.0.1:${port}`,
        dispatch: (env: { id: string; method: string; path: string; accept?: string; proxyCaller?: unknown }) => {
          channels.at(-1)!.write(`event: dispatch\ndata: ${JSON.stringify({ body: null, ...env })}\n\n`)
        },
        endChannel: () => channels.at(-1)!.end(),
        close: () => { for (const t of timers) clearInterval(t); for (const c of [...channels, ...registers]) c.destroy(); server.close() },
      })
      resolve(hub as Hub)
    })
  })
}

/** 假本机 unitWeb:/hang 回 event-stream 头 + 一帧后永不结束;记录连接被掐(req close 而响应未结束)。 */
function fakeUnitWeb(): Promise<{ url: string; hits: string[]; cut: string[]; close: () => void }> {
  const hits: string[] = []
  const cut: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url || '')
    if (req.url === '/small') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 2 }); res.end('{}'); return }
    if (req.url === '/silent') { // 事件流头已回、首块迟迟不来
      res.on('close', () => { if (!res.writableEnded) cut.push(req.url || '') })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return
    }
    res.on('close', () => { if (!res.writableEnded) cut.push(req.url || '') })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: one\n\n')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, hits, cut, close: () => { server.closeAllConnections(); server.close() } })
    })
  })
}

function host(hub: Hub, web: { url: string } | null, readIdleMs: number, opts?: { unpaired?: boolean; requestTimeoutMs?: number; hubFetch?: typeof fetch; proxyCallerKey?: string }): { h: UnitHost; logs: string[]; saved: unknown[] } {
  const logs: string[] = []
  const saved: unknown[] = []
  const h = new UnitHost({
    getCreds: () => ({ cloudUrl: hub.url, token: 'tok' }),
    getUnitWeb: () => ({ url: web?.url ?? null, internalSecret: 'INTERNAL', proxyCallerKey: opts?.proxyCallerKey ?? '' }),
    getLanUrl: () => null,
    getPairing: () => (opts?.unpaired ? null : { unitId: 'u1', secret: 's1' }),
    savePairing: async (p) => { saved.push(p) },
    clearPairing: async () => {},
    log: (m) => logs.push(m),
    readIdleMs,
    ...(opts?.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    ...(opts?.hubFetch ? { hubFetch: opts.hubFetch } : {}),
  })
  return { h, logs, saved }
}

describe('UnitHost 通道看门狗 / 唤醒重连 / 信封中止', () => {
  it('读看门狗:通道静默超过 readIdleMs → 断开并重拨', async () => {
    const hub = await fakeHub()
    const { h, logs } = host(hub, null, 300)
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      // 300ms 看门狗 + 1s 退避 → 第二条连接
      expect(await until(() => hub.channels.length >= 2, 4000)).toBe(true)
      expect(logs.some((l) => l.includes('判定已断'))).toBe(true)
    } finally { h.stop(); hub.close() }
  })

  it('看门狗从发起连接就计时:TCP 接了但网关迟迟不回响应头,同样断开重拨', async () => {
    const hub = await fakeHub()
    hub.mode = 'noheaders'
    const { h, logs } = host(hub, null, 300)
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      expect(await until(() => hub.channels.length >= 2, 4000)).toBe(true)
      expect(logs.some((l) => l.includes('未收到响应头'))).toBe(true)
    } finally { h.stop(); hub.close() }
  })

  it('入册在途时 stop()(停用 / 换账号):入册请求被中止,旧那一轮的配对绝不写回', async () => {
    const hub = await fakeHub()
    const { h, saved } = host(hub, null, 0, { unpaired: true })
    try {
      h.start()
      expect(await until(() => hub.registers.length === 1)).toBe(true)
      h.stop()
      await sleep(50)
      // 网关这时才回(旧写法:fetch 不带信号,照样拿到并 savePairing 写回旧账号的配对)
      const res = hub.registers[0]
      if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ unitId: 'u-old', secret: 's-old' })) }
      await sleep(200)
      expect(saved).toEqual([])
      expect(hub.channels.length).toBe(0)
    } finally { h.stop(); hub.close() }
  })

  it('有心跳就不动:网关按时写 `: hb`,看门狗不误杀', async () => {
    const hub = await fakeHub()
    hub.mode = 'heartbeat'
    const { h } = host(hub, null, 300)
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      await sleep(1500)
      expect(hub.channels.length).toBe(1)
      expect(h.status().connected).toBe(true)
    } finally { h.stop(); hub.close() }
  })

  it('reconnect()(系统唤醒):立即重拨,不等看门狗也不等退避', async () => {
    const hub = await fakeHub()
    const { h } = host(hub, null, 0) // 看门狗关:只靠 reconnect
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      const t0 = Date.now()
      h.reconnect('resume')
      expect(await until(() => hub.channels.length === 2, 800)).toBe(true)
      expect(Date.now() - t0).toBeLessThan(800) // 退避是 1s 起步:能在它之前连上 = 真跳过了退避
      // 退避等待中(网关把通道关了)也能被唤醒
      hub.endChannel()
      await sleep(100)
      h.reconnect('resume')
      expect(await until(() => hub.channels.length === 3, 800)).toBe(true)
    } finally { h.stop(); hub.close() }
  })

  it('abortEnvelope(id):按信封 id 中止在飞的本机请求;未知 id 返回 false', async () => {
    const hub = await fakeHub()
    const web = await fakeUnitWeb()
    const { h } = host(hub, web, 0)
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-1', method: 'GET', path: '/hang-1', accept: 'text/event-stream' })
      expect(await until(() => web.hits.includes('/hang-1'))).toBe(true)
      expect(await until(() => hub.streamed.some((p) => p.endsWith('/stream/env-1')))).toBe(true)
      expect(h.abortEnvelope('nope')).toBe(false)
      expect(h.abortEnvelope('env-1')).toBe(true)
      expect(await until(() => web.cut.includes('/hang-1'))).toBe(true)
      expect(h.abortEnvelope('env-1')).toBe(false) // 已摘除
    } finally { h.stop(); web.close(); hub.close() }
  })

  it('通道拆除:这条连接收下的在飞信封全部中止(本机 unitWeb 的长请求被掐)', async () => {
    const hub = await fakeHub()
    const web = await fakeUnitWeb()
    const { h } = host(hub, web, 0)
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-a', method: 'GET', path: '/hang-a', accept: 'text/event-stream' })
      hub.dispatch({ id: 'env-b', method: 'GET', path: '/hang-b', accept: 'text/event-stream' })
      expect(await until(() => web.hits.includes('/hang-a') && web.hits.includes('/hang-b'))).toBe(true)
      expect(web.cut).toEqual([])
      hub.endChannel() // 网关侧通道结束(重启 / 顶替 / 1h 上限)
      expect(await until(() => web.cut.includes('/hang-a') && web.cut.includes('/hang-b'))).toBe(true)
    } finally { h.stop(); web.close(); hub.close() }
  })

  // ── 评审 A-desktop#4:入册 / 回包 / 流式回传的时限 ──
  it('入册挂住(网关收下不回):按看门狗时限中止并重试,不会一直挂到下一次唤醒', async () => {
    const hub = await fakeHub()
    const { h, logs, saved } = host(hub, null, 300, { unpaired: true })
    try {
      h.start()
      expect(await until(() => hub.registers.length === 1)).toBe(true)
      // 300ms 时限 + 1s 退避 → 第二次入册
      expect(await until(() => hub.registers.length >= 2, 4000)).toBe(true)
      expect(logs.some((l) => l.includes('入册') && l.includes('未返回'))).toBe(true)
      expect(saved).toEqual([])
    } finally { h.stop(); hub.close() }
  })

  it('整包回包挂住(网关半开):到时限掐掉 /resp/ 请求', async () => {
    const hub = await fakeHub()
    hub.holdResp = true
    const web = await fakeUnitWeb()
    const { h, logs } = host(hub, web, 0, { requestTimeoutMs: 150 }) // 回包时限 = 2 × 150ms
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-s', method: 'GET', path: '/small' })
      expect(await until(() => hub.streamed.some((p) => p.endsWith('/resp/env-s')))).toBe(true)
      expect(await until(() => hub.respClosed.some((p) => p.endsWith('/resp/env-s')), 3000)).toBe(true)
      expect(logs.some((l) => l.includes('回包失败') && l.includes('未完成'))).toBe(true)
    } finally { h.stop(); web.close(); hub.close() }
  })

  // ── Codex 终审 out1 #3:中止信封也要掐掉已经在上传的整包回包(否则最长还能挂 2 × requestTimeoutMs)──
  it('abortEnvelope(id) 撤销正在上传的整包回包:/resp/ 请求立即被掐,不等 2 × requestTimeoutMs', async () => {
    const hub = await fakeHub()
    hub.holdResp = true // 网关收下 /resp/ 不回:回包一直在飞
    const web = await fakeUnitWeb()
    const { h, logs } = host(hub, web, 0, { requestTimeoutMs: 60_000 }) // 时限 120s:测试窗口内绝不会是超时掐的
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-r', method: 'GET', path: '/small' })
      expect(await until(() => hub.streamed.some((p) => p.endsWith('/resp/env-r')))).toBe(true)
      expect(hub.respClosed).toEqual([])
      expect(h.abortEnvelope('env-r')).toBe(true) // 仍在飞(回包没完成)
      expect(await until(() => hub.respClosed.some((p) => p.endsWith('/resp/env-r')), 1500)).toBe(true)
      expect(logs.some((l) => l.includes('回包失败'))).toBe(false) // 撤销不是失败,不刷日志
    } finally { h.stop(); web.close(); hub.close() }
  })

  it('通道拆除时正在上传的整包回包一并掐掉', async () => {
    const hub = await fakeHub()
    hub.holdResp = true
    const web = await fakeUnitWeb()
    const { h } = host(hub, web, 0, { requestTimeoutMs: 60_000 })
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-t', method: 'GET', path: '/small' })
      expect(await until(() => hub.streamed.some((p) => p.endsWith('/resp/env-t')))).toBe(true)
      hub.endChannel()
      expect(await until(() => hub.respClosed.some((p) => p.endsWith('/resp/env-t')), 1500)).toBe(true)
    } finally { h.stop(); web.close(); hub.close() }
  })

  it('信封在本机请求返回后、回包发出前就被撤销:根本不发 /resp/', async () => {
    const hub = await fakeHub()
    const web = await fakeUnitWeb()
    const respPosts: string[] = []
    let hostRef: UnitHost | null = null
    const hubFetch = ((input: string, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('/resp/')) respPosts.push(String(input))
      return fetch(input, init)
    }) as typeof fetch
    // 本机 unitWeb 的回包体读完那一刻撤销信封(模拟网关 cancel 帧恰好落在「本机已回、回包未发」之间)
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const r = await origFetch(input, init)
      if (String(input).startsWith(web.url) && String(input).endsWith('/small')) {
        const buf = await r.arrayBuffer()
        hostRef?.abortEnvelope('env-p')
        return new Response(buf, { status: r.status, headers: r.headers })
      }
      return r
    }) as typeof fetch
    const { h } = host(hub, web, 0, { requestTimeoutMs: 60_000, hubFetch })
    hostRef = h
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-p', method: 'GET', path: '/small' })
      expect(await until(() => web.hits.includes('/small'))).toBe(true)
      await sleep(300)
      expect(respPosts).toEqual([])
    } finally { globalThis.fetch = origFetch; h.stop(); web.close(); hub.close() }
  })

  it('流式回传连不上网关(请求体一直没被拉):到时限中止本次派发,本机引擎读取被掐', async () => {
    const hub = await fakeHub()
    const web = await fakeUnitWeb()
    const stalled: string[] = []
    const hubFetch = ((input: string, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/stream/')) return fetch(input, init)
      stalled.push(String(input))
      // 连接永远建不起来:不拉请求体、不回响应,只认中止信号(= 半开 / 黑洞网络)
      return new Promise<Response>((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))) })
    }) as typeof fetch
    const { h, logs } = host(hub, web, 0, { requestTimeoutMs: 200, hubFetch })
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-x', method: 'GET', path: '/hang-x', accept: 'text/event-stream' })
      expect(await until(() => stalled.length === 1)).toBe(true)
      expect(await until(() => web.cut.includes('/hang-x'), 3000)).toBe(true)
      expect(logs.some((l) => l.includes('未把首块写给网关'))).toBe(true)
      expect(h.abortEnvelope('env-x')).toBe(false) // 已摘除
    } finally { h.stop(); web.close(); hub.close() }
  })

  it('流式回传:上传端只拉了第一块(首块还没到,请求头还没写出)不算连上,到时限照样中止(Codex 三轮 P1)', async () => {
    const hub = await fakeHub()
    const web = await fakeUnitWeb()
    let pulledOnce = 0
    const hubFetch = ((input: string, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/stream/')) return fetch(input, init)
      // 模拟 undici:连接建立后先拉第一块,拿到之前请求头不写出;这里首块永远不来
      const rd = (init!.body as ReadableStream<Uint8Array>).getReader()
      pulledOnce++
      void rd.read().catch(() => {})
      return new Promise<Response>((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))) })
    }) as typeof fetch
    const { h, logs } = host(hub, web, 0, { requestTimeoutMs: 200, hubFetch })
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-q', method: 'GET', path: '/silent', accept: 'text/event-stream' })
      expect(await until(() => pulledOnce === 1)).toBe(true)
      expect(await until(() => web.cut.includes('/silent'), 3000)).toBe(true)
      expect(logs.some((l) => l.includes('未把首块写给网关'))).toBe(true)
    } finally { h.stop(); web.close(); hub.close() }
  })

  it('流式回传连上了(真 fetch 真网关):时限只管「开始上传」,长事件流过了时限照样开着', async () => {
    const hub = await fakeHub()
    const web = await fakeUnitWeb()
    const { h } = host(hub, web, 0, { requestTimeoutMs: 200 })
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-l', method: 'GET', path: '/hang-l', accept: 'text/event-stream' })
      expect(await until(() => hub.streamed.some((p) => p.endsWith('/stream/env-l')))).toBe(true)
      await sleep(800) // 4 倍时限
      expect(web.cut).not.toContain('/hang-l')
      expect(h.abortEnvelope('env-l')).toBe(true) // 仍在飞
    } finally { h.stop(); web.close(); hub.close() }
  })

  // ── P1 · K1:信封 proxyCaller → x-unit-caller ──────────────────────────────────
  const PHONE: ProxyCaller = { unit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', kind: 'phone', name: 'Pixel', platform: 'android', registeredAt: null }
  /** 记录型本机 unitWeb:收到的原始请求目标、方法与头。 */
  function recordingWeb(): Promise<{ url: string; got: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>; close: () => void }> {
    const got: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = []
    const server = http.createServer((req, res) => {
      got.push({ method: req.method || '', url: req.url || '', headers: req.headers })
      req.resume()
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 2 }); res.end('{}')
    })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, got, close: () => { server.closeAllConnections(); server.close() },
    })))
  }

  it('K1 S8 签名绑定**实际发出**的请求:会被 URL 规整的点段 / 空格 query 签的是规整后的目标,unitWeb 收到的 req.url 验得过', async () => {
    const hub = await fakeHub()
    const web = await recordingWeb()
    const { h } = host(hub, web, 0, { proxyCallerKey: 'PCK' })
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      hub.dispatch({ id: 'env-s8', method: 'POST', path: '/engine/./agent/runs?q=a b&x=%41', proxyCaller: PHONE })
      expect(await until(() => web.got.length === 1)).toBe(true)
      const hit = web.got[0]
      expect(hit.url).toBe('/engine/agent/runs?q=a%20b&x=%41') // 发出去的目标已被 URL 规整
      const v = verifyProxyCaller('PCK', String(hit.headers['x-unit-caller']), { method: hit.method, url: hit.url }, new Map())
      expect(v).toEqual({ ok: true, caller: PHONE, dispatchId: 'env-s8' })
      // 直接签原始 env.path 的实现在这里必红:
      expect(verifyProxyCaller('PCK', String(hit.headers['x-unit-caller']), { method: 'POST', url: '/engine/./agent/runs?q=a b&x=%41' }, new Map()).ok).toBe(false)
      // SSRF:信封 path 是 `//host/x` 时,请求仍只发到本机 unitWeb(主机不被相对解析换掉)
      hub.dispatch({ id: 'env-ssrf', method: 'GET', path: '//evil.example/engine/agent/sessions', proxyCaller: PHONE })
      expect(await until(() => web.got.length === 2)).toBe(true)
      expect(web.got[1].url).toBe('//evil.example/engine/agent/sessions')
    } finally { h.stop(); web.close(); hub.close() }
  })

  it('K1 S7 /unit/mcp* 永不带 proxy 断言;没有 proxyCaller / 钥未就绪不签;畸形 proxyCaller 丢弃并只记一次日志', async () => {
    const hub = await fakeHub()
    const web = await recordingWeb()
    const { h, logs } = host(hub, web, 0, { proxyCallerKey: 'PCK' })
    try {
      h.start()
      expect(await until(() => hub.channels.length === 1)).toBe(true)
      for (const path of ['/unit/mcp', '/unit/mcp/tools/call', '/UNIT//mcp', '/unit/%6dcp']) hub.dispatch({ id: `mcp-${path}`, method: 'POST', path, proxyCaller: PHONE })
      hub.dispatch({ id: 'plain', method: 'GET', path: '/engine/agent/sessions' })
      hub.dispatch({ id: 'bad-1', method: 'GET', path: '/engine/agent/sessions', proxyCaller: { unit: 'not-a-uuid', kind: 'phone' } })
      hub.dispatch({ id: 'bad-2', method: 'GET', path: '/engine/agent/sessions', proxyCaller: 'phone' })
      hub.dispatch({ id: 'ok', method: 'GET', path: '/unit/remote-access', proxyCaller: PHONE })
      expect(await until(() => web.got.length === 8)).toBe(true)
      for (const g of web.got) {
        const signed = g.headers['x-unit-caller'] !== undefined
        expect(signed, g.url).toBe(g.url === '/unit/remote-access')
      }
      expect(logs.filter((l) => l.includes('调用方字段不合法')).length).toBe(1)
    } finally { h.stop(); web.close(); hub.close() }
    const hub2 = await fakeHub()
    const web2 = await recordingWeb()
    const { h: h2 } = host(hub2, web2, 0) // proxyCallerKey 缺省 '' = unitWeb 还没起好
    try {
      h2.start()
      expect(await until(() => hub2.channels.length === 1)).toBe(true)
      hub2.dispatch({ id: 'nokey', method: 'GET', path: '/engine/agent/sessions', proxyCaller: PHONE })
      expect(await until(() => web2.got.length === 1)).toBe(true)
      expect(web2.got[0].headers['x-unit-caller']).toBeUndefined()
    } finally { h2.stop(); web2.close(); hub2.close() }
  })
})
