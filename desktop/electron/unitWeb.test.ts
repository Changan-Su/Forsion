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
import { IPC } from '@amadeus-shared/ipc'
import type { VaultFace } from './amadeus/ipc'
import { startUnitWeb, VAULT_RPC_ALLOW, type PairedDevice, type UnitWebDeps } from './unitWeb'

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
  vaultCalls: Array<{ ch: string; args: unknown[] }>
  emitVault: (ch: string, payload?: unknown) => void
  close: () => void
}

async function boot(distDir: string | null = null, assetFile?: string): Promise<Boot> {
  const engine = await fakeEngine()
  const paired: PairedDevice[] = []
  let approveFn: (ok: boolean) => void = () => {}
  const vaultCalls: Array<{ ch: string; args: unknown[] }> = []
  const vaultSubs = new Set<(ch: string, payload?: unknown) => void>()
  const vault: VaultFace = {
    call: async (ch, args) => {
      vaultCalls.push({ ch, args })
      if (ch === IPC.listPages) return ['甲.md', '乙.md']
      if (ch === IPC.readVaultBytes) return Buffer.from([1, 2, 254])
      if (ch === IPC.saveVaultBytes) return undefined
      if (ch === IPC.deletePage) throw new Error('测试炸点')
      return null
    },
    onEvent: (cb) => { vaultSubs.add(cb); return () => { vaultSubs.delete(cb) } },
    assetAbs: async (_page, ref) => (ref === 'pic.png' && assetFile ? assetFile : null),
    absPath: (rel) => {
      if (rel.includes('..')) throw new Error('escape')
      return assetFile || `/nonexistent/${rel}`
    },
  }
  const deps: UnitWebDeps = {
    getEngine: () => ({ url: engine.url, token: 'ENGINE_TOKEN' }),
    confirmPair: () => new Promise<boolean>((r) => { approveFn = r }),
    pairedDevices: { list: () => paired, add: async (d) => { paired.push(d) } },
    readPlugins: async () => [{ id: 'demo' }],
    meta: { instanceId: 'inst-1', name: '测试机', version: '9.9.9' },
    webDistDir: () => distDir,
    vault: () => vault,
    log: () => {},
  }
  const handle = await startUnitWeb(deps, { port: 0, bindHost: '127.0.0.1' })
  return {
    base: `http://127.0.0.1:${handle.port}`,
    handle,
    paired,
    approve: (ok) => approveFn(ok),
    engine,
    vaultCalls,
    emitVault: (ch, payload) => { for (const s of vaultSubs) s(ch, payload) },
    close: () => { void handle.close(); engine.close() },
  }
}

/** 走完配对流拿一枚可用令牌。 */
async function pairUp(b: Boot): Promise<string> {
  const req = await (await fetch(`${b.base}/unit/pair/request`, { method: 'POST', body: '{}' })).json() as any
  b.approve(true)
  await tick()
  const { token } = await (await fetch(`${b.base}/unit/pair/poll?id=${req.requestId}`)).json() as any
  return token as string
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

  it('/vault/rpc:未配对 401;白名单 default-deny;字节双向 base64;handler 抛错回 ok:false', async () => {
    const b = await boot()
    try {
      expect((await fetch(`${b.base}/vault/rpc`, { method: 'POST', body: '{}' })).status).toBe(401)
      const token = await pairUp(b)
      const call = (ch: string, args: unknown[] = []): Promise<Response> =>
        fetch(`${b.base}/vault/rpc`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ch, args }),
        })
      // 白名单外(桌面 UX 通道)一律拒,handler 根本不被触达
      for (const denied of [IPC.openVault, IPC.openAttachment, IPC.exportPdf, IPC.revealInFileManager, IPC.uninstallPlugin, 'made:up']) {
        const r = await call(denied)
        expect(r.status).toBe(400)
        expect(((await r.json()) as any).code).toBe('VAULT_CH_DENIED')
      }
      expect(b.vaultCalls.length).toBe(0)
      expect(VAULT_RPC_ALLOW.has(IPC.openVault)).toBe(false)
      // 正常调用直通 handler
      const list = await (await call(IPC.listPages)).json() as any
      expect(list.ok).toBe(true)
      expect(list.result).toEqual(['甲.md', '乙.md'])
      // 字节出:Buffer → {__u8}
      const bytes = await (await call(IPC.readVaultBytes, ['a.bin'])).json() as any
      expect(Buffer.from(bytes.result.__u8, 'base64')).toEqual(Buffer.from([1, 2, 254]))
      // 字节入:{__u8} → handler 收到 Buffer
      await call(IPC.saveVaultBytes, ['b.bin', { __u8: Buffer.from([9, 8]).toString('base64') }])
      const saved = b.vaultCalls.find((c) => c.ch === IPC.saveVaultBytes)!
      expect(Buffer.isBuffer(saved.args[1])).toBe(true)
      expect([...(saved.args[1] as Buffer)]).toEqual([9, 8])
      // handler 抛错 → HTTP 200 + ok:false(桥按数据分支,不猜异常)
      const boom = await (await call(IPC.deletePage, ['x.md'])).json() as any
      expect(boom.ok).toBe(false)
      expect(boom.error).toContain('测试炸点')
    } finally { b.close() }
  })

  it('/vault/asset-token + asset:短时令牌走 ?at=;ref 解析/精确 path/越界;/vault/events SSE 收到回灌', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'unitweb-asset-'))
    const pic = join(dist, 'p.png')
    await writeFile(pic, Buffer.from([137, 80, 78, 71]))
    const b = await boot(null, pic)
    try {
      const token = await pairUp(b)
      // asset-token 需配对;令牌换资源
      expect((await fetch(`${b.base}/vault/asset-token`, { method: 'POST' })).status).toBe(401)
      const at = ((await (await fetch(`${b.base}/vault/asset-token`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json()) as any).token as string
      expect(at).toBeTruthy()
      // ?at= 过闸拿字节;坏 at 拒;缺 at 但带配对令牌也过(openAttachment 走 window.open 带不了头,兜底给带头的)
      const img = await fetch(`${b.base}/vault/asset?ref=pic.png&at=${at}`)
      expect(img.status).toBe(200)
      expect(img.headers.get('content-type')).toBe('image/png')
      expect([...Buffer.from(await img.arrayBuffer())]).toEqual([137, 80, 78, 71])
      expect((await fetch(`${b.base}/vault/asset?ref=pic.png&at=WRONG`)).status).toBe(401)
      // 解析不到 → 404;精确 path 越界 → 404
      expect((await fetch(`${b.base}/vault/asset?ref=ghost.png&at=${at}`)).status).toBe(404)
      expect((await fetch(`${b.base}/vault/asset?path=..%2fsecret&at=${at}`)).status).toBe(404)
      // SSE:B 侧事件到达页面
      const es = await fetch(`${b.base}/vault/events?at=${at}`)
      expect(String(es.headers.get('content-type'))).toContain('text/event-stream')
      const reader = es.body!.getReader()
      b.emitVault(IPC.externalChange, '甲.md')
      let seen = ''
      const dec = new TextDecoder()
      while (!seen.includes('page:external-change')) {
        const { done, value } = await reader.read()
        expect(done).toBe(false)
        seen += dec.decode(value, { stream: true })
      }
      expect(seen).toContain('甲.md')
      await reader.cancel()
    } finally { b.close() }
  })
})
