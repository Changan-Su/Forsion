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
  mode: ChannelMode
  dispatch: (env: { id: string; method: string; path: string; accept?: string }) => void
  endChannel: () => void
  close: () => void
}

/** 假网关:/channel 按 mode 保持静默或每 50ms 写 `: hb`;/stream 与 /resp 收下并记账。 */
function fakeHub(): Promise<Hub> {
  const channels: http.ServerResponse[] = []
  const registers: http.ServerResponse[] = []
  const streamed: string[] = []
  const timers = new Set<ReturnType<typeof setInterval>>()
  const hub: Partial<Hub> = { channels, registers, streamed, mode: 'silent' }
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
        dispatch: (env: { id: string; method: string; path: string; accept?: string }) => {
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

function host(hub: Hub, web: { url: string } | null, readIdleMs: number, opts?: { unpaired?: boolean }): { h: UnitHost; logs: string[]; saved: unknown[] } {
  const logs: string[] = []
  const saved: unknown[] = []
  const h = new UnitHost({
    getCreds: () => ({ cloudUrl: hub.url, token: 'tok' }),
    getUnitWeb: () => ({ url: web?.url ?? null, internalSecret: 'INTERNAL' }),
    getLanUrl: () => null,
    getPairing: () => (opts?.unpaired ? null : { unitId: 'u1', secret: 's1' }),
    savePairing: async (p) => { saved.push(p) },
    clearPairing: async () => {},
    log: (m) => logs.push(m),
    readIdleMs,
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
})
