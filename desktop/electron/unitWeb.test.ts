/**
 * unitWeb 脊柱测试(真 HTTP 全链,零 electron):配对流(6 位码/限速/拒绝/令牌一次性)、
 * 鉴权(配对令牌 hash / loopback+内部密钥豁免)、/engine 反代盖章 + 请求体直通 + SSE 边收边转、
 * index.html unit 标记注入、路径穿越拒绝、缺构建提示页;/engine default-deny 允许清单(路由分类表与引擎源码
 * 逐条对齐)+ 三入口分钥 + 远端来源标记(契约 C1)。
 * 跑法:npx vitest run electron/unitWeb.test.ts
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { IPC } from '@amadeus-shared/ipc'
import type { VaultFace } from './amadeus/ipc'
import { startUnitWeb, VAULT_RPC_ALLOW, VAULT_RPC_LOCAL_ONLY, engineRouteAccess, engineTarget, normalizeEnginePath, type PairedDevice, type UnitWebDeps } from './unitWeb'
import { ENGINE_ROUTES } from './engineRoutes.generated'
import { PRODUCT } from './product'

type Seen = { method: string; path: string; auth: string; body: string; headers: http.IncomingHttpHeaders }
function fakeEngine(): Promise<{ url: string; gate: { release(): void }; seen: Seen[]; close(): void }> {
  let release: () => void = () => {}
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method || '', path: req.url || '', auth: String(req.headers.authorization || ''), body, headers: req.headers })
      if (req.url?.startsWith('/agent/runs/sse-run/events')) {
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
  vaultCalls: Array<{ ch: string; args: unknown[]; origin: string | null }>
  emitVault: (ch: string, payload?: unknown, origin?: string | null) => void
  close: () => void
}

async function boot(distDir: string | null = null, vaultRoot?: string, p2pAnswer?: (sdp: string) => Promise<string>, extra?: Partial<UnitWebDeps>): Promise<Boot> {
  const engine = await fakeEngine()
  const paired: PairedDevice[] = []
  let approveFn: (ok: boolean) => void = () => {}
  const vaultCalls: Array<{ ch: string; args: unknown[]; origin: string | null }> = []
  const vaultSubs = new Set<(ch: string, payload: unknown, origin: string | null) => void>()
  const vault: VaultFace = {
    call: async (ch, args, origin) => {
      vaultCalls.push({ ch, args, origin: origin ?? null })
      if (ch === IPC.listPages) return ['甲.md', '乙.md']
      if (ch === IPC.readVaultBytes) return Buffer.from([1, 2, 254])
      if (ch === IPC.saveVaultBytes) return undefined
      if (ch === IPC.deletePage) throw new Error('测试炸点')
      return null
    },
    onEvent: (cb) => { vaultSubs.add(cb); return () => { vaultSubs.delete(cb) } },
    assetAbs: async (_page, ref) => (ref.endsWith('.png') || ref.endsWith('.html') || ref.endsWith('.pdf') || ref === 'link.png' ? join(vaultRoot || '/nonexistent', ref) : null),
    absPath: (rel) => {
      if (rel.includes('..')) throw new Error('escape')
      return join(vaultRoot || '/nonexistent', rel)
    },
    root: () => vaultRoot || null,
  }
  const deps: UnitWebDeps = {
    getEngine: () => ({ url: engine.url, token: 'ENGINE_TOKEN', remoteMark: 'REMOTE_MARK' }),
    confirmPair: () => new Promise<boolean>((r) => { approveFn = r }),
    pairedDevices: { list: () => paired, add: async (d) => { paired.push(d) } },
    readPlugins: async () => [{ id: 'demo' }],
    readSpaces: async () => [{ slug: 'demo-space', json: '{}', plugin: 'demo' }],
    readConfig: async () => ({ agentDeskEnabled: true, homeDir: '/home/demo' }),
    readProviders: async () => [{ providerId: 'demo-direct', modelIds: ['demo/m1'] }],
    readHostFile: async (p: string, maxBytes?: number) => { lastHostfileMax = maxBytes; return p === '/ws/ok.md' ? { mimeType: 'text/markdown', content: 'aGk=', size: 2 } : null },
    readHostDir: async (p: string) => (p === '/ws' ? [{ name: 'ok.md', isDir: false, size: 2, path: '/ws/ok.md' }] : null),
    readHostStat: async (p: string) => (p === '/ws/ok.md' ? { isDir: false, mtimeMs: 1, birthtimeMs: null } : null),
    writeConfig: async (patch: Record<string, unknown>) => ({ agentDeskEnabled: patch.agentDeskEnabled ?? true, homeDir: '/home/demo' }),
    meta: { instanceId: 'inst-1', name: '测试机', version: '9.9.9' },
    ...(p2pAnswer ? { p2pAnswer } : {}),
    webDistDir: () => distDir,
    vault: () => vault,
    log: () => {},
    ...extra,
  }
  const handle = await startUnitWeb(deps, { port: 0, bindHost: '127.0.0.1' })
  return {
    base: `http://127.0.0.1:${handle.port}`,
    handle,
    paired,
    approve: (ok) => approveFn(ok),
    engine,
    vaultCalls,
    emitVault: (ch, payload, origin = null) => { for (const s of vaultSubs) s(ch, payload, origin) },
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

let lastHostfileMax: number | undefined

describe('unitWeb', () => {
  it('P2P 信令三态:未鉴权 401 / 无 dep 501 / 有 dep 经内部密钥出 answer', async () => {
    const plain = await boot()
    try {
      // 未鉴权
      expect((await fetch(`${plain.base}/unit/p2p/offer`, { method: 'POST', body: JSON.stringify({ sdp: 'x' }) })).status).toBe(401)
      // 已配对但本端没有 p2pAnswer dep → 501(旧版本/不支持,A 端据此回落中转)
      const tok = await pairUp(plain)
      const r501 = await fetch(`${plain.base}/unit/p2p/offer`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: JSON.stringify({ sdp: 'x' }) })
      expect(r501.status).toBe(501)
      expect(((await r501.json()) as { code?: string }).code).toBe('P2P_UNSUPPORTED')
    } finally { plain.close() }
    const seen: string[] = []
    const b = await boot(null, undefined, async (sdp) => { seen.push(sdp); return `answer-for:${sdp}` })
    try {
      // 隧道来路(loopback + 内部密钥)= server 已验 owner,无需配对
      const r = await fetch(`${b.base}/unit/p2p/offer`, {
        method: 'POST',
        headers: { 'x-unit-internal': b.handle.internalSecret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: 'OFFER-SDP' }),
      })
      expect(r.status).toBe(200)
      expect(((await r.json()) as { sdp: string }).sdp).toBe('answer-for:OFFER-SDP')
      expect(seen).toEqual(['OFFER-SDP'])
      // 缺 sdp → 400
      expect((await fetch(`${b.base}/unit/p2p/offer`, { method: 'POST', headers: { 'x-unit-internal': b.handle.internalSecret }, body: '{}' })).status).toBe(400)
    } finally { b.close() }
  })

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
      expect((await fetch(`${b.base}/engine/agent/runs`, { method: 'POST', body: '{}' })).status).toBe(401)
      const req = await (await fetch(`${b.base}/unit/pair/request`, { method: 'POST', body: JSON.stringify({ name: 'A' }) })).json() as any
      b.approve(true)
      await tick()
      const { token } = await (await fetch(`${b.base}/unit/pair/poll?id=${req.requestId}`)).json() as any
      const r = await fetch(`${b.base}/engine/agent/runs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ hello: '扶桑' }) })
      expect(r.status).toBe(200)
      expect(((await r.json()) as any).echo).toContain('扶桑')
      const hit = b.engine.seen.find((s) => s.path === '/agent/runs')!
      expect(hit.auth).toBe('Bearer ENGINE_TOKEN') // 盖的是引擎 token,不是配对令牌
      expect(hit.headers['x-forsion-remote']).toBe('lan') // 引擎据此拒本机专属工具(电脑历史);设备页自己带 x-forsion-remote:'' 也覆盖不掉
      // 内部密钥豁免(测试即 loopback 来源)
      const r2 = await fetch(`${b.base}/unit/plugins`, { headers: { 'x-unit-internal': b.handle.internalSecret } })
      expect(r2.status).toBe(200)
      expect(((await r2.json()) as any).plugins[0].id).toBe('demo')
      // 错的内部密钥不豁免
      expect((await fetch(`${b.base}/unit/plugins`, { headers: { 'x-unit-internal': 'nope' } })).status).toBe(401)
    } finally { b.close() }
  })

  it('/unit/providers 与 /unit/hostfile:未配对 401;providers 剥密;hostfile 越界 404', async () => {
    const b = await boot()
    try {
      expect((await fetch(`${b.base}/unit/providers`)).status).toBe(401)
      const h = { 'x-unit-internal': b.handle.internalSecret }
      const pv = (await (await fetch(`${b.base}/unit/providers`, { headers: h })).json()) as any
      expect(pv.providers[0].providerId).toBe('demo-direct')
      expect(pv.providers[0].apiKey).toBeUndefined()
      expect(pv.providers[0].baseUrl).toBeUndefined()
      const ok = await fetch(`${b.base}/unit/hostfile?path=${encodeURIComponent('/ws/ok.md')}`, { headers: h })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as any).content).toBe('aGk=')
      expect((await fetch(`${b.base}/unit/hostfile?path=${encodeURIComponent('/etc/passwd')}`, { headers: h })).status).toBe(404)
      expect(lastHostfileMax).toBe(4 * 1024 * 1024) // 内部密钥来路=隧道语义 → 信封余量上限
      // hostdir/hoststat:钳制同源,越界 404、根内出货
      const dir = await fetch(`${b.base}/unit/hostdir?path=${encodeURIComponent('/ws')}`, { headers: h })
      expect(dir.status).toBe(200)
      expect(((await dir.json()) as any).entries[0].name).toBe('ok.md')
      expect((await fetch(`${b.base}/unit/hostdir?path=${encodeURIComponent('/etc')}`, { headers: h })).status).toBe(404)
      const st = await fetch(`${b.base}/unit/hoststat?path=${encodeURIComponent('/ws/ok.md')}`, { headers: h })
      expect(((await st.json()) as any).isDir).toBe(false)
      expect((await fetch(`${b.base}/unit/hoststat?path=${encodeURIComponent('/etc/passwd')}`, { headers: h })).status).toBe(404)
    } finally { b.close() }
  })

  it('/unit/config:未配对 401;GET 出白名单子集,PUT 走 writeConfig 往返', async () => {
    const b = await boot()
    try {
      expect((await fetch(`${b.base}/unit/config`)).status).toBe(401)
      const h = { 'x-unit-internal': b.handle.internalSecret }
      const g = (await (await fetch(`${b.base}/unit/config`, { headers: h })).json()) as any
      expect(g.config).toEqual({ agentDeskEnabled: true, homeDir: '/home/demo' })
      const put = await fetch(`${b.base}/unit/config`, { method: 'PUT', headers: h, body: JSON.stringify({ agentDeskEnabled: false, token: 'EVIL' }) })
      const j = (await put.json()) as any
      expect(j.config.agentDeskEnabled).toBe(false)
      expect(j.config.token).toBeUndefined() // 非白名单键绝不回流
    } finally { b.close() }
  })

  it('/unit/spaces:未配对 401;配对后返回 Space 配方清单(设备页 Ribbon 的数据源)', async () => {
    const b = await boot()
    try {
      expect((await fetch(`${b.base}/unit/spaces`)).status).toBe(401)
      const r = await fetch(`${b.base}/unit/spaces`, { headers: { 'x-unit-internal': b.handle.internalSecret } })
      expect(r.status).toBe(200)
      const j = (await r.json()) as any
      expect(j.spaces[0]).toEqual({ slug: 'demo-space', json: '{}', plugin: 'demo' })
    } finally { b.close() }
  })

  it('SSE 边收边转:第一帧先于引擎收尾到达', async () => {
    const b = await boot()
    try {
      const req = await (await fetch(`${b.base}/unit/pair/request`, { method: 'POST', body: '{}' })).json() as any
      b.approve(true)
      await tick()
      const { token } = await (await fetch(`${b.base}/unit/pair/poll?id=${req.requestId}`)).json() as any
      const r = await fetch(`${b.base}/engine/agent/runs/sse-run/events`, { headers: { Authorization: `Bearer ${token}` } })
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

  it('静态壳:index 注入 unit 标记 + CSP 放行插件 eval;SPA 回退;路径穿越拒绝', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'unitweb-'))
    // 真 web 构建的 CSP 形状(script-src 无 unsafe-eval)——插件宿主 new Function 会被它毙掉。
    await writeFile(join(dist, 'index.html'),
      `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'" /></head><body>shell</body></html>`)
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)')
    const b = await boot(dist)
    try {
      const homeRes = await fetch(`${b.base}/`)
      // 缓存纪律:index(含 SPA 回退)每次验新——CSP 修复烙在注入后的 HTML 里,旧页面复用=修复不生效;hash 资产长缓存。
      expect(homeRes.headers.get('cache-control')).toBe('no-cache')
      expect((await fetch(`${b.base}/some/route`)).headers.get('cache-control')).toBe('no-cache')
      expect((await fetch(`${b.base}/assets/app-abc123.js`)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      const home = await homeRes.text()
      expect(home).toContain('__FORSION_UNIT_PAGE__')
      expect(home).toContain('inst-1')
      // 设备页必须补上 unsafe-eval(否则 19 个插件全部 setup 失败,页面看着就是「插件都没了」)
      expect(home).toMatch(/script-src 'self' 'unsafe-inline' 'unsafe-eval'/)
      expect(home).toContain("style-src 'self'") // 只动 script-src,别的指令原样
      // 幂等:已带 unsafe-eval 的构建不重复追加
      await writeFile(join(dist, 'index.html'),
        `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-eval'" /></head><body>shell</body></html>`)
      const again = await (await fetch(`${b.base}/`)).text()
      expect(again.match(/'unsafe-eval'/g)?.length).toBe(1)
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
      for (const denied of [IPC.openVault, IPC.openAttachment, IPC.exportPdf, IPC.exportCsv, IPC.revealInFileManager, IPC.uninstallPlugin, 'made:up']) {
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

  it('/vault/asset-token + asset:短时令牌走 ?at=;CSP sandbox 惰化附件;软链逃逸拒;/vault/events SSE 带 origin', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'unitweb-vault-'))
    const outside = await mkdtemp(join(tmpdir(), 'unitweb-outside-'))
    await writeFile(join(vaultDir, 'pic.png'), Buffer.from([137, 80, 78, 71]))
    await writeFile(join(vaultDir, 'evil.html'), '<script>alert(1)</script>')
    await writeFile(join(vaultDir, 'doc.pdf'), '%PDF-1.4')
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET')
    await symlink(join(outside, 'secret.txt'), join(vaultDir, 'link.png')) // 库内软链指库外
    const b = await boot(null, vaultDir)
    try {
      const token = await pairUp(b)
      // asset-token 需配对;令牌换资源
      expect((await fetch(`${b.base}/vault/asset-token`, { method: 'POST' })).status).toBe(401)
      const at = ((await (await fetch(`${b.base}/vault/asset-token`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json()) as any).token as string
      expect(at).toBeTruthy()
      // ?at= 过闸拿字节;坏 at 拒
      const img = await fetch(`${b.base}/vault/asset?ref=pic.png&at=${at}`)
      expect(img.status).toBe(200)
      expect(img.headers.get('content-type')).toBe('image/png')
      expect([...Buffer.from(await img.arrayBuffer())]).toEqual([137, 80, 78, 71])
      expect((await fetch(`${b.base}/vault/asset?ref=pic.png&at=WRONG`)).status).toBe(401)
      // 不受信附件惰化:HTML 带 CSP sandbox+nosniff(直开不执行脚本);PDF 豁免 CSP(Chromium 查看器)
      const html = await fetch(`${b.base}/vault/asset?ref=evil.html&at=${at}`)
      expect(html.headers.get('content-security-policy')).toBe('sandbox')
      expect(html.headers.get('x-content-type-options')).toBe('nosniff')
      const pdf = await fetch(`${b.base}/vault/asset?ref=doc.pdf&at=${at}`)
      expect(pdf.headers.get('content-security-policy')).toBeNull()
      // 解析不到 → 404;词法越界 → 404;**库内软链指库外 → 404(realpath 边界)**
      expect((await fetch(`${b.base}/vault/asset?ref=ghost.png&at=${at}`)).status).toBe(404)
      expect((await fetch(`${b.base}/vault/asset?path=..%2fsecret&at=${at}`)).status).toBe(404)
      expect((await fetch(`${b.base}/vault/asset?path=link.png&at=${at}`)).status).toBe(404)
      // RPC 的 body.client → vault.call 的 origin(走 body:隧道信封不带自定义头)
      await fetch(`${b.base}/vault/rpc`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ch: IPC.listPages, args: [], client: 'client-a' }),
      })
      expect(b.vaultCalls.find((c) => c.ch === IPC.listPages)?.origin).toBe('client-a')
      // SSE:B 侧事件到达页面且带 origin(远端桥据此丢自己的回声)
      const es = await fetch(`${b.base}/vault/events?at=${at}`)
      expect(String(es.headers.get('content-type'))).toContain('text/event-stream')
      const reader = es.body!.getReader()
      b.emitVault(IPC.externalChange, '甲.md', 'client-a')
      let seen = ''
      const dec = new TextDecoder()
      while (!seen.includes('page:external-change')) {
        const { done, value } = await reader.read()
        expect(done).toBe(false)
        seen += dec.decode(value, { stream: true })
      }
      expect(seen).toContain('甲.md')
      expect(seen).toContain('"origin":"client-a"')
      await reader.cancel()
    } finally { b.close() }
  })

  it('回收即断供:配对移除后,该设备签发的资源令牌失效、已开的 SSE 在下一事件被掐', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'unitweb-revoke-'))
    await writeFile(join(vaultDir, 'pic.png'), Buffer.from([1]))
    const b = await boot(null, vaultDir)
    try {
      const token = await pairUp(b)
      const at = ((await (await fetch(`${b.base}/vault/asset-token`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json()) as any).token as string
      const es = await fetch(`${b.base}/vault/events?at=${at}`)
      const reader = es.body!.getReader()
      await reader.read() // ': connected'
      // 回收配对(unitsPairedRemove 语义:从列表移除)
      b.paired.splice(0, b.paired.length)
      // 资源令牌立即失效(发行者不再配对)
      expect((await fetch(`${b.base}/vault/asset?ref=pic.png&at=${at}`)).status).toBe(401)
      // 已开的流在下一次事件时被掐(不再吐给被回收设备)
      b.emitVault(IPC.externalChange, '甲.md')
      const { done } = await reader.read()
      expect(done).toBe(true)
      // RPC 也过不了闸
      expect((await fetch(`${b.base}/vault/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ch: IPC.listPages, args: [] }) })).status).toBe(401)
    } finally { b.close() }
  })

  // ── /engine default-deny 允许清单(设备能力 MCP 方案 §6.6 / 附录 C,P0 ③)──────────────────────

  it('路由分类表与引擎源码逐条对齐:新增路由未分类 / 表过期 / 分类孤儿一律红', () => {
    // 生成器从 tangu-agent/src 现抽 standalone 挂载的全部路由,与提交的 engineRoutes.generated.ts 逐字比对。
    // 红了:在 desktop 下跑 `node scripts/gen-engine-routes.mjs`,给新路由在 CLASSIFICATION 里写 allow|deny-remote。
    const r = spawnSync(process.execPath, [resolve(__dirname, '../scripts/gen-engine-routes.mjs'), '--check', '--json'], { encoding: 'utf8' })
    let report: { ok: boolean; stale: boolean; unclassified: string[]; orphans: string[]; routes: number }
    try { report = JSON.parse(r.stdout) } catch { throw new Error(`gen-engine-routes --check did not report: ${r.stderr || r.stdout}`) }
    expect(report.unclassified).toEqual([])
    expect(report.orphans).toEqual([])
    expect(report.stale).toBe(false)
    expect(report.ok).toBe(true)
    expect(report.routes).toBe(ENGINE_ROUTES.length)
    expect(ENGINE_ROUTES.every((x) => x.access === 'allow' || x.access === 'deny-remote')).toBe(true)
  })

  it('分类口径:远程会话主干放行、审批(D1/D2)放行;方案点名的危险面全部 deny-remote', () => {
    const access = (key: string): string | undefined => {
      const [method, path] = key.split(' ')
      return ENGINE_ROUTES.find((x) => x.method === method && x.path === path)?.access
    }
    for (const k of [
      'GET /health', 'POST /agent/runs', 'GET /agent/runs/:id/events', 'POST /agent/runs/:id/abort', 'POST /agent/runs/:id/steer',
      'POST /agent/runs/:runId/approvals/:approvalId', 'POST /agent/runs/:runId/inquiries/:inquiryId',
      'POST /agent/special/approvals/:id/approve', 'POST /agent/special/approvals/:id/reject', 'POST /agent/special/muse/todos/:id/approve',
      'GET /agent/sessions', 'POST /agent/sessions', 'PATCH /agent/sessions/:id/config', 'GET /agent/models', 'GET /agent/agents',
      'GET /agent/workspace/list', 'GET /agent/workspace/read', 'GET /agent/workspace/download', 'POST /agent/workspace/upload',
      'GET /agent/special/config', // 渲染层的鉴权探针(AUTH_PROBE_PATH),拒了设备页连接判定会走样
    ]) expect(access(k), k).toBe('allow')
    for (const k of [
      'POST /agent/plugins/install', 'PUT /agent/engines/:id', 'PUT /agent/channels/:kind/config', 'POST /agent/channels/:kind/connect',
      'POST /agent/wechat/login/start', 'PUT /agent/approval-rules', 'PUT /agent/hooks', 'PUT /agent/websearch', 'POST /agent/providers/fetch-models',
      'PUT /agent/models/overrides', 'POST /agent/agents', 'PATCH /agent/agents/:slug', 'PUT /agent/agents/:slug/memory',
      'POST /agent/agents/:slug/memory/entries', 'POST /agent/agents/:slug/harness/rollback', 'PUT /agent/project-context/doc',
      'POST /agent/skills/catalog/import', 'POST /agent/skills/upload', 'POST /agent/sessions/:id/checkpoints/restore',
      'POST /agent/workspace/delete', 'POST /agent/sync', 'POST /agent/special/config', 'POST /agent/special/muse/triggers',
      'POST /agent/special/automation/triggers/:id/fire', 'POST /agent/special/automation/kick',
      'POST /agent/special/schedule/:slug/entries', 'POST /agent/special/muse/todos/inject', 'PUT /agent/sessions/:id/config',
      // 不可逆删除本机会话 / 历史(归档 PATCH archived 仍是远端的收起方式);朗读音色列表会从本机网络 POST 到调用方给的 baseUrl(SSRF)
      'DELETE /agent/sessions/:id', 'POST /agent/sessions/:id/messages/delete', 'POST /agent/tts/voices/list',
    ]) expect(access(k), k).toBe('deny-remote')
    expect(access('PATCH /agent/sessions/:id'), 'archive stays the remote affordance').toBe('allow')
  })

  it('路径规整:折叠重复斜杠 / 去尾斜杠 / 保留大小写;编码斜杠、编码点、点段、反斜杠一律拒', () => {
    expect(normalizeEnginePath('//agent//Runs/AbC/')).toBe('/agent/Runs/AbC')
    expect(normalizeEnginePath('')).toBe('/')
    for (const bad of ['/agent/runs/..%2fplugins', '/agent/runs/%2F', '/agent/%2e%2e/plugins', '/agent/%2E/x', '/agent/runs/../plugins/install', '/agent/./runs', '/agent\\plugins', '/agent/runs%5cx']) {
      expect(normalizeEnginePath(bad), bad).toBeNull()
    }
    expect(engineRouteAccess('GET', '/agent/sessions')).toBe('allow')
    expect(engineRouteAccess('HEAD', '/agent/sessions')).toBe('allow') // HEAD 按 GET 行判
    expect(engineRouteAccess('GET', '/AGENT/Sessions')).toBe('allow') // Express 路由不分大小写
    expect(engineRouteAccess('POST', '/Agent/Plugins/Install')).toBe('deny')
    expect(engineRouteAccess('POST', '/agent/plugins/install/extra')).toBe('unknown')
    expect(engineRouteAccess('OPTIONS', '/agent/sessions')).toBe('unknown')
    expect(engineRouteAccess('POST', '/agent/runs/r-1/approvals/apv-Xy')).toBe('allow')
  })

  it('保守字符集(评审 A-desktop#0):`#`、空白、NBSP、非 ASCII、坏百分号一律拒;query 里的 `#` / 空白同样整串拒', () => {
    const nbsp = String.fromCharCode(0xa0)
    for (const bad of ['/agent/special/muse/todos/inject#/approve', '/agent/teams/#/session/open', '/agent/x#', `/agent/x${nbsp}`, '/agent/x y', '/agent/x\ty',
      '/agent/x"y', '/agent/x<y', '/agent/x{y}', '/agent/x|y', '/agent/x^y', '/agent/x`y', '/agent/%zz', '/agent/%4', '/agent/中文']) {
      expect(normalizeEnginePath(bad), JSON.stringify(bad)).toBeNull()
    }
    // pchar 全集放行(UUID / slug / 百分号编码的中文 / encodeURIComponent 不转义的 !'()*)
    expect(normalizeEnginePath("/agent/agents/a-b_c.d~e!$&'()*+,;=:@/x%E4%B8%AD")).toBe("/agent/agents/a-b_c.d~e!$&'()*+,;=:@/x%E4%B8%AD")
    expect(engineTarget('/agent/sessions?limit=5&q=a%2Fb')).toEqual({ path: '/agent/sessions', query: '?limit=5&q=a%2Fb' })
    expect(engineTarget('/agent/sessions?q={a}|[b]')).toEqual({ path: '/agent/sessions', query: '?q={a}|[b]' }) // 浏览器不转义 query 里的这些
    for (const bad of ['/agent/sessions?q=1#x', '/agent/inbox#?a=1', '/agent/sessions?q=a b', `/agent/sessions?q=${nbsp}`, '/agent/sessions#']) {
      expect(engineTarget(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  /** 原样发一个不经 fetch 规整的请求(fetch 会先把 `..` 吃掉,测不到服务端)。 */
  const raw = (base: string, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> =>
    new Promise((res, rej) => {
      const u = new URL(base)
      const r = http.request({ host: u.hostname, port: u.port, method, path, headers }, (resp) => {
        let body = ''
        resp.on('data', (c) => { body += c })
        resp.on('end', () => res({ status: resp.statusCode || 0, body }))
      })
      r.on('error', rej)
      r.end()
    })

  it('default-deny:危险路由 / 未知路由 403 LOCAL_ONLY 且到不了引擎;歧义路径 400;放行的路径以规整形态转发、query 不动', async () => {
    const b = await boot()
    try {
      const token = await pairUp(b)
      const h = { Authorization: `Bearer ${token}` }
      const before = b.engine.seen.length
      for (const [method, path] of [
        ['POST', '/engine/agent/plugins/install'],
        ['POST', '/engine/Agent/Plugins/Install/'], // 大小写 + 尾斜杠绕不过去
        ['POST', '/engine/agent//plugins//install'], // 重复斜杠绕不过去
        ['PUT', '/engine/agent/channels/wechat/config'],
        ['GET', '/engine/agent/hooks'],
        ['POST', '/engine/agent/nope'], // 表外(拼错 / 运行期插件路由)同样拒
        ['DELETE', '/engine/agent/sessions/s-1'], // 不可逆硬删本机会话(远端只能归档)
        ['POST', '/engine/agent/sessions/s-1/messages/delete'],
        ['POST', '/engine/agent/tts/voices/list'], // 调用方给 baseUrl、从本机网络发出(SSRF)
        ['OPTIONS', '/engine/agent/sessions'],
      ] as const) {
        const r = await raw(b.base, method, path, h)
        expect(r.status, `${method} ${path}`).toBe(403)
        expect(JSON.parse(r.body).code).toBe('LOCAL_ONLY')
      }
      for (const path of ['/engine/agent/runs/../plugins/install', '/engine/agent/runs/%2e%2e/plugins/install', '/engine/agent/sessions/x%2Fy']) {
        const r = await raw(b.base, 'POST', path, h)
        expect(r.status, path).toBe(400)
        expect(JSON.parse(r.body).code).toBe('BAD_PATH')
      }
      expect(b.engine.seen.length).toBe(before) // 一个都没进引擎
      const ok = await raw(b.base, 'GET', '/engine//agent/Sessions/?limit=5&q=a%2Fb', h)
      expect(ok.status).toBe(200)
      expect(b.engine.seen.at(-1)!.path).toBe('/agent/Sessions?limit=5&q=a%2Fb') // 判的与转的是同一串;query 原样
      const head = await raw(b.base, 'HEAD', '/engine/agent/sessions', h)
      expect(head.status).toBe(200)
    } finally { b.close() }
  })

  it('远端来源标记(契约 C1):局域网配对=lan、隧道=tunnel、P2P=p2p,入站伪造的 x-forsion-remote* 不透传', async () => {
    const b = await boot()
    try {
      const token = await pairUp(b)
      const forged = { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': 'FORGED', 'x-forsion-remote-caller': 'evil' }
      const last = (): http.IncomingHttpHeaders => b.engine.seen.at(-1)!.headers
      expect((await fetch(`${b.base}/engine/agent/sessions`, { headers: { Authorization: `Bearer ${token}`, ...forged } })).status).toBe(200)
      expect(last()['x-forsion-remote']).toBe('lan')
      expect(last()['x-forsion-remote-mark']).toBe('REMOTE_MARK')
      expect(last()['x-forsion-remote-caller']).toBeUndefined()
      expect(last().authorization).toBe('Bearer ENGINE_TOKEN')
      expect((await fetch(`${b.base}/engine/agent/sessions`, { headers: { 'x-unit-internal': b.handle.internalSecret, ...forged, 'x-forsion-remote': 'p2p' } })).status).toBe(200)
      expect(last()['x-forsion-remote']).toBe('tunnel')
      expect((await fetch(`${b.base}/engine/agent/sessions`, { headers: { 'x-unit-p2p': b.handle.p2pSecret, ...forged } })).status).toBe(200)
      expect(last()['x-forsion-remote']).toBe('p2p')
      // 三把钥互不通用:隧道密钥塞进 P2P 头、P2P 密钥塞进隧道头都不算数
      expect(b.handle.p2pSecret).not.toBe(b.handle.internalSecret)
      expect((await fetch(`${b.base}/engine/agent/sessions`, { headers: { 'x-unit-p2p': b.handle.internalSecret } })).status).toBe(401)
      expect((await fetch(`${b.base}/engine/agent/sessions`, { headers: { 'x-unit-internal': b.handle.p2pSecret } })).status).toBe(401)
    } finally { b.close() }
  })

  it('vault 不可逆删除(清空废纸篓 / 彻底删除条目)只许本机:远端 403 LOCAL_ONLY,handler 不被触达', async () => {
    const b = await boot()
    try {
      const token = await pairUp(b)
      expect([...VAULT_RPC_LOCAL_ONLY].sort()).toEqual([IPC.deleteTrashEntry, IPC.emptyTrash].sort())
      for (const ch of VAULT_RPC_LOCAL_ONLY) {
        const r = await fetch(`${b.base}/vault/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ch, args: ['x.md'] }) })
        expect(r.status, ch).toBe(403)
        expect(((await r.json()) as any).code).toBe('LOCAL_ONLY')
      }
      expect(b.vaultCalls.length).toBe(0)
      // 可恢复的删除(进废纸篓)照常
      const t = await fetch(`${b.base}/vault/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ch: IPC.trashEntry, args: ['x.md'] }) })
      expect(((await t.json()) as any).ok).toBe(true)
    } finally { b.close() }
  })

  it('便携 Unit 的本地投影(工作区主人)不受允许清单约束、不盖远端标记;桌面(无 projection)恒受约束', async () => {
    const ownerToken = 'owner-access-key'
    const b = await boot(null, undefined, undefined, { projection: { mode: 'local', basePath: '/', product: PRODUCT } })
    try {
      b.paired.push({ id: 'owner', name: 'owner', tokenHash: createHash('sha256').update(ownerToken).digest('hex'), createdAt: 0 })
      const h = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }
      const r = await fetch(`${b.base}/engine/agent/plugins/install`, { method: 'POST', headers: h, body: '{}' })
      expect(r.status).toBe(200)
      const hit = b.engine.seen.at(-1)!
      expect(hit.path).toBe('/agent/plugins/install')
      expect(hit.headers['x-forsion-remote']).toBeUndefined()
      expect(hit.headers['x-forsion-remote-mark']).toBeUndefined()
      const empty = await fetch(`${b.base}/vault/rpc`, { method: 'POST', headers: h, body: JSON.stringify({ ch: IPC.emptyTrash, args: [] }) })
      expect(((await empty.json()) as any).ok).toBe(true)
    } finally { b.close() }
    const desk = await boot()
    try {
      const token = await pairUp(desk)
      expect((await fetch(`${desk.base}/engine/agent/plugins/install`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' })).status).toBe(403)
    } finally { desk.close() }
  })
})
