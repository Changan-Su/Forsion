/**
 * unitWeb 脊柱测试(真 HTTP 全链,零 electron):配对流(6 位码/限速/拒绝/令牌一次性)、
 * 鉴权(配对令牌 hash / loopback+内部密钥豁免)、/engine 反代盖章 + 请求体直通 + SSE 边收边转、
 * index.html unit 标记注入、路径穿越拒绝、缺构建提示页。
 * 跑法:npx vitest run electron/unitWeb.test.ts
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startUnitWeb, type PairedDevice, type UnitWebDeps } from './unitWeb'

function fakeEngine(): Promise<{ url: string; gate: { release(): void }; seen: Array<{ path: string; auth: string; body: string }>; close(): void }> {
  let release: () => void = () => {}
  const seen: Array<{ path: string; auth: string; body: string }> = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ path: req.url || '', auth: String(req.headers.authorization || ''), body })
      if (req.url?.startsWith('/agent/sse')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: one\n\n')
        void new Promise<void>((r) => { release = r }).then(() => { res.write('data: two\n\n'); res.end() })
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ echo: body }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, gate: { release: () => release() }, seen, close: () => server.close() })
    })
  })
}

interface Boot {
  base: string
  handle: Awaited<ReturnType<typeof startUnitWeb>>
  paired: PairedDevice[]
  approve: (ok: boolean) => void
  engine: Awaited<ReturnType<typeof fakeEngine>>
  close: () => void
}

async function boot(distDir: string | null = null): Promise<Boot> {
  const engine = await fakeEngine()
  const paired: PairedDevice[] = []
  let approveFn: (ok: boolean) => void = () => {}
  const deps: UnitWebDeps = {
    getEngine: () => ({ url: engine.url, token: 'ENGINE_TOKEN' }),
    confirmPair: () => new Promise<boolean>((r) => { approveFn = r }),
    pairedDevices: { list: () => paired, add: async (d) => { paired.push(d) } },
    readPlugins: async () => [{ id: 'demo' }],
    meta: { instanceId: 'inst-1', name: '测试机', version: '9.9.9' },
    webDistDir: () => distDir,
    log: () => {},
  }
  const handle = await startUnitWeb(deps, { port: 0, bindHost: '127.0.0.1' })
  return { base: `http://127.0.0.1:${handle.port}`, handle, paired, approve: (ok) => approveFn(ok), engine, close: () => { void handle.close(); engine.close() } }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('unitWeb', () => {
  it('公开面:meta 可读;缺构建出提示页', async () => {
    const b = await boot()
    try {
      const meta = await (await fetch(`${b.base}/unit/meta`)).json() as any
      expect(meta.instanceId).toBe('inst-1')
      const home = await (await fetch(`${b.base}/`)).text()
      expect(home).toContain('未捆 web 构建')
    } finally { b.close() }
  })

  it('配对流:6 位码、同 IP 限速、批准发令牌(一次性)、whoami 过闸;拒绝路径', async () => {
    const b = await boot()
    try {
      const r1 = await (await fetch(`${b.base}/unit/pair/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '设备甲' }) })).json() as any
      expect(r1.code).toMatch(/^\d{6}$/)
      // 同 IP 第二个待确认 → 429
      const r2 = await fetch(`${b.base}/unit/pair/request`, { method: 'POST', body: '{}' })
      expect(r2.status).toBe(429)
      // pending → 批准 → approved+token
      let poll = await (await fetch(`${b.base}/unit/pair/poll?id=${r1.requestId}`)).json() as any
      expect(poll.status).toBe('pending')
      b.approve(true)
      await tick()
      poll = await (await fetch(`${b.base}/unit/pair/poll?id=${r1.requestId}`)).json() as any
      expect(poll.status).toBe('approved')
      expect(poll.token).toBeTruthy()
      expect(b.paired[0].name).toBe('设备甲')
      expect(b.paired[0].tokenHash).not.toBe(poll.token) // 库里只有 hash
      // 令牌只下发一次
      const again = await (await fetch(`${b.base}/unit/pair/poll?id=${r1.requestId}`)).json() as any
      expect(again.status).toBe('expired')
      // whoami:对的过、错的拒
      expect((await fetch(`${b.base}/unit/whoami`, { headers: { Authorization: `Bearer ${poll.token}` } })).status).toBe(200)
      expect((await fetch(`${b.base}/unit/whoami`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
      // 拒绝路径
      const d1 = await (await fetch(`${b.base}/unit/pair/request`, { method: 'POST', body: JSON.stringify({ name: '设备乙' }) })).json() as any
      b.approve(false)
      await tick()
      const dp = await (await fetch(`${b.base}/unit/pair/poll?id=${d1.requestId}`)).json() as any
      expect(dp.status).toBe('denied')
    } finally { b.close() }
  })

  it('/engine 反代:未配对 401;配对后盖引擎 token + 请求体直通;内部密钥(loopback)豁免', async () => {
    const b = await boot()
    try {
      expect((await fetch(`${b.base}/engine/agent/echo`, { method: 'POST', body: '{}' })).status).toBe(401)
      const req = await (await fetch(`${b.base}/unit/pair/request`, { method: 'POST', body: JSON.stringify({ name: 'A' }) })).json() as any
      b.approve(true)
      await tick()
      const { token } = await (await fetch(`${b.base}/unit/pair/poll?id=${req.requestId}`)).json() as any
      const r = await fetch(`${b.base}/engine/agent/echo`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ hello: '扶桑' }) })
      expect(r.status).toBe(200)
      expect(((await r.json()) as any).echo).toContain('扶桑')
      const hit = b.engine.seen.find((s) => s.path === '/agent/echo')!
      expect(hit.auth).toBe('Bearer ENGINE_TOKEN') // 盖的是引擎 token,不是配对令牌
      // 内部密钥豁免(测试即 loopback 来源)
      const r2 = await fetch(`${b.base}/unit/plugins`, { headers: { 'x-unit-internal': b.handle.internalSecret } })
      expect(r2.status).toBe(200)
      expect(((await r2.json()) as any).plugins[0].id).toBe('demo')
      // 错的内部密钥不豁免
      expect((await fetch(`${b.base}/unit/plugins`, { headers: { 'x-unit-internal': 'nope' } })).status).toBe(401)
    } finally { b.close() }
  })

  it('SSE 边收边转:第一帧先于引擎收尾到达', async () => {
    const b = await boot()
    try {
      const req = await (await fetch(`${b.base}/unit/pair/request`, { method: 'POST', body: '{}' })).json() as any
      b.approve(true)
      await tick()
      const { token } = await (await fetch(`${b.base}/unit/pair/poll?id=${req.requestId}`)).json() as any
      const r = await fetch(`${b.base}/engine/agent/sse`, { headers: { Authorization: `Bearer ${token}` } })
      expect(String(r.headers.get('content-type'))).toContain('text/event-stream')
      const reader = r.body!.getReader()
      const dec = new TextDecoder()
      let seen = ''
      while (!seen.includes('data: one')) {
        const { done, value } = await reader.read()
        expect(done).toBe(false)
        seen += dec.decode(value, { stream: true })
      }
      expect(seen.includes('data: two')).toBe(false)
      b.engine.gate.release()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        seen += dec.decode(value, { stream: true })
      }
      expect(seen).toContain('data: two')
    } finally { b.close() }
  })

  it('静态壳:index 注入 unit 标记;SPA 回退;路径穿越拒绝', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'unitweb-'))
    await writeFile(join(dist, 'index.html'), '<html><head></head><body>shell</body></html>')
    const b = await boot(dist)
    try {
      const home = await (await fetch(`${b.base}/`)).text()
      expect(home).toContain('__FORSION_UNIT_PAGE__')
      expect(home).toContain('inst-1')
      const spa = await (await fetch(`${b.base}/some/route`)).text() // 无扩展名 → index
      expect(spa).toContain('shell')
      // 带扩展名才走文件分支(无扩展名的会被 SPA 回退兜成 index,本身无害):穿越必须被拒。
      expect((await fetch(`${b.base}/..%2f..%2fsecret.txt`)).status).toBeGreaterThanOrEqual(400)
    } finally { b.close() }
  })
})
