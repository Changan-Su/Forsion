/**
 * unitP2p 脊柱测试(零 electron / 零 WebRTC):A 侧本机代理 ↔ 内存对管 ↔ B 侧执行器 ↔ 真 HTTP 目标。
 * 钉:往返/鉴权/Authorization 剥离/大体积分片信用/SSE 半路先到(非空洞)/并发互不阻塞/
 *    中断=destroy 不伪装完整/协议版本失配/客户端断连传导到 B 侧。
 * 跑法:npx vitest run electron/unitP2p.test.ts
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { attachHostChannel, memoryChannelPair, startP2pProxy, P2P_PROTO_V, type FrameChannel } from './unitP2p'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** B 侧的假 unitWeb:echo / 大文件 / SSE(半路阀门)/ 半途炸 / 永挂。记录看到的请求头。 */
function fakeTarget(): Promise<{
  url: string
  seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }>
  big: Buffer
  gate: { release: () => void }
  closedPaths: string[]
  close: () => void
}> {
  const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = []
  const big = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 8)) & 0xff
  let release: () => void = () => {}
  const closedPaths: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('binary')
    req.on('data', (c: string) => { body += c })
    req.on('end', () => {
      seen.push({ path: req.url || '', headers: req.headers, body })
      res.on('close', () => { if (!res.writableEnded) closedPaths.push(req.url || '') })
      if (req.url === '/echo-bytes') {
        // 字节回声:体的 sha256 十六进制(既证到达又证逐字节完整;体本身不用传回)
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(sha(Buffer.from(body, 'binary')))
        return
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff' })
        res.end(big)
        return
      }
      if (req.url === '/sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: one\n\n')
        void new Promise<void>((r) => { release = r }).then(() => { res.write('data: two\n\n'); res.end() })
        return
      }
      if (req.url === '/explode') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '1048576' })
        res.write(Buffer.alloc(64 * 1024, 1))
        setTimeout(() => res.destroy(), 30) // 头已 flush 后断流 —— 必须以 abort 传导,绝不伪装 end
        return
      }
      if (req.url === '/drip') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        const iv = setInterval(() => { try { res.write(Buffer.alloc(64 * 1024, 3)) } catch { clearInterval(iv) } }, 5)
        res.on('close', () => clearInterval(iv))
        return
      }
      if (req.url === '/hang') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.write(Buffer.alloc(1024, 2)) // 永不 end:考「客户端断连 → B 侧中止读取」
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ echo: body, path: req.url }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, seen, big, gate: { release: () => release() }, closedPaths, close: () => server.close() })
    })
  })
}

async function boot(): Promise<{
  base: string
  secret: string
  target: Awaited<ReturnType<typeof fakeTarget>>
  hostDetach: () => void
  close: () => Promise<void>
}> {
  const target = await fakeTarget()
  const [chA, chB] = memoryChannelPair()
  const host = attachHostChannel(chB, { getUnitWeb: () => ({ url: target.url, internalSecret: 'INTERNAL' }), log: () => {} })
  const proxy = await startP2pProxy(chA)
  return {
    base: proxy.url.replace(/\/$/, ''),
    secret: proxy.secret,
    target,
    hostDetach: host.detach,
    close: async () => { await proxy.close(); target.close() },
  }
}

const authed = (secret: string, extra?: Record<string, string>): Record<string, string> =>
  ({ Authorization: `Bearer ${secret}`, ...(extra || {}) })

describe('unitP2p', () => {
  it('往返:POST 体直通,Authorization 剥离换 x-unit-internal', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.base}/unit/echo`, { method: 'POST', headers: authed(b.secret, { 'Content-Type': 'application/json' }), body: '{"a":1}' })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ echo: '{"a":1}', path: '/unit/echo' })
      const seen = b.target.seen[0]
      expect(seen.headers['x-unit-internal']).toBe('INTERNAL')
      expect(seen.headers.authorization).toBeUndefined() // 身份声明不过信道(信封面口径)
      expect(seen.headers['content-type']).toBe('application/json')
    } finally { await b.close() }
  })

  it('1MB POST 上行逐字节一致(上行分片:单帧超 256KiB 会当场杀信道)', async () => {
    const b = await boot()
    try {
      const payload = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + (i >> 7)) & 0xff
      const r = await fetch(`${b.base}/echo-bytes`, { method: 'POST', headers: authed(b.secret, { 'Content-Type': 'application/octet-stream' }), body: payload })
      expect(r.status).toBe(200)
      expect(await r.text()).toBe(sha(payload))
      // 大上行之后信道必须还活着(pre-fix 的死法是整条会话陪葬)
      const after = await fetch(`${b.base}/quick`, { headers: authed(b.secret) })
      expect(after.status).toBe(200)
    } finally { await b.close() }
  })

  it('本机代理无秘密=401(loopback 陌生进程打不动对端)', async () => {
    const b = await boot()
    try {
      expect((await fetch(`${b.base}/unit/echo`)).status).toBe(401)
      expect((await fetch(`${b.base}/unit/echo`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
      expect(b.target.seen.length).toBe(0) // 连帧都不许出
    } finally { await b.close() }
  })

  it('1MB 二进制逐字节一致(分片数 > 信用窗口,流控真跑)+ 安全头原样过', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.base}/big`, { headers: authed(b.secret) })
      expect(r.status).toBe(200)
      expect(r.headers.get('content-security-policy')).toBe('sandbox')
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      const body = Buffer.from(await r.arrayBuffer())
      expect(body.length).toBe(b.target.big.length)
      expect(sha(body)).toBe(sha(b.target.big))
    } finally { await b.close() }
  })

  it('SSE:源还开着时第一个事件就到(非空洞),放阀后收尾', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.base}/sse`, { headers: authed(b.secret) })
      expect(r.headers.get('content-type')).toContain('text/event-stream')
      const reader = r.body!.getReader()
      const dec = new TextDecoder()
      let acc = ''
      // 先证 mid-stream 送达:源的第二个事件还没放行,第一片必须已经能读到。
      while (!acc.includes('data: one')) {
        const { done, value } = await reader.read()
        expect(done).toBe(false)
        acc += dec.decode(value, { stream: true })
      }
      expect(acc).not.toContain('data: two')
      b.target.gate.release()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        acc += dec.decode(value, { stream: true })
      }
      expect(acc).toContain('data: two')
    } finally { await b.close() }
  })

  it('并发:SSE 挂着不挡小请求', async () => {
    const b = await boot()
    try {
      const sse = await fetch(`${b.base}/sse`, { headers: authed(b.secret) }) // 挂住不放阀
      const quick = await fetch(`${b.base}/quick`, { headers: authed(b.secret) })
      expect((await quick.json() as { path: string }).path).toBe('/quick')
      b.target.gate.release()
      await sse.body?.cancel()
    } finally { await b.close() }
  })

  it('目标半途断流 → A 侧连接被 destroy(截断绝不伪装完整)', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.base}/explode`, { headers: authed(b.secret) })
      expect(r.status).toBe(200) // 头先到
      await expect(r.arrayBuffer()).rejects.toThrow() // 体必须以错误终止,不是「短了的 200」
    } finally { await b.close() }
  })

  it('客户端断连传导到 B 侧(目标的响应被掐,不再泄流)', async () => {
    const b = await boot()
    try {
      const ctrl = new AbortController()
      const r = await fetch(`${b.base}/hang`, { headers: authed(b.secret), signal: ctrl.signal })
      expect(r.status).toBe(200)
      ctrl.abort()
      await new Promise((r2) => setTimeout(r2, 80))
      expect(b.target.closedPaths).toContain('/hang')
    } finally { await b.close() }
  })

  it('零信用等待可被 abort 唤醒:泵不再悬挂,目标读取被掐(Codex H4)', async () => {
    const target = await fakeTarget()
    const [chA, chB] = memoryChannelPair()
    const host = attachHostChannel(chB, { getUnitWeb: () => ({ url: target.url, internalSecret: 'I' }), log: () => {} })
    let chunks = 0
    let aborted = false
    chA.onMessage((text) => {
      const f = JSON.parse(text) as { t: string; id?: string }
      if (f.t === 'chunk' && !aborted) {
        chunks += 1
        // 一片信用都不还:初始窗口(4)烧完泵必进零信用等待。⚠️ abort 不能贴着第 4 片发——
        // 那会落进泵的 read 等待窗(ctrl.abort 拒绝 read 走 catch 清账,绕过唤醒路径=测不到)。
        // 停 150ms:泵完成最后一次 read 后铁定停进 takeCredit,再 abort 才考到唤醒本身。
        if (chunks >= 4) {
          aborted = true
          setTimeout(() => chA.send(JSON.stringify({ t: 'abort', id: f.id })), 150)
        }
      }
    })
    chA.send(JSON.stringify({ t: 'hello', v: P2P_PROTO_V, caps: [] }))
    chA.send(JSON.stringify({ t: 'req', id: 'drip-1', method: 'GET', path: '/drip' }))
    try {
      // 泄漏的本体:泵悬在零信用 await 到不了 finally → credits 账本永不清空。
      // (光断言目标连接被掐是空洞的 —— ctrl.abort() 自己就会掐连接,变异下照样绿;首版栽过。)
      await new Promise<void>((resolve, reject) => {
        const t0 = Date.now()
        const iv = setInterval(() => {
          const st = host.stats()
          if (st.credits === 0 && st.inflight === 0 && target.closedPaths.includes('/drip')) { clearInterval(iv); resolve() }
          else if (Date.now() - t0 > 3000) { clearInterval(iv); reject(new Error(`abort 没能唤醒零信用等待:3s 后账本仍 ${JSON.stringify(st)}`)) }
        }, 25)
      })
      expect(chunks).toBeLessThan(8) // 信用真的拦住了(没被继续硬发)
    } finally { chA.close(); target.close() }
  })

  it('上传半途断线 → 一帧不出,B 侧看不到这次请求(截断体绝不执行,Codex H5)', async () => {
    const b = await boot()
    try {
      const port = Number(new URL(b.base).port)
      // 裸 socket:声明 100KB 只发 8KB 就断 —— 'error'/'aborted' 绝不能当正常 EOF 转发部分体
      const net = await import('node:net')
      await new Promise<void>((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(`POST /unit/echo HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${b.secret}\r\nContent-Type: application/octet-stream\r\nContent-Length: 100000\r\n\r\n`)
          sock.write(Buffer.alloc(8 * 1024, 9))
          setTimeout(() => { sock.destroy(); resolve() }, 60)
        })
        sock.on('error', () => resolve())
      })
      await new Promise((r) => setTimeout(r, 200))
      expect(b.target.seen.filter((x) => x.path === '/unit/echo').length).toBe(0)
      // 信道没陪葬:后续请求照常
      expect((await fetch(`${b.base}/quick`, { headers: authed(b.secret) })).status).toBe(200)
    } finally { await b.close() }
  })

  it('协议版本失配 → 信道关闭,请求以可读错误失败', async () => {
    const target = await fakeTarget()
    const [chA, chB] = memoryChannelPair()
    // B 端不是执行器,是一个只会报错误版本号的假对端。
    const evil: FrameChannel = chB
    evil.onMessage(() => { /* 吞 */ })
    evil.send(JSON.stringify({ t: 'hello', v: P2P_PROTO_V + 1, caps: [] }))
    const proxy = await startP2pProxy(chA)
    try {
      const r = await fetch(`${proxy.url}unit/echo`, { headers: authed(proxy.secret) })
      expect(r.status).toBe(502) // 信道被版本闸关掉 → 请求就地 502,绝不静默挂死
    } finally { await proxy.close(); target.close() }
  })

  it('detach(身份变化)后:在飞 SSE 中断,新请求 502', async () => {
    const b = await boot()
    try {
      const sse = await fetch(`${b.base}/sse`, { headers: authed(b.secret) })
      expect(sse.status).toBe(200)
      b.hostDetach() // 模拟 B 侧登出/换号:refreshUnitHost 收掉全部 P2P 对端
      await expect((async () => {
        const reader = sse.body!.getReader()
        for (;;) { const { done } = await reader.read(); if (done) break }
      })()).rejects.toThrow() // 挂着的流以错误终止
      const after = await fetch(`${b.base}/quick`, { headers: authed(b.secret) })
      expect(after.status).toBe(502)
    } finally { await b.close() }
  })
})
