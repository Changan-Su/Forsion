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
import { extname, normalize, sep } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { IPC } from '@amadeus-shared/ipc'
import type { VaultFace } from './amadeus/ipc'

export interface PairedDevice { id: string; name: string; tokenHash: string; createdAt: number }

/**
 * /vault/rpc 可远程调用的通道白名单(default-deny,同 sketch 工具的 GUI 门禁范式)。
 * 排除项都是「在 B 的机器上弹对话框/开 shell」类桌面 UX 通道:openVault(目录选择框)、
 * openAttachment/openVaultFile(shell.openPath)、exportPdf(保存框+printToPDF)、
 * revealInFileManager、插件管理(listPlugins 走 /unit/plugins;scaffold/uninstall/open-folder 不给远端)。
 * 文件类通道全部经 VaultManager.resolveInVault 钳制在库根内,越界即抛。
 */
export const VAULT_RPC_ALLOW: ReadonlySet<string> = new Set([
  IPC.restoreVault, IPC.listPages, IPC.listFiles, IPC.loadPage, IPC.readPage, IPC.newPage,
  IPC.savePage, IPC.renamePage, IPC.reconcilePage, IPC.saveAsset, IPC.saveVaultBytes,
  IPC.readVaultBytes, IPC.saveAttachment, IPC.search, IPC.backlinks, IPC.exclusiveAssets,
  IPC.reindex, IPC.listTags, IPC.pagesByTag, IPC.deletePage, IPC.movePage, IPC.resolveEmbed,
  IPC.blockBacklinks, IPC.listFolders, IPC.createFolder, IPC.renameFolder, IPC.deleteFolder,
  IPC.moveFolder, IPC.trashEntry, IPC.listTrash, IPC.restoreTrash, IPC.deleteTrashEntry,
  IPC.emptyTrash, IPC.pageIcons, IPC.fetchLinkMeta, IPC.searchImages, IPC.dbRead, IPC.dbWrite,
  IPC.dbWriteCas, IPC.drawingRead, IPC.drawingWrite, IPC.readTextFile, IPC.writeTextFile,
  IPC.listPageProps, IPC.setPageFrontmatter, IPC.renamePageFile, IPC.renameDbFile,
  IPC.pluginDataRead, IPC.pluginDataWrite,
])

/** RPC 里字节参数/返回值的 JSON 包裹形态(Uint8Array ↔ base64)。 */
const decodeRpcArgs = (args: unknown[]): unknown[] =>
  args.map((a) => (a && typeof a === 'object' && typeof (a as { __u8?: unknown }).__u8 === 'string')
    ? Buffer.from((a as { __u8: string }).__u8, 'base64')
    : a)
const encodeRpcResult = (r: unknown): unknown =>
  r instanceof Uint8Array ? { __u8: Buffer.from(r).toString('base64') } : r

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
  /** Space 配方清单(与 spaces:list IPC 同源):设备页没有它装不出插件 Space,Ribbon 上就没有插件图标。 */
  readSpaces: () => Promise<Array<{ slug: string; json: string; plugin?: string }>>
  /** UI 偏好配置面(白名单裁剪后的子集,绝不含 token/连接键):设备页据此长出 Agent Desk 等
   *  按 desktopConfig 门控的功能;写回同一张白名单(体验跟随本机设置,双向)。 */
  readConfig: () => Promise<Record<string, unknown>>
  writeConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
  meta: { instanceId: string; name: string; version: string }
  /** web 构建目录(TANGU_UNIT_WEB_DIST / 捆包路径);null = 出「未捆构建」提示页。 */
  webDistDir: () => string | null
  /** 本地 vault 面(registerAmadeusIpc 返回;懒取 —— unitWeb 可能先于它起)。null = /vault/* 回 503。 */
  vault: () => VaultFace | null
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
  // vault 资源面(/vault/asset)常见附件类型
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.md': 'text/markdown; charset=utf-8',
}

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

/** 缺 web 构建时的提示页(只会出现在 dev:打包链前置构建 + builder 缺产物即失败)。 */
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
  // 短时资源令牌(<img>/EventSource 带不了 Authorization → ?at= 查询串;照 amadeus-cloud 先例)。
  // 记发行者的配对 hash:配对被回收后,它签发过的资源令牌立即失效(Codex P2——否则被回收设备
  // 还能凭手里的 at 继续收 10 分钟的库活动)。internal(隧道)签发的 pairHash=null,不受回收影响。
  const assetTokens = new Map<string, { exp: number; pairHash: string | null }>()
  const ASSET_TTL_MS = 10 * 60_000

  const gc = (): void => {
    const now = Date.now()
    for (const [id, p] of pending) {
      if (p.expires < now) {
        pending.delete(id)
        if (pendingByIp.get(p.ip) === id) pendingByIp.delete(p.ip)
      }
    }
    for (const [t, rec] of assetTokens) if (rec.exp < now) assetTokens.delete(t)
  }

  /** 鉴权:配对令牌(hash 比对)或「loopback + 内部密钥」(隧道,server 已验 owner)。
   *  返回来路:internal=隧道;pairHash=命中的配对记录(回收后再验即失败)。 */
  const authInfo = (req: http.IncomingMessage): { ok: boolean; pairHash: string | null } => {
    if (req.headers['x-unit-internal'] === internalSecret && isLoopback(req.socket.remoteAddress)) return { ok: true, pairHash: null }
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))
    if (!m) return { ok: false, pairHash: null }
    const h = sha256(m[1])
    const hit = deps.pairedDevices.list().some((d) => d.tokenHash === h)
    return { ok: hit, pairHash: hit ? h : null }
  }
  const authed = (req: http.IncomingMessage): boolean => authInfo(req).ok

  /** 资源令牌活性:未过期 + 发行者(若为配对设备)仍在已配对列表里。 */
  const assetTokenLive = (at: string): boolean => {
    const rec = assetTokens.get(at)
    if (!rec || rec.exp < Date.now()) return false
    return rec.pairHash === null || deps.pairedDevices.list().some((d) => d.tokenHash === rec.pairHash)
  }

  /** 远程 asset 面的真实路径边界:软链能把词法钳制过的路径带出库根(Codex P2)——
   *  realpath 后必须仍在 realpath(库根) 之下才许伺服。 */
  const underVaultReal = async (abs: string, rootRaw: string | null): Promise<string | null> => {
    if (!rootRaw) return null
    try {
      const [real, rootReal] = await Promise.all([realpath(abs), realpath(rootRaw)])
      return real === rootReal || real.startsWith(rootReal + sep) ? real : null
    } catch {
      return null // 不存在/不可达一律 404
    }
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
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
        let html = buf.toString('utf8').replace(/<head>/i, `<head>${inject}`)
        // ⚠️ 设备页必须放行 'unsafe-eval':插件宿主用 new Function 求值插件代码,而 web 构建的
        // CSP(script-src 'self' 'unsafe-inline')没它 —— 19 个插件会**全部** setup 失败,页面看起来
        // 就是「插件和视图都没了」(2026-08-24 真机实测)。云端 web 那份 index 不动(它本就不装插件)。
        // 信任面:这里跑的是 B 自己装的插件,与 B 桌面端同一信任级;附件的惰化另走 /vault/asset 的 CSP sandbox。
        // 两步走(别塞一个巨型正则:CSP 值自带单引号 'self'/'unsafe-inline',一步匹配会在那里断掉):
        // ① 揪出 CSP meta 标签 ② 只在它的 script-src 指令尾部补 'unsafe-eval',其余指令原样。
        html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i, (tag) =>
          tag.replace(/(content=(["']))([\s\S]*?)\2/i, (_m, head: string, quote: string, csp: string) => {
            const next = csp.includes("'unsafe-eval'")
              ? csp
              : csp.replace(/script-src([^;]*)/i, (_d, srcs: string) => `script-src${srcs} 'unsafe-eval'`)
            return `${head}${next}${quote}`
          }))
        buf = Buffer.from(html)
      }
      const h: Record<string, string | number> = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': buf.length }
      // index(含 SPA 回退)必须每次回源验新:CSP 修复等都烙在注入后的 HTML 里,复用旧页面=修复永不生效。
      // assets/* 带内容 hash,放心长缓存。
      if (norm === 'index.html') h['Cache-Control'] = 'no-cache'
      else if (/^assets[\\/]/.test(norm)) h['Cache-Control'] = 'public, max-age=31536000, immutable'
      res.writeHead(200, h)
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
    // 只读 Space 配方面(纯数据布局,无 shell 面):设备页 loadUserSpaces 的数据源,缺了它插件 view 无入口。
    if (path === '/unit/spaces' && req.method === 'GET') {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      json(res, 200, { spaces: await deps.readSpaces() })
      return
    }
    // UI 偏好配置面(白名单子集,读写对称;deps 负责裁剪 —— 这里绝不直接碰 config 全量)。
    if (path === '/unit/config' && (req.method === 'GET' || req.method === 'PUT')) {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      if (req.method === 'GET') { json(res, 200, { config: await deps.readConfig() }); return }
      let patch: Record<string, unknown>
      try { patch = JSON.parse(await readBody(req)) as Record<string, unknown> } catch { json(res, 400, { detail: 'bad body' }); return }
      json(res, 200, { config: await deps.writeConfig(patch && typeof patch === 'object' ? patch : {}) })
      return
    }
    if (path === '/engine' || path.startsWith('/engine/')) {
      if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
      proxyEngine(req, res, url.slice('/engine'.length) || '/')
      return
    }

    // ── 本地 vault 面(v2.1):设备页里的 Amadeus 显示/编辑本机笔记库 ──
    if (path.startsWith('/vault/')) {
      const vault = deps.vault()
      if (!vault) { json(res, 503, { detail: '本机笔记库面未就绪', code: 'VAULT_NOT_READY' }); return }
      const q = new URL(url, 'http://x').searchParams
      const at = String(q.get('at') || '')
      const assetAuthed = (): boolean => (at !== '' && assetTokenLive(at)) || authed(req)

      if (path === '/vault/rpc' && req.method === 'POST') {
        if (!authed(req)) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
        let body: { ch?: string; args?: unknown[]; client?: unknown }
        // 32MB:附件上传按 b64 膨胀 ~4/3;隧道路径另受 server 信封 10MB 顶(见方案 §9,LAN 不受限)。
        try { body = JSON.parse(await readBody(req, 32 * 1024 * 1024)) } catch { json(res, 400, { detail: 'bad body' }); return }
        const ch = String(body.ch || '')
        if (!VAULT_RPC_ALLOW.has(ch)) { json(res, 400, { detail: `通道不可远程调用: ${ch}`, code: 'VAULT_CH_DENIED' }); return }
        // 远端客户端自报 clientId → 事件 origin(回声按 origin 判);走 body 因为隧道信封不带自定义头;限长防注水。
        const origin = String(body.client || '').slice(0, 64) || null
        try {
          const result = await vault.call(ch, decodeRpcArgs(Array.isArray(body.args) ? body.args : []), origin)
          json(res, 200, { ok: true, result: encodeRpcResult(result) ?? null })
        } catch (e) {
          json(res, 200, { ok: false, error: String((e as Error)?.message || e) })
        }
        return
      }

      if (path === '/vault/asset-token' && req.method === 'POST') {
        const info = authInfo(req)
        if (!info.ok) { json(res, 401, { detail: '未配对', code: 'UNPAIRED' }); return }
        const token = randomBytes(16).toString('hex')
        assetTokens.set(token, { exp: Date.now() + ASSET_TTL_MS, pairHash: info.pairHash })
        json(res, 200, { token, ttlSec: ASSET_TTL_MS / 1000 })
        return
      }

      if (path === '/vault/asset' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!assetAuthed()) { json(res, 401, { detail: '资源令牌无效', code: 'ASSET_TOKEN' }); return }
        const exact = q.get('path')
        let abs: string | null = null
        try {
          abs = exact != null
            ? vault.absPath(exact) // 树/侧栏点开:路径精确,不走 ref 的 basename 兜底
            : await vault.assetAbs(q.get('page'), String(q.get('ref') || ''))
        } catch { /* 越界/无库 → 404 */ }
        // 词法钳制挡不住库内软链指向库外(Codex P2):realpath 后仍须在库根之下。
        const real = abs ? await underVaultReal(abs, vault.root()) : null
        if (!real) { json(res, 404, { detail: 'not found' }); return }
        const stream = createReadStream(real) // ponytail: 无 Range;远程视频拖进度条要 Range 再加
        stream.on('error', () => { if (!res.headersSent) json(res, 404, { detail: 'not found' }); else res.destroy() })
        stream.once('open', () => {
          const mime = MIME[extname(real).toLowerCase()] || 'application/octet-stream'
          const h: Record<string, string> = { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' }
          // 库内附件是不受信内容:HTML/SVG 直开会在本应用 origin 执行脚本(可读配对令牌+打 RPC)。
          // CSP sandbox 让文档落进 opaque origin 且禁脚本;<img>/媒体子资源解码不受此头影响。
          // PDF 豁免:Chromium 的 PDF 查看器在 sandbox 下拒渲,且它本身跑在独立扩展 origin。
          if (mime !== 'application/pdf') h['Content-Security-Policy'] = 'sandbox'
          res.writeHead(200, h)
          stream.pipe(res)
        })
        res.on('close', () => stream.destroy())
        return
      }

      if (path === '/vault/events' && req.method === 'GET') {
        if (!assetAuthed()) { json(res, 401, { detail: '资源令牌无效', code: 'ASSET_TOKEN' }); return }
        // 记住开流时的授权形态,事件与心跳逐次复验:配对被回收的设备不许继续收库活动(Codex P2)。
        const viaAt = at !== '' && assetTokenLive(at)
        const bearerInfo = viaAt ? null : authInfo(req)
        const stillAuthed = (): boolean => (viaAt ? assetTokenLive(at)
          : bearerInfo?.pairHash != null ? deps.pairedDevices.list().some((d) => d.tokenHash === bearerInfo.pairHash)
          : true) // 内部密钥(隧道):per-boot 常量,server 已验 owner
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        })
        res.write(': connected\n\n')
        const unsub = vault.onEvent((ch, payload, origin) => {
          if (!stillAuthed()) { res.end(); return }
          res.write(`data: ${JSON.stringify({ ch, payload, origin })}\n\n`)
        })
        const hb = setInterval(() => {
          if (!stillAuthed()) { res.end(); return }
          res.write(': hb\n\n')
        }, 25_000)
        res.on('close', () => { unsub(); clearInterval(hb) })
        return
      }

      json(res, 404, { detail: 'not found' })
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
