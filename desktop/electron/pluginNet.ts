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
      const status = res.statusCode ?? 0
      res.on('error', () => {}) // 读完 / 丢弃之后才到的连接错误不许变成主进程的未捕获异常;迭代那头照样拿得到错误
      // 没有正文的响应(HEAD / 1xx / 204 / 304):不建解压器 —— 空正文配 Content-Encoding: gzip 会让解压器报
      // 「unexpected end of file」,没人读它就成了主进程的未捕获异常(Codex 评审实测)。直接放掉,连接照常关。
      // 重定向的正文反正丢掉:不解,也就不因为它带了个认不出的 Content-Encoding 让整次请求失败
      if (hop.method === 'HEAD' || status < 200 || status === 204 || status === 304 || out['content-length'] === '0' || (REDIRECTS.has(status) && !!out.location)) {
        res.resume()
        resolve({ status, headers: out, body: (async function* () {})(), discard: () => { res.destroy() } })
        return
      }
      // Content-Encoding 可以叠(`gzip, br`):按声明的逆序逐层解。认不出的编码直接拒,不把压缩字节当正文交给插件
      // (那样既绕过解压后的 10 MB 上限,text()/json() 也读到乱码)。
      const codings = (out['content-encoding'] ?? '').split(',').map((c) => c.trim().toLowerCase()).filter((c) => c && c !== 'identity')
      if (codings.length > 3 || codings.some((c) => !['gzip', 'x-gzip', 'deflate', 'br'].includes(c))) {
        res.destroy()
        reject(new NetError('net_failed', `unsupported content-encoding: ${out['content-encoding']?.slice(0, 60)}`))
        return
      }
      const decoders = codings.reverse().map((c) => {
        // 收尾宽容(同浏览器 / undici):空正文、少了尾部校验的压缩流照常交出已解开的部分,不当成网络错误
        const d = c === 'br' ? zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
          : c === 'deflate' ? zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
          : zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
        d.on('error', () => {}) // 同上:错误经 pipeline 传给读的那一头,这里只防「没人读」时炸主进程
        return d
      })
      let body: Readable = res
      if (decoders.length) {
        // pipeline 把各段的错误 / 销毁互相传:读到一半断网,迭代那头会 reject 而不是挂住
        body = (pipeline as (...streams: unknown[]) => Readable)(res, ...decoders, () => {})
        delete out['content-encoding']
        delete out['content-length']
      }
      resolve({ status, headers: out, body, discard: () => { body.destroy(); for (const d of decoders) d.destroy(); res.destroy() } })
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

/** 同时在飞的请求上限:每个最多攒 10 MB 在主进程内存里,不设上限的话一个插件并发打自己声明的域名就能把主进程撑爆。 */
export const NET_MAX_IN_FLIGHT_PER_PLUGIN = 8
export const NET_MAX_IN_FLIGHT = 24
const inFlight = new Map<string, number>()
let inFlightTotal = 0

/** 一次 ctx.net.request。pluginId / url / init 全按不可信输入收(它们直接来自渲染层)。 */
export async function pluginNetRequest(pluginId: unknown, rawUrl: unknown, rawInit: unknown, deps: PluginNetDeps): Promise<PluginNetResult> {
  if (typeof pluginId !== 'string' || !PLUGIN_ID.test(pluginId)) return { ok: false, code: 'net_bad_request', message: 'invalid plugin id' }
  if ((inFlight.get(pluginId) ?? 0) >= NET_MAX_IN_FLIGHT_PER_PLUGIN || inFlightTotal >= NET_MAX_IN_FLIGHT) {
    return { ok: false, code: 'net_failed', message: `too many concurrent requests (at most ${NET_MAX_IN_FLIGHT_PER_PLUGIN} per plugin)` }
  }
  inFlight.set(pluginId, (inFlight.get(pluginId) ?? 0) + 1)
  inFlightTotal++
  try {
    return await requestOnce(pluginId, rawUrl, rawInit, deps)
  } finally {
    const n = (inFlight.get(pluginId) ?? 1) - 1
    if (n > 0) inFlight.set(pluginId, n); else inFlight.delete(pluginId)
    inFlightTotal--
  }
}

async function requestOnce(pluginId: string, rawUrl: unknown, rawInit: unknown, deps: PluginNetDeps): Promise<PluginNetResult> {
  const fail = (code: PluginNetErrorCode, message: string): PluginNetResult => ({ ok: false, code, message })
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
      // HEAD 的 Content-Length 说的是资源多大,不是这次要读多少
      if (method !== 'HEAD' && Number.isFinite(declared) && declared > NET_MAX_BYTES) throw new NetError('net_too_large', 'response is larger than 10 MB')
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
      // 拷进一块自己独占的内存:Buffer.concat 的小结果(<4 KB)切自 Node 的共享 8 KB 池,而 IPC 会把整块底层
      // ArrayBuffer 发给渲染层 —— 插件经 bytes.buffer 就能读到池里相邻的数据(别的插件的响应、密钥……,独立评审实测)
      const bytes = new Uint8Array(total)
      let at = 0
      for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
      return { ok: true, status: res.status, headers: res.headers, bytes, url: url.toString() }
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
  /** 这个插件**此刻被装载的那一份**在哪个目录(没有 / 拒载 / agent 自建 Space → null)。由调用方按装载器的实际选择给出:
   *  开发 / 沙箱副本遮住安装版、入口读不到被跳过的安装目录不算、同 id 先到先得 —— 不另写一套选法(2026-11-16 Codex 评审)。 */
  sourceDir(pluginId: string): Promise<string | null>
  /** 目录名 + manifest id → 生效插件 id(与装载器同一条规则 effectivePluginId)。 */
  idOf(dirName: string, manifestId: unknown): string | null
  warn?(msg: string): void
}

/**
 * 按插件 id 从磁盘读它的 `network` 白名单(ctx.net 唯一信的来源)。目录由 sourceDir 给(= 装载器选中的那份),
 * manifest 每次请求都重读:插件升级删掉一个域名,下一次请求就不再放行;目录里的 manifest 换成了别的 id → 不认。
 * 读不到 / 解析不了 → null(拒)。
 */
export function createManifestPatternLookup(deps: ManifestLookupDeps): (pluginId: string) => Promise<string[] | null> {
  const warned = new Set<string>()
  return async (pluginId) => {
    const dir = await deps.sourceDir(pluginId).catch(() => null)
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
