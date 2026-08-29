/**
 * 扶桑根 P2P 直连(桌面↔桌面)的语义层:HTTP ↔ 帧 ↔ 信封,运输层可插拔。
 *
 * 定位(方案 §12,2026-08-25 用户拍板):桌面↔桌面在 T2 之外加一条打洞直连的快路,**中转是保底**
 * ——信封语义与 T2 恒等(method/path/ct/accept/body),只是运输从「server SSE + resp/stream」换成
 * 一条 DataChannel。裸浏览器/移动端刻意不做(没有 socket 面,保底即正路)。
 *
 * 本文件零 electron / 零 WebRTC 依赖:两端各拿一个 FrameChannel(send/onMessage/onClose),
 * vitest 用内存对管跑全脊柱(unitP2p.test.ts);真运输 = 隐藏窗里的 RTCDataChannel(p2pWindow.ts)。
 *
 * 帧协议 v1(全 JSON 文本帧;字节走 base64——SCTP 消息面再省也省不过先跑通,二进制帧留给 v2):
 *   hello  {t:'hello', v:1, caps:[]}          — 信道开门第一帧,双向;版本不认识=readable close。
 *                                               两端桌面版本**不原子升级**(HUB_CAPS 同课),caps 只增不删。
 *   req    {t:'req', id, method, path, ct?, accept?, hasBody?} — 体**绝不内联**:>190K 源字节的
 *                                               单帧会撞 DataChannel 256KiB 上限当场杀信道(贴图/长文必踩)。
 *   chunk  {t:'chunk', id, b64}               — 体分片,**上下行对称**(方向由角色隐含:A 发的 chunk=请求体,
 *                                               B 发的=响应体);**信用窗口**流控(不背压撑爆 DataChannel 缓冲)。
 *   head   {t:'head', id, status, ct, headers?}— headers 仅安全头白名单(csp/xcto),同 unitHost 口径。
 *   credit {t:'credit', id, n}                — 收方补发信用(方向同样由发送者角色隐含);发方额度归零即停读。
 *   end    {t:'end', id}                      — 该方向的体完(正常终止;中断走 abort——语义区分照 T2 destroy≠end
 *   abort  {t:'abort', id, reason?}             的教训:end 伪装完整=收方拿到「200 且看起来完整」的截断体)。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export const P2P_PROTO_V = 1
/** 响应体分片大小:DataChannel 消息面 Chromium 上限 256KiB,b64 膨胀 4/3 → 128K 源字节封顶安全。 */
const CHUNK_BYTES = 128 * 1024
/** 信用窗口:未确认分片数上限(4 × 128K = 512K 在途,LAN RTT 下吞吐够,内存有界)。 */
const CREDIT_WINDOW = 4
/** 信道级在途分片总顶帽:N 个并发大响应各自 4 片会把 DataChannel 发送缓冲顶到 N×512K,
 *  撞 Chromium ~16MB 上限时 dc.send 抛错=整条 peer 陪葬。16×~172K(b64) ≈ 2.7MB,安全余量足。 */
// ponytail: 全局计数顶帽;真按 bufferedAmountLow 回压要穿 preload↔主进程反向流控,量级不值当
const GLOBAL_INFLIGHT_MAX = 16
/** 请求体上限:与 T2 隧道信封同口径(10MB),两条路语义恒等。 */
const MAX_REQ_BODY = 10 * 1024 * 1024

/** 运输面契约:p2pWindow(真 DataChannel)与测试内存对管都实现它。文本消息,有序可靠。 */
export interface FrameChannel {
  send: (text: string) => void
  onMessage: (cb: (text: string) => void) => void
  onClose: (cb: () => void) => void
  close: () => void
}

type Frame =
  | { t: 'hello'; v: number; caps: string[] }
  | { t: 'req'; id: string; method: string; path: string; ct?: string; accept?: string; hasBody?: boolean }
  | { t: 'head'; id: string; status: number; ct: string; headers?: Record<string, string> }
  | { t: 'chunk'; id: string; b64: string }
  | { t: 'credit'; id: string; n: number }
  | { t: 'end'; id: string }
  | { t: 'abort'; id: string; reason?: string }

const parseFrame = (text: string): Frame | null => {
  try {
    const f = JSON.parse(text) as Frame
    return typeof f === 'object' && f !== null && typeof (f as { t?: unknown }).t === 'string' ? f : null
  } catch { return null }
}

/** 安全头白名单(与 unitHost 的回包口径同源):CSP sandbox 惰化不受信附件,剥掉=HTML 附件在
 *  代理 origin 上活着执行。P2P 路没有「老网关」问题(两端就是彼此),但两端版本仍可能不同代,
 *  白名单结构照抄,别自由透传。 */
const SEC_HEADERS = ['content-security-policy', 'x-content-type-options'] as const

// ── B 侧:帧 → 本机 unitWeb ─────────────────────────────────────────────────────

export interface P2pHostDeps {
  /** 本机 unitWeb(与 unitHost.getUnitWeb 同源):url=null → 503。 */
  getUnitWeb: () => { url: string | null; internalSecret: string }
  log: (m: string) => void
}

/**
 * 把一条已建立的信道接到本机 unitWeb 上(B 侧执行器)。信封处理与 unitHost.handle 同构:
 * 盖 x-unit-internal、响应体全流式(P2P 没有「小响应整包省一跳」的动机,一条路简单)。
 * 返回 detach(信道关闭/身份变化时调用,中止全部在飞请求)。
 */
export function attachHostChannel(ch: FrameChannel, deps: P2pHostDeps): { detach: () => void; stats: () => { inflight: number; credits: number; uploads: number } } {
  const inflight = new Map<string, AbortController>()
  let alive = true
  const send = (f: Frame): void => { if (alive) try { ch.send(JSON.stringify(f)) } catch { /* 信道已死,onClose 会收尾 */ } }

  send({ t: 'hello', v: P2P_PROTO_V, caps: [] })

  /** 上行请求体收集(A 发来的 chunk/end;B 收到的 chunk 只可能是这个方向)。 */
  const uploads = new Map<string, { req: Extract<Frame, { t: 'req' }>; parts: Buffer[]; size: number }>()

  ch.onMessage((text) => {
    const f = parseFrame(text)
    if (!f) return
    if (f.t === 'hello') {
      if (f.v !== P2P_PROTO_V) {
        deps.log(`[unit-p2p] 对端协议 v${f.v} 与本端 v${P2P_PROTO_V} 不符,关闭信道`)
        ch.close()
      }
      return
    }
    if (f.t === 'req') {
      if (f.hasBody) uploads.set(f.id, { req: f, parts: [], size: 0 })
      else void handleReq(f, undefined)
      return
    }
    if (f.t === 'chunk') {
      const u = uploads.get(f.id)
      if (!u) return // 不认识的上行片(req 已被 abort 掉):静默丢,别的请求不受扰
      const b = Buffer.from(f.b64, 'base64')
      u.size += b.length
      if (u.size > MAX_REQ_BODY) { // 防御性重申 10MB 顶(A 侧也钳,但执行器不信对端)
        uploads.delete(f.id)
        send({ t: 'abort', id: f.id, reason: '请求体超限(10MB)' })
        return
      }
      u.parts.push(b)
      send({ t: 'credit', id: f.id, n: 1 }) // 收即消费(只是缓冲),立刻还信用;在途量由窗口钳住
      return
    }
    if (f.t === 'end') {
      const u = uploads.get(f.id)
      if (u) { uploads.delete(f.id); void handleReq(u.req, Buffer.concat(u.parts)) }
      return
    }
    if (f.t === 'credit') { creditArrived(f.id, f.n); return }
    if (f.t === 'abort') {
      uploads.delete(f.id)
      inflight.get(f.id)?.abort()
      credits.get(f.id)?.wake?.() // 泵可能正卡在零信用等待:abort 不唤它就永远到不了 finally(泄 reader)
    }
  })
  ch.onClose(() => {
    alive = false
    uploads.clear()
    for (const c of inflight.values()) c.abort()
    inflight.clear()
    for (const c of credits.values()) c.wake?.() // 等信用的泵全部唤醒自检退出(不唤=reader 永久悬挂)
  })

  /** 每请求的信用账本:发 chunk 扣 1,credit 帧补;归零即等待(等待必须能被 abort/close 唤醒)。 */
  const credits = new Map<string, { n: number; wake: (() => void) | null }>()
  /** 信道级在途分片计数(全部请求合计):credit 回来即视为对端已消化一片。 */
  let globalInflight = 0
  const globalWaiters = new Set<() => void>()
  const creditArrived = (id: string, n: number): void => {
    globalInflight = Math.max(0, globalInflight - n)
    for (const w of [...globalWaiters]) w()
    const c = credits.get(id)
    if (!c) return
    c.n += n
    c.wake?.()
  }
  const takeCredit = async (id: string, ctrl: AbortController): Promise<boolean> => {
    const c = credits.get(id)
    if (!c) return false
    while (c.n <= 0 || globalInflight >= GLOBAL_INFLIGHT_MAX) {
      if (!alive || ctrl.signal.aborted) return false
      let release: () => void = () => {}
      await new Promise<void>((r) => {
        release = r
        c.wake = r
        globalWaiters.add(r)
      })
      globalWaiters.delete(release)
      c.wake = null
    }
    if (!alive || ctrl.signal.aborted) return false
    c.n -= 1
    globalInflight += 1
    return true
  }

  const handleReq = async (f: Extract<Frame, { t: 'req' }>, body: Buffer | undefined): Promise<void> => {
    const ctrl = new AbortController()
    inflight.set(f.id, ctrl)
    credits.set(f.id, { n: CREDIT_WINDOW, wake: null })
    try {
      const web = deps.getUnitWeb()
      if (!web.url) {
        send({ t: 'head', id: f.id, status: 503, ct: 'application/json' })
        send({ t: 'chunk', id: f.id, b64: Buffer.from(JSON.stringify({ detail: '本机互联服务未就绪', code: 'UNIT_WEB_NOT_READY' })).toString('base64') })
        send({ t: 'end', id: f.id })
        return
      }
      const headers: Record<string, string> = { 'x-unit-internal': web.internalSecret }
      if (f.ct) headers['Content-Type'] = f.ct
      if (f.accept) headers.Accept = f.accept
      let r: Response
      try {
        r = await fetch(`${web.url}${f.path}`, {
          method: f.method,
          headers,
          // concat 出来的 Buffer<ArrayBufferLike> 过不了 DOM BodyInit(SharedArrayBuffer 泛型),
          // 拷进新 Uint8Array<ArrayBuffer>(≤10MB 一次性拷,不在热路径)
          body: body ? new Uint8Array(body) : undefined,
          signal: ctrl.signal,
        })
      } catch (e: any) {
        if (ctrl.signal.aborted) return
        send({ t: 'head', id: f.id, status: 502, ct: 'application/json' })
        send({ t: 'chunk', id: f.id, b64: Buffer.from(JSON.stringify({ detail: `本机互联服务不可达: ${e?.message || e}` })).toString('base64') })
        send({ t: 'end', id: f.id })
        return
      }
      const extra: Record<string, string> = {}
      for (const k of SEC_HEADERS) { const v = r.headers.get(k); if (v) extra[k] = v }
      send({ t: 'head', id: f.id, status: r.status, ct: r.headers.get('content-type') || 'application/octet-stream', ...(Object.keys(extra).length ? { headers: extra } : {}) })
      if (r.body) {
        // 每次 read 的字节就地切帧(≤CHUNK_BYTES),不攒不憋:SSE 逐 token 一片一帧(延迟优先),
        // 大响应 undici 单次 read 本就 64K+ 量级(吞吐靠信用窗口,不靠拼片)。
        const reader = r.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (ctrl.signal.aborted || !alive) { try { await reader.cancel() } catch { /* 已断 */ } return }
          if (value && value.length) {
            const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            for (let off = 0; off < buf.length; off += CHUNK_BYTES) {
              if (!(await takeCredit(f.id, ctrl))) { try { await reader.cancel() } catch { /* 已断 */ } return }
              send({ t: 'chunk', id: f.id, b64: buf.subarray(off, Math.min(off + CHUNK_BYTES, buf.length)).toString('base64') })
            }
          }
          if (done) break
        }
      }
      send({ t: 'end', id: f.id })
    } catch (e: any) {
      // 读体中途炸(引擎断流等):**必须 abort 不是 end**——end 会让 A 侧把截断体当完整响应交付。
      if (alive) send({ t: 'abort', id: f.id, reason: String(e?.message || e) })
    } finally {
      inflight.delete(f.id)
      credits.delete(f.id)
    }
  }

  return {
    /** 观测口(仅测试):泄漏的本体是 abort/close 后账本不清空(泵悬在零信用等待,到不了 finally)。 */
    stats: () => ({ inflight: inflight.size, credits: credits.size, uploads: uploads.size }),
    detach: () => {
      alive = false
      for (const c of inflight.values()) c.abort()
      for (const c of credits.values()) c.wake?.() // detach 同 close:唤醒等信用的泵
      inflight.clear()
      try { ch.close() } catch { /* 已关 */ }
    },
  }
}

// ── A 侧:本机代理 → 帧 ─────────────────────────────────────────────────────────

export interface P2pProxyHandle {
  port: number
  url: string
  /** 本代理的 Bearer 秘密:webview 分区注入用(loopback 上别的进程没有它=打不动对端)。 */
  secret: string
  close: () => Promise<void>
}

/**
 * A 侧本机代理:127.0.0.1 HTTP 面,请求转帧走信道,响应流式写回。webview 指它当 lanUrl 用,
 * 渲染层零改动。鉴权 = per-proxy 随机 Bearer(分区注入,同隧道 Authorization 的机制)——
 * 没有它,loopback 上任意本地进程都能借这条信道全权驱动对端。
 */
export function startP2pProxy(ch: FrameChannel, opts?: { log?: (m: string) => void }): Promise<P2pProxyHandle> {
  const log = opts?.log ?? (() => {})
  const secret = randomUUID()
  interface Pending {
    res: http.ServerResponse
    gotHead: boolean
    /** 已收未确认的分片数;写回 drain 后按数补 credit(下游慢→在途有界)。 */
    unacked: number
  }
  const pending = new Map<string, Pending>()
  /** 上行(请求体)信用:B 逐片补;泵归零即停。 */
  const upCredits = new Map<string, { n: number; wake: (() => void) | null }>()
  let helloOk = false
  let closed = false

  const send = (f: Frame): void => { try { ch.send(JSON.stringify(f)) } catch { /* 信道已死 */ } }
  send({ t: 'hello', v: P2P_PROTO_V, caps: [] })

  const failAll = (why: string): void => {
    for (const [id, p] of pending) {
      if (!p.gotHead) {
        p.res.writeHead(502, { 'Content-Type': 'application/json' })
        p.res.end(JSON.stringify({ detail: `P2P 信道中断: ${why}` }))
      } else {
        p.res.destroy() // 头已 flush:destroy 不是 end——end 会把截断体伪装成完整响应
      }
      pending.delete(id)
    }
  }

  ch.onMessage((text) => {
    const f = parseFrame(text)
    if (!f) return
    if (f.t === 'hello') {
      if (f.v !== P2P_PROTO_V) { log(`[unit-p2p] 对端协议 v${f.v} 不符`); ch.close(); return }
      helloOk = true
      return
    }
    if (f.t === 'credit') { // A 收到的 credit 只可能是上行方向(B 消化了请求体分片)
      const c = upCredits.get(f.id)
      if (c) { c.n += f.n; c.wake?.() }
      return
    }
    if (f.t === 'head' || f.t === 'chunk' || f.t === 'end' || f.t === 'abort') {
      const p = pending.get(f.id)
      if (!p) { if (f.t !== 'end' && f.t !== 'abort') send({ t: 'abort', id: f.id, reason: 'gone' }); return }
      if (f.t === 'head') {
        p.gotHead = true
        p.res.writeHead(f.status, { 'Content-Type': f.ct, ...(f.headers || {}) })
        return
      }
      if (f.t === 'chunk') {
        const buf = Buffer.from(f.b64, 'base64')
        p.unacked += 1
        const flushed = p.res.write(buf)
        const ack = (): void => { if (pending.has(f.id)) { p.unacked -= 1; send({ t: 'credit', id: f.id, n: 1 }) } }
        if (flushed) ack()
        else p.res.once('drain', ack) // 下游(webview)慢:drain 才补信用,B 侧自然停读
        return
      }
      if (f.t === 'end') { p.res.end(); pending.delete(f.id); return }
      // abort:中断必须让客户端看得出来(destroy),截断体绝不伪装完整。
      if (!p.gotHead) {
        p.res.writeHead(502, { 'Content-Type': 'application/json' })
        p.res.end(JSON.stringify({ detail: `对端中断: ${f.reason || 'aborted'}` }))
      } else {
        p.res.destroy()
      }
      pending.delete(f.id)
    }
  })
  ch.onClose(() => {
    closed = true
    failAll('信道已关闭')
    for (const c of upCredits.values()) c.wake?.() // 等信用的泵全部唤醒自检退出
  })

  const server = http.createServer((req, res) => {
    void (async () => {
      if (closed || !helloOk) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: closed ? 'P2P 信道已关闭' : 'P2P 信道未就绪' }))
        return
      }
      if (req.headers.authorization !== `Bearer ${secret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: 'unauthorized' }))
        return
      }
      // 拒掉跨源来路(纵深防御,分区注入侧同规):设备页自己的请求 = same-origin,webview 首层
      // 导航 = none;第三方页面的 fetch/表单 = cross-site/same-site,即使秘密被注入也不放行。
      // 非浏览器客户端(测试/工具)不带该头 → 放行,Bearer 闸照常把关。
      const sfs = String(req.headers['sec-fetch-site'] || '')
      if (sfs && sfs !== 'none' && sfs !== 'same-origin') {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: `跨源来路拒绝(sec-fetch-site=${sfs})` }))
        return
      }
      // 收请求体(与隧道信封同顶;信封面语义恒等——Authorization 剥掉,身份声明不过信道)。
      const chunks: Buffer[] = []
      let n = 0
      let overflow = false
      let broken = false // 上传半途断线:'error'/'aborted' ≠ 正常 EOF,部分体绝不当完整请求转发
      await new Promise<void>((resolve) => {
        req.on('data', (c: Buffer) => {
          n += c.length
          if (n > MAX_REQ_BODY) { overflow = true; req.destroy(); resolve(); return }
          chunks.push(c)
        })
        req.on('end', resolve)
        req.on('error', () => { broken = true; resolve() })
        req.on('aborted', () => { broken = true; resolve() })
      })
      if (broken || (req.readableEnded === false && !overflow)) {
        // 客户端在上传途中断开:一帧都不出(对端看不到这次请求)——截断体执行出去就是数据损坏。
        try { res.destroy() } catch { /* 已断 */ }
        return
      }
      if (overflow) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: '请求体超限(10MB)' }))
        return
      }
      const id = randomUUID()
      res.on('error', () => { /* 客户端断开后的残余写,close 分支已收尾 */ })
      pending.set(id, { res, gotHead: false, unacked: 0 })
      res.on('close', () => {
        if (pending.delete(id)) send({ t: 'abort', id, reason: 'client closed' })
        upCredits.get(id)?.wake?.() // 泵若在等信用,唤醒它自检退出
      })
      const body = Buffer.concat(chunks)
      send({
        t: 'req',
        id,
        method: req.method || 'GET',
        path: req.url || '/',
        ...(req.headers['content-type'] ? { ct: String(req.headers['content-type']) } : {}),
        ...(req.headers.accept ? { accept: String(req.headers.accept) } : {}),
        ...(body.length ? { hasBody: true } : {}),
      })
      // 上行体走对称分片(体绝不内联 req 帧:>190K 源字节单帧撞 DataChannel 256KiB 上限,
      // dc.send 一抛整条会话陪葬——贴图进笔记/存长文必踩)。B 端等到 end 才发起 fetch。
      if (body.length) {
        void (async () => {
          const c = { n: CREDIT_WINDOW, wake: null as (() => void) | null }
          upCredits.set(id, c)
          try {
            for (let off = 0; off < body.length; off += CHUNK_BYTES) {
              while (c.n <= 0) {
                if (closed || !pending.has(id)) return // 请求已死:泵直接退,别泄
                await new Promise<void>((r) => { c.wake = r })
                c.wake = null
              }
              if (closed || !pending.has(id)) return
              c.n -= 1
              send({ t: 'chunk', id, b64: body.subarray(off, Math.min(off + CHUNK_BYTES, body.length)).toString('base64') })
            }
            if (!closed && pending.has(id)) send({ t: 'end', id })
          } finally {
            upCredits.delete(id)
          }
        })()
      }
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        secret,
        close: () => new Promise<void>((r) => {
          closed = true
          failAll('代理已关闭')
          try { ch.close() } catch { /* 已关 */ }
          server.close(() => r())
        }),
      })
    })
  })
}

/** 测试/进程内用:内存对管(两端 FrameChannel,微任务投递保持有序)。 */
interface MemChannel extends FrameChannel {
  _peer?: MemChannel
  _onMsg: ((t: string) => void)[]
  _onClose: (() => void)[]
  _closed: boolean
}
export function memoryChannelPair(): [FrameChannel, FrameChannel] {
  const mk = (): MemChannel => {
    const self: MemChannel = {
      _onMsg: [] as ((t: string) => void)[],
      _onClose: [] as (() => void)[],
      _closed: false,
      _peer: undefined,
      send: (text: string) => {
        const peer = self._peer
        if (!peer || self._closed || peer._closed) throw new Error('channel closed')
        // 忠实于真运输:Chromium DataChannel 单消息 256KiB 上限,超了 send 就地抛
        // (假运输更宽容=假绿机理——上行不分片的 bug 正是靠这条红出来的)。
        if (Buffer.byteLength(text) > 256 * 1024) throw new Error('message too large (DataChannel 256KiB)')
        queueMicrotask(() => { if (!peer._closed) for (const cb of peer._onMsg) cb(text) })
      },
      onMessage: (cb: (t: string) => void) => { self._onMsg.push(cb) },
      onClose: (cb: () => void) => { self._onClose.push(cb) },
      close: () => {
        if (self._closed) return
        self._closed = true
        const peer = self._peer
        queueMicrotask(() => {
          for (const cb of self._onClose) cb()
          if (peer && !peer._closed) peer.close()
        })
      },
    }
    return self
  }
  const a = mk()
  const b = mk()
  a._peer = b
  b._peer = a
  return [a, b]
}
