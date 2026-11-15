/**
 * ctx.net 的主进程半边(2026-11-16+):插件要调的第三方 API 大多不回 CORS 头,渲染层 fetch 拿不到响应,
 * 由主进程代它请求 —— 但只许请求插件在 manifest `network` 里声明过、并在设置页展示给用户看过的域名。
 *
 * 安全边界(每一条都是硬要求,改之前先看 pluginNet.test.ts):
 *  · 白名单只从磁盘上的 manifest 读(`patternsFor` 由调用方按插件 id 自己定位目录),绝不信渲染层递来的清单 ——
 *    插件代码跑在渲染层主世界,能直接调这条 IPC。也因此任何插件都能冒用别的插件的 id:真正的边界是「所有已装插件
 *    声明过的域名之并」,这些域名都给用户看过。
 *  · 只走 https、只走默认端口 443,不带 userinfo;IP 字面量一律拒(白名单只收主机名)。
 *  · DNS 在**连接那一刻**解析并逐个判(guardedLookup 挂进 https.request 的 lookup):回环 / 私网 / 链路本地 / CGNAT /
 *    组播 / 保留段(v4、v6、v4 映射形)只要出现一个就整次拒 —— 先解析、再 fetch 会解析两次,中间可以被 DNS rebinding 换掉。
 *  · 重定向自己跟(最多 5 跳),每一跳重判协议 / 端口 / 白名单 / IP;换主机时摘掉 Authorization / Cookie。
 *  · 用 Node 的 https,不用 Electron net / session:应用的 Cookie、代理凭据、客户端证书一样都带不上。
 *  · 响应(解压后)≤ 10 MB,边读边数、超了就断;超时缺省 30 s、最多 60 s,覆盖全部跳转与读正文。
 * 失败不抛:回 `{ ok: false, code }`(ipcRenderer.invoke 会把抛出的错误包一层,码就丢了),渲染层再还原成带 code 的 Error。
 */
import https from 'node:https'
import { promises as dns } from 'node:dns'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isIP, type LookupFunction } from 'node:net'
import { pipeline, type Readable } from 'node:stream'
import zlib from 'node:zlib'
import { isPrivateIp } from './netGuard'
import { hostMatchesNetworkPatterns, sanitizeNetworkPatterns } from '../shared/pluginNetwork'

export type PluginNetErrorCode =
  | 'net_domain_not_declared'
  | 'net_blocked_address'
  | 'net_timeout'
  | 'net_too_large'
  | 'net_bad_url'
  | 'net_bad_request'
  | 'net_failed'

export interface PluginNetResponse { status: number; headers: Record<string, string>; bytes: Uint8Array; url: string }
export type PluginNetResult = ({ ok: true } & PluginNetResponse) | { ok: false; code: PluginNetErrorCode; message: string }

export const NET_MAX_BYTES = 10 * 1024 * 1024
export const NET_DEFAULT_TIMEOUT_MS = 30_000
export const NET_MAX_TIMEOUT_MS = 60_000
export const NET_MAX_REDIRECTS = 5

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/
/** 插件不许自己写的头:逐跳头与 Host / 长度由传输层定,写了就是想走私请求。 */
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect',
  'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
])
/** 换主机时摘掉的凭据头(fetch 规范跨源重定向同款)。 */
const CREDENTIAL_HEADERS = ['authorization', 'cookie']
const REDIRECTS = new Set([301, 302, 303, 307, 308])

class NetError extends Error {
  constructor(readonly code: PluginNetErrorCode, message: string) { super(message) }
}

/** DNS 解析的接缝(测试替换):全部地址,带族。 */
export type NetResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>
export const systemResolver: NetResolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true })

/** 一跳请求交给传输层的样子。lookup 必须挂进真正建连的那一步(见 createHttpsTransport)。 */
export interface NetHop {
  url: URL
  method: string
  headers: Record<string, string>
  body: Uint8Array | null
  lookup: LookupFunction
  signal: AbortSignal
}
export interface NetHopResponse {
  status: number
  /** 小写键;多值用 ', ' 连。已解压时不含 content-encoding / content-length。 */
  headers: Record<string, string>
  /** 已解压的正文流。 */
  body: AsyncIterable<Uint8Array>
  /** 不读了:断开连接、丢掉正文。 */
  discard(): void
}
export type NetTransport = (hop: NetHop) => Promise<NetHopResponse>

export interface PluginNetDeps {
  /** 这个插件的 manifest `network`(规范形),主进程自己从磁盘读;插件不存在 → null。 */
  patternsFor(pluginId: string): Promise<readonly string[] | null>
  resolve?: NetResolver
  transport?: NetTransport
  /** 测试用:把本机地址当公网(仅限集成测试连本机 TLS 服务)。生产恒为 isPrivateIp。 */
  isBlockedIp?: (ip: string) => boolean
  userAgent?: string
}

/**
 * 连接时的 DNS 闸:解析出的地址只要有一个落在私网 / 本机段就整次拒(而不是挑个公网的连)——
 * 同一个名字同时指向内外网本身就是 rebinding 的样子。state.blocked 记下来,请求层据此把错误归成 net_blocked_address。
 */
export function guardedLookup(resolve: NetResolver, isBlocked: (ip: string) => boolean, state: { blocked: boolean }): LookupFunction {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const opts = (typeof options === 'object' && options ? options : { family: options }) as { family?: number | string; all?: boolean }
    const fam = opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : Number(opts.family) || 0
    resolve(hostname).then((all) => {
      if (!all.length) throw Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' })
      if (all.some((a) => isBlocked(a.address))) {
        state.blocked = true
        throw new NetError('net_blocked_address', `${hostname} resolves to a local or private address`)
      }
      const list = fam === 4 || fam === 6 ? all.filter((a) => a.family === fam) : all
      if (!list.length) throw Object.assign(new Error(`no IPv${fam} address for ${hostname}`), { code: 'ENOTFOUND' })
      if (opts.all) callback(null, list.map((a) => ({ address: a.address, family: a.family })))
      else callback(null, list[0].address, list[0].family)
    }).catch((e) => callback(e))
  }) as LookupFunction
}

const flattenHeaders = (h: Record<string, string | string[] | undefined>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) if (v != null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
  return out
}

/** 生产传输:Node https,每跳一条新连接(agent:false,不复用、不共享任何会话状态),正文按 content-encoding 解压。
 *  参数只给集成测试连本机自签证书的 TLS 服务用;生产恒用缺省(443、系统 CA、校验证书)。 */
export function createHttpsTransport(tls: { ca?: string; rejectUnauthorized?: boolean; port?: number } = {}): NetTransport {
  return (hop) => new Promise<NetHopResponse>((resolve, reject) => {
    const headers: Record<string, string> = { ...hop.headers, 'accept-encoding': 'gzip, deflate, br' }
    if (hop.body) headers['content-length'] = String(hop.body.byteLength)
    const req = https.request({
      protocol: 'https:',
      hostname: hop.url.hostname,
      port: tls.port ?? 443,
      path: `${hop.url.pathname}${hop.url.search}`,
      method: hop.method,
      headers,
      lookup: hop.lookup,
      agent: false,
      signal: hop.signal,
      ...(tls.ca ? { ca: tls.ca } : {}),
      ...(tls.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const out = flattenHeaders(res.headers)
      const enc = (out['content-encoding'] ?? '').trim().toLowerCase()
      const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip()
        : enc === 'deflate' ? zlib.createInflate()
        : enc === 'br' ? zlib.createBrotliDecompress()
        : null
      res.on('error', () => {}) // 读完 / 丢弃之后才到的连接错误不许变成主进程的未捕获异常;迭代那头照样拿得到错误
      let body: Readable = res
      if (decoder) {
        // pipeline 把两头的错误 / 销毁互相传:读到一半断网,迭代那头会 reject 而不是挂住
        body = pipeline(res, decoder, () => {}) as unknown as Readable
        delete out['content-encoding']
        delete out['content-length']
      }
      resolve({ status: res.statusCode ?? 0, headers: out, body, discard: () => { body.destroy(); res.destroy() } })
    })
    req.on('error', reject)
    req.end(hop.body ? Buffer.from(hop.body.buffer, hop.body.byteOffset, hop.body.byteLength) : undefined)
  })
}

const defaultTransport = createHttpsTransport()

/** URL 一跳的闸:返回规范化后的 URL(去掉主机名末尾的点)或抛 NetError。 */
function checkUrl(raw: string | URL, patterns: readonly string[]): URL {
  let url: URL
  try { url = new URL(String(raw)) } catch { throw new NetError('net_bad_url', 'not a valid absolute URL') }
  if (url.protocol !== 'https:') throw new NetError('net_bad_url', 'only https URLs are allowed')
  if (url.username || url.password) throw new NetError('net_bad_url', 'URLs with credentials are not allowed')
  if (url.port && url.port !== '443') throw new NetError('net_bad_url', 'only the default https port (443) is allowed')
  const bare = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(bare)) throw new NetError('net_blocked_address', 'IP address targets are not allowed; declare and use a host name')
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1)
  if (!hostMatchesNetworkPatterns(url.hostname, patterns)) {
    throw new NetError('net_domain_not_declared', `${url.hostname} is not in this plugin's manifest "network" list`)
  }
  url.hash = ''
  return url
}

interface ParsedInit { method: string; headers: Record<string, string>; body: Uint8Array | null; timeoutMs: number }

function parseInit(raw: unknown): ParsedInit {
  const init = (raw ?? {}) as { method?: unknown; headers?: unknown; body?: unknown; timeoutMs?: unknown }
  if (typeof init !== 'object') throw new NetError('net_bad_request', 'init must be an object')
  const method = init.method == null ? 'GET' : typeof init.method === 'string' ? init.method.toUpperCase() : ''
  if (!METHODS.has(method)) throw new NetError('net_bad_request', `unsupported method ${String(init.method)}`)
  const headers: Record<string, string> = {}
  if (init.headers != null) {
    if (typeof init.headers !== 'object' || Array.isArray(init.headers)) throw new NetError('net_bad_request', 'headers must be a plain object of strings')
    const entries = Object.entries(init.headers as Record<string, unknown>)
    if (entries.length > 64) throw new NetError('net_bad_request', 'too many headers')
    for (const [k, v] of entries) {
      const name = k.toLowerCase()
      if (!HEADER_NAME.test(name)) throw new NetError('net_bad_request', `invalid header name ${k.slice(0, 40)}`)
      if (typeof v !== 'string' || v.length > 8192 || /[\r\n\0]/.test(v)) throw new NetError('net_bad_request', `invalid value for header ${name}`)
      if (FORBIDDEN_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) throw new NetError('net_bad_request', `header ${name} is set by the host`)
      if (name === 'accept-encoding') continue // 解压归传输层管
      headers[name] = v
    }
  }
  let body: Uint8Array | null = null
  if (init.body != null) {
    if (typeof init.body === 'string') {
      body = new TextEncoder().encode(init.body)
      if (!('content-type' in headers)) headers['content-type'] = 'text/plain;charset=UTF-8'
    } else if (init.body instanceof Uint8Array) body = init.body
    else throw new NetError('net_bad_request', 'body must be a string or a Uint8Array')
    if (method === 'GET' || method === 'HEAD') throw new NetError('net_bad_request', `${method} requests cannot have a body`)
    if (body.byteLength > NET_MAX_BYTES) throw new NetError('net_too_large', 'request body is larger than 10 MB')
  }
  let timeoutMs = NET_DEFAULT_TIMEOUT_MS
  if (init.timeoutMs != null) {
    const t = Number(init.timeoutMs)
    if (!Number.isFinite(t) || t <= 0) throw new NetError('net_bad_request', 'timeoutMs must be a positive number')
    timeoutMs = Math.min(Math.ceil(t), NET_MAX_TIMEOUT_MS)
  }
  return { method, headers, body, timeoutMs }
}

/** 一次 ctx.net.request。pluginId / url / init 全按不可信输入收(它们直接来自渲染层)。 */
export async function pluginNetRequest(pluginId: unknown, rawUrl: unknown, rawInit: unknown, deps: PluginNetDeps): Promise<PluginNetResult> {
  const fail = (code: PluginNetErrorCode, message: string): PluginNetResult => ({ ok: false, code, message })
  if (typeof pluginId !== 'string' || !PLUGIN_ID.test(pluginId)) return fail('net_bad_request', 'invalid plugin id')
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192) return fail('net_bad_url', 'url must be a string')
  let init: ParsedInit
  try { init = parseInit(rawInit) } catch (e) { return e instanceof NetError ? fail(e.code, e.message) : fail('net_bad_request', 'invalid init') }
  let patterns: readonly string[]
  try { patterns = (await deps.patternsFor(pluginId)) ?? [] } catch { patterns = [] }

  const transport = deps.transport ?? defaultTransport
  const resolve = deps.resolve ?? systemResolver
  const isBlocked = deps.isBlockedIp ?? isPrivateIp
  const ctl = new AbortController()
  let timedOut = false
  const state = { blocked: false }
  let current: NetHopResponse | null = null
  // 超时:断掉在途的请求,并销毁正在读的正文(只 abort 请求的话,读到一半的响应可能被静默截断而不是报错)
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); current?.discard() }, init.timeoutMs)
  try {
    let url = checkUrl(rawUrl, patterns)
    let { method, body } = init
    const headers: Record<string, string> = { 'user-agent': deps.userAgent ?? 'Forsion', ...init.headers }
    for (let hop = 0; ; hop++) {
      current = await transport({ url, method, headers: { ...headers }, body, lookup: guardedLookup(resolve, isBlocked, state), signal: ctl.signal })
      const res = current
      const location = res.headers.location
      if (REDIRECTS.has(res.status) && location) {
        res.discard()
        current = null
        if (hop >= NET_MAX_REDIRECTS) throw new NetError('net_failed', `too many redirects (more than ${NET_MAX_REDIRECTS})`)
        let next: URL
        try { next = new URL(location, url) } catch { throw new NetError('net_bad_url', 'redirect to an invalid URL') }
        next = checkUrl(next, patterns)
        if (next.hostname !== url.hostname) for (const h of CREDENTIAL_HEADERS) delete headers[h]
        // fetch 同款:303 一律改 GET;301 / 302 上的 POST 改 GET。改了就丢正文与描述正文的头
        if (res.status === 303 ? method !== 'GET' && method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST') {
          method = 'GET'
          body = null
          for (const h of ['content-type', 'content-language', 'content-location']) delete headers[h]
        }
        url = next
        continue
      }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > NET_MAX_BYTES) throw new NetError('net_too_large', 'response is larger than 10 MB')
      const chunks: Uint8Array[] = []
      let total = 0
      if (method !== 'HEAD') {
        for await (const chunk of res.body) {
          total += chunk.byteLength
          if (total > NET_MAX_BYTES) throw new NetError('net_too_large', 'response is larger than 10 MB')
          chunks.push(chunk)
        }
      }
      if (timedOut) throw new NetError('net_timeout', `request timed out after ${init.timeoutMs} ms`)
      current = null
      const buf = Buffer.concat(chunks, total)
      return { ok: true, status: res.status, headers: res.headers, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), url: url.toString() }
    }
  } catch (e) {
    current?.discard()
    if (timedOut) return fail('net_timeout', `request timed out after ${init.timeoutMs} ms`)
    if (e instanceof NetError) return fail(e.code, e.message)
    if (state.blocked) return fail('net_blocked_address', 'the host resolves to a local or private address')
    const msg = e instanceof Error ? e.message : String(e)
    return fail('net_failed', msg.slice(0, 300))
  } finally {
    clearTimeout(timer)
  }
}

export interface ManifestLookupDeps {
  /** 开发 / 沙箱副本(id → 项目根),按装载器的顺序;它们遮住同 id 的安装版(= readExternalPlugins 的 devSources 先扫)。 */
  devSources(): Promise<Array<{ id: string; dir: string }>>
  /** 全局插件目录(~/.forsion/plugins)。 */
  pluginsDir(): string
  /** 目录名 + manifest id → 生效插件 id(与装载器同一条规则 effectivePluginId)。 */
  idOf(dirName: string, manifestId: unknown): string | null
  /** id → 目录映射的缓存时长;manifest 本身每次都重读。 */
  ttlMs?: number
  warn?(msg: string): void
}

/**
 * 按插件 id 从磁盘读它的 `network` 白名单(ctx.net 唯一信的来源)。定位口径与渲染层装载的那一份一致:
 * 开发 / 沙箱副本先、安装版后、同 id 先到先得;agent 自建 Space 不在其中(它没有「用户点安装」这一步授权)。
 * 只缓存「id → 目录」(每次请求都扫插件目录太重),manifest 每次重读:插件升级删掉一个域名,下一次请求就不再放行;
 * 目录里的 manifest 换成了别的 id → 不认。读不到 / 解析不了 → null(拒),不当空清单往下走以外的任何东西。
 */
export function createManifestPatternLookup(deps: ManifestLookupDeps): (pluginId: string) => Promise<string[] | null> {
  let cache: { at: number; dirs: Map<string, string> } | null = null
  const warned = new Set<string>()
  const dirs = async (): Promise<Map<string, string>> => {
    if (cache && Date.now() - cache.at < (deps.ttlMs ?? 5000)) return cache.dirs
    const out = new Map<string, string>()
    for (const s of await deps.devSources().catch(() => [])) if (!out.has(s.id)) out.set(s.id, s.dir)
    const root = deps.pluginsDir()
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      try {
        const m = JSON.parse(await fs.readFile(path.join(root, e.name, 'manifest.json'), 'utf8')) as { id?: unknown }
        const id = deps.idOf(e.name, m?.id)
        if (id && !out.has(id)) out.set(id, path.join(root, e.name))
      } catch { /* 坏 / 缺 manifest:装载器同样不列 */ }
    }
    cache = { at: Date.now(), dirs: out }
    return out
  }
  return async (pluginId) => {
    const dir = (await dirs()).get(pluginId)
    if (!dir) return null
    let m: { id?: unknown; network?: unknown }
    try { m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) } catch { return null }
    if (!m || typeof m !== 'object' || deps.idOf(path.basename(dir), m.id) !== pluginId) return null
    const { patterns, invalid } = sanitizeNetworkPatterns(m.network)
    const key = `${pluginId}:${invalid.join(',')}`
    if (invalid.length && !warned.has(key)) {
      warned.add(key)
      deps.warn?.(`[plugin-net] ${pluginId}: ignored manifest "network" entries (host names only, e.g. api.example.com or *.example.com): ${invalid.join(', ')}`)
    }
    return patterns
  }
}
