/**
 * unitWeb —— 扶桑根 B 端渲染的本机 web 服务(方案 §11.3)。
 *
 * 把本机 Forsion 曝成一个网页:静态 web 构建 + /engine 反代本机引擎 + 配对流 + 插件清单 + 元数据。
 * 双层通路共用这一个面:
 *   T1 局域网直连(无需 Forsion 登录):Bearer 配对令牌(6 位码双侧比对后发放,库存 hash,可回收);
 *   T2 server 隧道(unitHost 转发):per-boot 随机内部密钥头 + 仅接受 loopback 来源(server 已验 owner)。
 * 安全铁律:引擎永远只听 127.0.0.1,本服务反代时盖引擎 token;配对令牌绝不进引擎。
 *
 * ⚠️ 刻意零 electron 依赖(deps 注入):vitest 直接跑真 HTTP 全链(scripts 之外的脊柱测试
 * electron/unitWeb.test.ts —— 配对/鉴权/反代盖章/SSE 直通都在那里钉)。
 */
import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { extname, normalize } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'

export interface PairedDevice { id: string; name: string; tokenHash: string; createdAt: number }

export interface UnitWebDeps {
  /** 本机 managed 引擎(未就绪 url=null → /engine 回 503)。 */
  getEngine: () => { url: string | null; token: string }
  /** B 侧原生确认框:展示设备名+6 位码,用户点允许=true。 */
  confirmPair: (info: { name: string; code: string; ip: string }) => Promise<boolean>
  pairedDevices: {
    list: () => PairedDevice[]
    add: (d: PairedDevice) => Promise<void>
  }
  readPlugins: () => Promise<unknown[]>
  meta: { instanceId: string; name: string; version: string }
  /** web 构建目录(TANGU_UNIT_WEB_DIST / 捆包路径);null = 出「未捆构建」提示页。 */
  webDistDir: () => string | null
  log: (m: string) => void
}

export interface UnitWebHandle {
  port: number
  /** 隧道(unitHost)豁免鉴权用的 per-boot 内部密钥;仅 loopback 来源有效。 */
  internalSecret: string
  close: () => Promise<void>
}

interface PendingPair { id: string; name: string; code: string; ip: string; expires: number; status: 'pending' | 'approved' | 'denied'; token?: string }

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const PAIR_TTL_MS = 2 * 60_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
}

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

/** 缺 web 构建时的提示页(附构建命令;v2.1 才捆进桌面包)。 */
const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Forsion Unit</title>
<body style="font-family:system-ui;max-width:560px;margin:80px auto;line-height:1.7">
<h2>本机未捆 web 构建</h2>
<p>这台 Forsion 的互联服务已在运行,但缺少网页渲染层构建产物。</p>
<p>在这台设备上执行:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:8px">cd Forsion-Genesis/desktop && node scripts/build-unit-web.mjs</pre>
<p>或设置环境变量 <code>TANGU_UNIT_WEB_DIST</code> 指向已有的 web 构建目录后重启 Forsion。</p></body>`

export function startUnitWeb(deps: UnitWebDeps, opts: { port: number; bindHost?: string }): Promise<UnitWebHandle> {
  const internalSecret = randomUUID()
  const pending = new Map<string, PendingPair>()
  const pendingByIp = new Map<string, string>()

  const gc = (): void => {
    const now = Date.now()
    for (const [id, p] of pending) {
      if (p.expires < now) {
        pending.delete(id)
        if (pendingByIp.get(p.ip) === id) pendingByIp.delete(p.ip)
      }
    }
  }

  /** 鉴权:配对令牌(hash 比对)或「loopback + 内部密钥」(隧道,server 已验 owner)。 */
  const authed = (req: http.IncomingMessage): boolean => {
    if (req.headers['x-unit-internal'] === internalSecret && isLoopback(req.socket.remoteAddress)) return true
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))
    if (!m) return false
    const h = sha256(m[1])
    return deps.pairedDevices.list().some((d) => d.tokenHash === h)
  }

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    const buf = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length })
    res.end(buf)
  }

  const readBody = (req: http.IncomingMessage, limit = 64 * 1024): Promise<string> =>
    new Promise((resolve, reject) => {
      let n = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        n += c.length
        if (n > limit) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  /** /engine/* 反代:剥外来身份、盖本机引擎 token,请求/响应双向原始管道(SSE 天然直通)。 */
  const proxyEngine = (req: http.IncomingMessage, res: http.ServerResponse, path: string): void => {
    const engine = deps.getEngine()
    if (!engine.url) { json(res, 503, { detail: '本机引擎未就绪', code: 'ENGINE_NOT_READY' }); return }
    const target = new URL(engine.url)
    const headers: Record<string, string> = { Authorization: `Bearer ${engine.token}` }
    for (const k of ['content-type', 'accept', 'content-length'] as const) {
      const v = req.headers[k]
      if (typeof v === 'string') headers[k] = v
    }
    const up = http.request({
      host: target.hostname,
      port: target.port,
      path,
      method: req.method,
      headers,
    }, (upRes) => {
      const h: Record<string, string> = {}
      for (const k of ['content-type', 'cache-control'] as const) {
        const v = upRes.headers[k]
        if (typeof v === 'string') h[k] = v
      }
      if (String(upRes.headers['content-type'] || '').includes('text/event-stream')) h['X-Accel-Buffering'] = 'no'
      res.writeHead(upRes.statusCode || 502, h)
      upRes.pipe(res)
      res.on('close', () => upRes.destroy())
    })
    up.on('error', (e) => { if (!res.headersSent) json(res, 502, { detail: `本机引擎不可达: ${e.message}` }) })
    req.pipe(up)
  }

  const serveStatic = async (res: http.ServerResponse, urlPath: string): Promise<void> => {
    const dist = deps.webDistDir()
    if (!dist) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PLACEHOLDER)
      return
    }
    // SPA:无扩展名的路径一律回 index.html;路径穿越一律拒。
    let rel = decodeURIComponent(urlPath.split('?')[0])
    if (!extname(rel)) rel = '/index.html'
    const norm = normalize(rel).replace(/^([/\\])+/, '')
    if (norm.startsWith('..')) { json(res, 400, { detail: 'bad path' }); return }
    try {
      let buf = await readFile(`${dist}/${norm}`)
      const ext = extname(norm)
      if (norm === 'index.html') {
        // 注入 unit 标记 + 元数据:同一份 web 构建两用,web/src/main.tsx 据此在登录跳转之前改装 unitShim。
        const inject = `<script>window.__FORSION_UNIT_PAGE__=${JSON.stringify({ instanceId: deps.meta.instanceId, name: deps.meta.name, version: deps.meta.version })}</script>`
        buf = Buffer.from(buf.toString('utf8').replace(/<head>/i, `<head>${inject}`))
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': buf.length })
      res.end(buf)
    } catch {
      json(res, 404, { detail: 'not found' })
    }
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    gc()
    const url = req.url || '/'
    const path = url.split('?')[0]
    const ip = req.socket.remoteAddress || 'unknown'

    // ── 公开面(无鉴权):元数据 / 配对流 / 静态壳(壳只是代码,数据面全在鉴权后) ──
    if (path === '/unit/meta' && req.method === 'GET') {
      json(res, 200, { ...deps.meta, pair: true })
      return
    }
    if (path === '/unit/pair/request' && req.method === 'POST') {
      const prevId = pendingByIp.get(ip)
      if (prevId && pending.get(prevId)?.status === 'pending') { json(res, 429, { detail: '已有待确认的配对请求', code: 'PAIR_PENDING' }); return }
      let name = '未命名设备'
      try { name = String(JSON.parse(await readBody(req))?.name || name).slice(0, 60) } catch { /* 缺 body 用默认名 */ }
      const p: PendingPair = {
        id: randomUUID(),
        name,
        code: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
        ip,
        expires: Date.now() + PAIR_TTL_MS,
        status: 'pending',
      }
      pending.set(p.id, p)
      pendingByIp.set(ip, p.id)
      json(res, 200, { requestId: p.id, code: p.code, ttlMs: PAIR_TTL_MS })
      // 弹 B 侧原生确认框(异步;poll 端点回传结果)。
      void deps.confirmPair({ name: p.name, code: p.code, ip }).then(async (ok) => {
        const live = pending.get(p.id)
        if (!live || live.status !== 'pending' || live.expires < Date.now()) return
        if (!ok) { live.status = 'denied'; return }
        const token = randomBytes(32).toString('hex')
        await deps.pairedDevices.add({ id: randomUUID(), name: live.name, tokenHash: sha256(token), createdAt: Date.now() })
        live.status = 'approved'
        live.token = token
        deps.log(`[unit-web] 已配对设备「${live.name}」(${ip})`)
      }).catch((e) => deps.log(`[unit-web] 配对确认失败: ${e?.message || e}`))
      return
    }
    if (path === '/unit/pair/poll' && req.method === 'GET') {
      const id = String(new URL(url, 'http://x').searchParams.get('id') || '')
      const p = pending.get(id)
      if (!p || p.expires < Date.now()) { json(res, 200, { status: 'expired' }); return }
      if (p.status === 'approved' && p.token) {
        const token = p.token
        pending.delete(id)
        pendingByIp.delete(p.ip)
        json(res, 200, { status: 'approved', token }) // 令牌只下发一次
        return
      }
      json(res, 200, { status: p.status })
      return
    }

    // ── 鉴权面 ──
    if (path === '/unit/whoami' && req.method === 'GET') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      json(res, 200, { ok: true })
      return
    }
    if (path === '/unit/plugins' && req.method === 'GET') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      json(res, 200, { appVersion: deps.meta.version, plugins: await deps.readPlugins() })
      return
    }
    if (path === '/engine' || path.startsWith('/engine/')) {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      proxyEngine(req, res, url.slice('/engine'.length) || '/')
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { detail: 'method not allowed' }); return }
    await serveStatic(res, path)
  }

  const server = http.createServer((req, res) => {
    void handler(req, res).catch((e) => {
      deps.log(`[unit-web] 请求处理失败: ${e?.message || e}`)
      if (!res.headersSent) json(res, 500, { detail: 'internal error' })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.bindHost ?? '0.0.0.0', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        internalSecret,
        close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.() }),
      })
    })
  })
}
