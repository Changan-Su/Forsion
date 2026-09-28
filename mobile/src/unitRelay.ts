/**
 * 手机原生 HTTP 中继的 JS 适配(P1-K8,规格 K8 §3.4;裁决 INTEGRATION R-05 / R-06 / R-32 / §4.2)。
 *
 * 为什么要中继:执行设备要知道「是哪台手机在调」,靠的是 hub 换发的短期调用方票(caller token)随请求带在
 * `X-Forsion-Caller` 头里。票与换票用的调用方凭据**永不进 JS**(XSS 能把票带离设备冒充本机):WebView 的 fetch
 * 没法由原生注头(CapacitorHttp 整包缓冲、SSE 会断;shouldInterceptRequest 拿不到 POST 体),所以远端引擎请求改由
 * 原生插件 `ForsionUnit.request` 代发 —— 头在原生从零重建,目的地只由原生按构建期烤死的 apiBase 拼。
 *
 * 本模块是纯逻辑 + 注入的原生句柄(便于 node 测):
 *   - 只接 relayPaths.parseRelayUrl 判为 relay 的 URL;判为 reject 的失败关闭(TypeError,一个字节都不发);其余返回 null 交回原 fetch;
 *   - 只把 content-type / accept 两个头交给原生(JS 递来的 Authorization、x-forsion-* 一律丢;原生再按白名单重建一遍);
 *   - 响应逐块进 ReadableStream(SSE 不攒包);AbortSignal / reader.cancel() → 原生 cancel;
 *   - 换不到调用方票时**一律不发请求**(失败关闭),按原因交给渲染层(原生侧 UnitError.relayCode 归类,评审 P1):
 *       · `network`(断网 / 网关 5xx / 429,含换票、懒登记、自愈途中)→ TypeError('Failed to fetch'):K6 当离线暂停,网络回来就续;
 *       · `auth_expired`(server 对 forsion_token 回 401)→ **合成 401**(同 hub 的 401 体,无 code):渲染层复检账号 / 重新登录;
 *       · `caller_unsupported`(老 server / 构建)与 `caller_unavailable`(明确拒绝)→ **合成**
 *         `503 {code:'CALLER_UNSUPPORTED' | 'CALLER_UNAVAILABLE'}`:K6 classify 的 caller-unavailable 类(终局),不无限重试。
 *     原先短暂失败也合成 503 CALLER_UNAVAILABLE —— 一次断网就把目标永久判死。
 *   - 只在 native 路径装(K8 §3.4):mobile 的 web dev / preview 没有原生身份,那条路照 Genesis web 的口径走原 fetch(unitBridge.ts)。
 */
import { parseRelayUrl } from './relayPaths'

export type RelayErrorCode = 'relay_busy' | 'bad_path' | 'caller_unavailable' | 'caller_unsupported' | 'auth_expired' | 'network' | 'too_large'

/** 原生 → JS 的逐条消息(UnitPlugin.request 的 keepAlive 回调)。 */
export type RelayMsg =
  | { type: 'head'; status: number; headers: Record<string, string> }
  | { type: 'chunk'; b64: string }
  | { type: 'end' }
  | { type: 'error'; code: RelayErrorCode; message?: string }

export interface RelayRequest {
  id: string
  unitId: string
  /** `/proxy` 之后的部分(以 `/` 开头,含 query),原生侧 RelayPaths.check 再判一遍。 */
  path: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface RelayNative {
  request(o: RelayRequest, cb: (msg: RelayMsg | null, err?: unknown) => void): Promise<unknown>
  cancel(o: { id: string }): Promise<unknown>
}

/** 中继是否可用:原生在、且启动断言 cloudApiBase() === NativeConfig.apiBase 成立(INTEGRATION §4.2)。 */
export type RelayState = 'ready' | 'unsupported'

export interface RelayOptions {
  /** 首个中继请求会等它(启动断言是异步的,拿原生 apiBase 要过一次桥)。 */
  state(): Promise<RelayState>
  /** 相对 URL 的 origin(浏览器里 = location.origin)。 */
  origin?: string
}

/** 只有这两个头交给原生(同 hub / unitWeb / K6 engineFetch 的白名单口径)。 */
const PASS_HEADERS = ['content-type', 'accept'] as const

const NULL_BODY = new Set([204, 205, 304])

let seq = 0
const newId = (): string => {
  seq = (seq + 1) % 1e9
  const rnd = Math.random().toString(36).slice(2, 10)
  return `r${Date.now().toString(36)}${seq.toString(36)}${rnd}`
}

function abortError(): Error {
  try { return new DOMException('The operation was aborted.', 'AbortError') } catch { /* 老环境 */ }
  const e = new Error('The operation was aborted.')
  e.name = 'AbortError'
  return e
}

function netError(code: string, message?: string): TypeError {
  const e = new TypeError('Failed to fetch')
  ;(e as TypeError & { cause?: unknown }).cause = { code, message }
  return e
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * forsion_token 被 server 拒了(原生换票 / 登记撞 401):合成与 hub 一样的 401(无 code —— K6 classify 把无 code 的 401
 * 判成 account-auth?,复检账号;绝不能带 CALLER_* / UNIT_CALLER_* 码,那会被判成终局的身份问题)。
 */
export function authExpired(): Response {
  return new Response(JSON.stringify({ detail: 'Invalid or expired token' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
}

/** 合成的失败关闭响应(英文 detail;渲染层按 code 本地化)。 */
export function callerRefusal(kind: 'unavailable' | 'unsupported', message?: string): Response {
  const code = kind === 'unavailable' ? 'CALLER_UNAVAILABLE' : 'CALLER_UNSUPPORTED'
  const detail = message || (kind === 'unavailable'
    ? 'This phone could not prove its identity to the relay; the request was not sent'
    : 'Running on a computer from this phone is not supported by this build or server; the request was not sent')
  return new Response(JSON.stringify({ code, detail }), { status: 503, headers: { 'Content-Type': 'application/json' } })
}

function urlOf(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  if (input && typeof (input as Request).url === 'string') return (input as Request).url
  return null
}

/**
 * 造一个 fetch 前置判定器:返回 null = 不是中继 URL(调用方走原 fetch);否则返回这次请求的 Promise<Response>。
 * 只在 native 路径造(unitBridge.ts);opts.state() 不是 ready(原生缺席 / 启动断言不成立)时中继面一律合成 503 CALLER_UNSUPPORTED。
 */
export function createRelayFetch(native: RelayNative, apiBase: string, opts: RelayOptions):
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | null {
  return (input, init) => {
    const url = urlOf(input)
    if (url === null) return null
    const r = parseRelayUrl(apiBase, url, opts.origin)
    if (r === null) return null
    if (r.kind === 'reject') return Promise.reject(new TypeError(`unit relay: ${r.reason}`))
    return send(native, opts, r.unitId, r.path, input, init)
  }
}

async function send(native: RelayNative, opts: RelayOptions, unitId: string, path: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === 'object' && !(typeof URL !== 'undefined' && input instanceof URL) ? (input as Request) : null
  const signal: AbortSignal | undefined = init?.signal ?? req?.signal ?? undefined
  if (signal?.aborted) throw abortError()
  const method = String(init?.method ?? req?.method ?? 'GET').toUpperCase()

  const merged = new Headers(req?.headers ?? undefined)
  new Headers(init?.headers ?? undefined).forEach((v, k) => merged.set(k, v))
  const headers: Record<string, string> = {}
  for (const k of PASS_HEADERS) {
    const v = merged.get(k)
    if (v != null) headers[k] = v
  }

  let body: string | undefined
  const rawBody = init && 'body' in init ? init.body : undefined
  if (rawBody != null) {
    if (typeof rawBody !== 'string') throw new TypeError('unit relay: body must be a string')
    body = rawBody
  } else if (req && req.body != null) {
    body = await req.text()
  }
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) throw new TypeError('unit relay: GET/HEAD cannot carry a body')

  const state = await opts.state()
  if (signal?.aborted) throw abortError()
  if (state !== 'ready') return callerRefusal('unsupported')

  const id = newId()
  return new Promise<Response>((resolve, reject) => {
    let headSent = false
    let finished = false
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const cancelNative = (): void => { void native.cancel({ id }).catch(() => { /* 已结束 */ }) }
    const finish = (): void => {
      finished = true
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      if (finished) return
      finish()
      cancelNative()
      const e = abortError()
      if (!headSent) reject(e)
      else { try { controller?.error(e) } catch { /* 已关 */ } }
    }
    signal?.addEventListener('abort', onAbort)

    const fail = (code: string, message?: string): void => {
      if (finished) return
      finish()
      if (!headSent) {
        if (code === 'caller_unavailable') resolve(callerRefusal('unavailable'))
        else if (code === 'caller_unsupported') resolve(callerRefusal('unsupported'))
        else if (code === 'auth_expired') resolve(authExpired())
        else reject(netError(code, message))
      } else {
        try { controller?.error(netError(code, message)) } catch { /* 已关 */ }
      }
    }

    const onMsg = (msg: RelayMsg | null, err?: unknown): void => {
      if (finished) return
      if (err || !msg) { fail('network', err instanceof Error ? err.message : undefined); return }
      switch (msg.type) {
        case 'head': {
          if (headSent) return
          const status = Number(msg.status)
          if (!Number.isInteger(status) || status < 200 || status > 599) { cancelNative(); fail('network', `unexpected status ${msg.status}`); return }
          headSent = true
          const hdrs = new Headers()
          for (const [k, v] of Object.entries(msg.headers || {})) { try { hdrs.set(k, String(v)) } catch { /* 坏头丢掉 */ } }
          if (NULL_BODY.has(status) || method === 'HEAD') {
            resolve(new Response(null, { status, headers: hdrs }))
            return // 余下的 chunk 忽略,end 收尾
          }
          const stream = new ReadableStream<Uint8Array>({
            start(c) { controller = c },
            cancel() { if (!finished) { finish(); cancelNative() } },
          })
          resolve(new Response(stream, { status, headers: hdrs }))
          return
        }
        case 'chunk': {
          if (!headSent) { cancelNative(); fail('network', 'chunk before head'); return }
          if (!controller) return // 空体响应:丢弃
          try { controller.enqueue(b64ToBytes(msg.b64)) } catch { /* reader 已取消 */ }
          return
        }
        case 'end': {
          if (!headSent) { fail('network', 'end before head'); return }
          finish()
          try { controller?.close() } catch { /* 已关 */ }
          return
        }
        case 'error': {
          fail(msg.code, msg.message)
          return
        }
      }
    }

    native.request({ id, unitId, path, method, headers, ...(body !== undefined ? { body } : {}) }, onMsg)
      .catch((e: unknown) => { fail('network', e instanceof Error ? e.message : String(e)) })
  })
}
