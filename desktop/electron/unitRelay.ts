/**
 * 桌面主窗口作为**调用方**:把会话建到账号下另一台电脑上时,请求经这里发往 hub 隧道。
 * (K6 §2.5 / §8 待拍板 1「桌面主窗口作为驱动方」;调用方身份 = K1 末尾备注「桌面作为调用方」。2026-10-14 用户定做。)
 *
 * 为什么要有这一层:渲染层手里只有**本机引擎**的令牌,云端的 forsion_token 不下发渲染层(主进程独占)。手机那边是原生中继代发
 * (mobile/src/unitRelay.ts);桌面这边由主进程在 127.0.0.1 上开一个中转口,渲染层凭一枚**本次启动才有的口令**打它,
 * 主进程把头从零重建、换上 forsion_token 与调用方票,再发往 `${apiBase}/units/<id>/proxy/…`。与 P2P 本机代理(unitP2p.ts)同一个做法:
 * 没有口令的本机进程打不动它。
 *
 * 只认两类面(shared/relayPaths.ts,其余一律 404、一个字节都不发):
 *   调用方面  engine* / unit/remote-access(/request)      → 附调用方票 X-Forsion-Caller(本机登记过设备时)
 *   设备辅助面 unit/hostfile|hostfile/download|hostdir|hoststat|config(只收 GET) → 照设计匿名(R-06)
 *
 * 调用方身份(K1 §3.6 / R-03 / R-05):
 *   本机登记过设备(unitHost 配对在)→ 凭设备密钥签发调用方凭据(只留在这个进程的内存里:重启 = 轮换,别处没人用它)
 *     → 换 10 分钟的票,过期前 60s 续;票被拒(UNIT_CALLER_EXPIRED / INVALID)重取一次再发。
 *     **有配对却取不到票 = 失败关闭**(503 CALLER_UNAVAILABLE,请求不发):只带 Bearer 照发 = 静默降级成账号级未识别调用方,
 *     绕开那台电脑按设备给的信任 / 拒绝(INTEGRATION §4.2)。钥匙串锁着读不出配对同此。
 *   本机没登记过设备 → 不带票:那台电脑按「本账号下未识别的客户端」处理(缺席是设计,R-05)。这里**不替用户登记本机** ——
 *     登记 = 让别的设备也能连进来,那是「允许其他设备连接本机」开关的事。
 *
 * 口令跟着账号走(Codex 评审 10-14):口令是发给「当时登录的那个账号」的,账号一换(登出 / 换号)旧口令当场作废 ——
 *   否则渲染层手里还攥着旧口令的在途请求(上个账号的电脑、上个账号的会话)会被盖上**新账号**的 forsion_token 发出去。
 *   渲染层在登录态变化后重新来取(appStore.onAuthChanged → refreshDesktopRelay)。
 *
 * 零 electron 依赖(fetch / 时钟都可注入),vitest 直接起一个假 hub 跑(unitRelay.test.ts)。
 */
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { checkRelayPath, checkUnitSurfacePath, UNIT_UUID_RE } from '../shared/relayPaths'

export interface UnitRelayDeps {
  /** 云端 API 基址(含 /api、无尾斜杠);没配 → ''。 */
  apiBase(): string | Promise<string>
  /** forsion_token;没登录 → ''。 */
  token(): string
  /** 当前登录账号的稳定身份(云端源 + userId;令牌续期不变,换号 / 登出才变);没登录 → null。口令按它发、按它验。 */
  account(): string | null
  /** 本机作为设备的配对:没登记 → null;读不出来(钥匙串锁着)→ 'locked'。 */
  pairing(): Promise<{ unitId: string; secret: string } | null | 'locked'>
  fetch?: typeof fetch
  now?: () => number
}

export interface UnitRelay {
  /** 起中转口(幂等),回渲染层要的那一份:本机基址(无尾斜杠)+ 发给**当前账号**的口令。没登录 → null。 */
  open(): Promise<{ base: string; token: string } | null>
  close(): Promise<void>
}

/** hub 隧道的 JSON 体上限是 10MB;这里略放宽一点,超了由 hub 回 413 的人话。 */
const MAX_BODY = 12 * 1024 * 1024
/** 票在过期前这么久就续(K1 §3.6)。 */
const TICKET_RENEW_MS = 60_000
/** 回程只带这几个头。不带 content-length:fetch 会替我们解压(gzip),原长度对不上解压后的字节数。 */
const PASS_RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-disposition', 'x-accel-buffering']

const json = (res: http.ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

class RelayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
/** 取不到调用方身份(与手机中继合成的 503 同码,渲染层 classify 认得)。 */
const callerUnavailable = (why: string): RelayError => new RelayError(503, 'CALLER_UNAVAILABLE', `caller identity unavailable: ${why}`)

export function createUnitRelay(deps: UnitRelayDeps): UnitRelay {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  /** 发出去的口令只有一枚,属于 issued.account;账号变了下次 open() 换新的,旧的从此谁也验不过。 */
  let issued: { account: string; secret: string } | null = null
  let server: http.Server | null = null
  let opening: Promise<string> | null = null

  // ── 调用方票 ──
  /** 凭据与票都按 (设备, 账号令牌) 记:换号 / 重新登记后自然作废。 */
  let cred: { unitId: string; token: string; callerSecret: string } | null = null
  let ticket: { unitId: string; token: string; value: string; expiresAt: number } | null = null
  /** 在途的换票,按 (设备, 账号令牌) 记:换号后的第一条请求不许搭上个账号那一趟(它的 401 / 失败会被错记到新账号头上)。 */
  let minting: { key: string; flight: Promise<string> } | null = null

  const hub = async (api: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> => {
    let r: Response
    try {
      r = await doFetch(`${api}${path}`, { method: 'POST', headers, signal: AbortSignal.timeout(20_000) })
    } catch (e) {
      throw callerUnavailable((e as Error)?.message || 'network')
    }
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }
  }

  async function mint(api: string, token: string, pairing: { unitId: string; secret: string }): Promise<string> {
    const auth = { Authorization: `Bearer ${token}` }
    for (let attempt = 0; ; attempt++) {
      if (!cred || cred.unitId !== pairing.unitId || cred.token !== token) {
        const issued = await hub(api, `/units/${pairing.unitId}/caller-secret`, { ...auth, 'X-Unit-Secret': pairing.secret })
        if (issued.status === 401) throw new RelayError(401, 'NOT_SIGNED_IN', 'forsion session rejected')
        if (issued.status !== 200 || typeof issued.body.callerSecret !== 'string') throw callerUnavailable(`caller-secret HTTP ${issued.status}`)
        cred = { unitId: pairing.unitId, token, callerSecret: issued.body.callerSecret }
      }
      const r = await hub(api, `/units/${pairing.unitId}/caller-token`, { ...auth, 'X-Unit-Caller-Secret': cred.callerSecret })
      if (r.status === 200 && typeof r.body.token === 'string') {
        // expiresAt 是 epoch 秒(INTEGRATION §2);读不出来按 10 分钟算
        const exp = typeof r.body.expiresAt === 'number' ? r.body.expiresAt * 1000 : now() + 600_000
        ticket = { unitId: pairing.unitId, token, value: r.body.token, expiresAt: exp }
        return r.body.token
      }
      if (r.status === 401) throw new RelayError(401, 'NOT_SIGNED_IN', 'forsion session rejected')
      // 凭据失配(别处轮换过 / 本机重新登记过)→ 轮换一次再换票(R-03);再不行就失败关闭
      if (r.status === 403 && r.body.code === 'UNIT_CALLER_SECRET_MISMATCH' && attempt === 0) { cred = null; continue }
      throw callerUnavailable(`caller-token HTTP ${r.status}`)
    }
  }

  /** 这次调用方面的请求要带的头:{} = 本机没登记过设备(未识别调用方);抛 = 失败关闭。 */
  async function callerHeaders(api: string, token: string): Promise<Record<string, string>> {
    const pairing = await deps.pairing()
    if (pairing === 'locked') throw callerUnavailable('device pairing is locked')
    if (!pairing) return {}
    if (!UNIT_UUID_RE.test(pairing.unitId)) throw callerUnavailable('device pairing has a malformed unit id')
    if (ticket && ticket.unitId === pairing.unitId && ticket.token === token && ticket.expiresAt - now() > TICKET_RENEW_MS) {
      return { 'X-Forsion-Caller': ticket.value }
    }
    const key = `${pairing.unitId}\n${token}`
    if (minting?.key !== key) {
      const mine = { key, flight: mint(api, token, pairing) }
      minting = mine
      void mine.flight.catch(() => {}).finally(() => { if (minting === mine) minting = null })
    }
    return { 'X-Forsion-Caller': await minting.flight }
  }

  // ── 转发 ──
  /** hub 的隧道只收 JSON 体(它自己 JSON.parse 再封进信封),所以按 UTF-8 文本读、原样发。 */
  async function readBody(req: http.IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > MAX_BODY) throw new RelayError(413, 'RELAY_BODY_TOO_LARGE', 'request body too large for the tunnel')
      chunks.push(c as Buffer)
    }
    return size ? Buffer.concat(chunks).toString('utf8') : null
  }

  async function forward(req: http.IncomingMessage, res: http.ServerResponse, unitId: string, path: string, withCaller: boolean, account: string): Promise<void> {
    const api = (await deps.apiBase()).replace(/\/+$/, '')
    // 令牌与账号在同一段同步代码里取:验口令之后账号又换了(上面那个 await 的空当)→ 这条请求是上个账号的,不发
    const token = deps.token()
    if (deps.account() !== account) throw new RelayError(401, 'RELAY_UNAUTHORIZED', 'relay token belongs to another account')
    if (!api || !token) throw new RelayError(401, 'NOT_SIGNED_IN', 'not signed in to Forsion')
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req)
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    const send = async (): Promise<Response> => {
      // 头从零重建:渲染层带来的 Authorization 是口令(绝不出门),X-Forsion-Caller 也只由这里盖
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(withCaller ? await callerHeaders(api, token) : {}) }
      if (body) headers['Content-Type'] = String(req.headers['content-type'] || 'application/json')
      if (req.headers.accept) headers.Accept = String(req.headers.accept)
      return doFetch(`${api}/units/${unitId}/proxy${path}`, { method: req.method, headers, body, signal: abort.signal })
    }
    let up = await send()
    // 票被 hub 拒:丢掉重取一次再发(R-04)。INVALID 连凭据一起换(可能已在别处轮换)。
    if (withCaller && up.status === 403 && ticket) {
      const text = await up.text()
      let code = ''
      try { code = String((JSON.parse(text) as { code?: unknown }).code || '') } catch { /* 不是 JSON:原样交回 */ }
      if (code === 'UNIT_CALLER_EXPIRED' || code === 'UNIT_CALLER_INVALID') {
        ticket = null
        if (code === 'UNIT_CALLER_INVALID') cred = null
        up = await send()
      } else {
        res.writeHead(403, { 'Content-Type': up.headers.get('content-type') || 'application/json' })
        res.end(text)
        return
      }
    }
    const out: Record<string, string> = {}
    for (const h of PASS_RESPONSE_HEADERS) { const v = up.headers.get(h); if (v) out[h] = v }
    res.writeHead(up.status, out)
    if (!up.body) { res.end(); return }
    const stream = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream)
    // 头已发出:上游半路断开 = destroy(end 会把截断的流伪装成完整响应)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 鉴权靠口令(不是 cookie),所以跨源放开无妨:渲染层的源在开发 / 安装版 / 卫星窗各不相同
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        'Access-Control-Max-Age': '600',
      })
      res.end()
      return
    }
    // 口令只对「发给它的那个账号」有效:没发过 / 账号已经换了 → 一律 401(即便字节对得上)
    const account = deps.account()
    const given = Buffer.from(String(req.headers.authorization || ''))
    const want = Buffer.from(`Bearer ${issued?.secret ?? ''}`)
    if (!account || !issued || issued.account !== account || given.length !== want.length || !timingSafeEqual(given, want)) {
      json(res, 401, { code: 'RELAY_UNAUTHORIZED', detail: 'relay token required' })
      return
    }
    // 原样判 req.url(Node 不做规范化):`..`、编码斜杠之类在语法检查里现形,不会先被解析器抹掉
    const m = /^\/units\/([^/]+)\/proxy(\/.*)$/.exec(req.url || '')
    const unitId = m?.[1] ?? ''
    const path = m?.[2] ?? ''
    const caller = !!m && checkRelayPath(path)
    const surface = !!m && !caller && req.method === 'GET' && checkUnitSurfacePath(path)
    if (!m || !UNIT_UUID_RE.test(unitId) || (!caller && !surface)) { json(res, 404, { code: 'RELAY_PATH', detail: 'not a relay path' }); return }
    forward(req, res, unitId, path, caller, account).catch((e: unknown) => {
      if (res.headersSent) { res.destroy(); return }
      if (e instanceof RelayError) json(res, e.status, { code: e.code, detail: e.message })
      else json(res, 502, { code: 'RELAY_UPSTREAM', detail: (e as Error)?.message || 'upstream failed' })
    })
  }

  return {
    open: async () => {
      const base = await (opening ??= new Promise<string>((resolve, reject) => {
        const s = http.createServer(handle)
        s.once('error', (e) => { opening = null; reject(e) })
        s.listen(0, '127.0.0.1', () => {
          server = s
          resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)
        })
      }))
      const account = deps.account()
      if (!account) { issued = null; return null }
      if (issued?.account !== account) issued = { account, secret: randomBytes(32).toString('hex') }
      return { base, token: issued.secret }
    },
    close: async () => {
      const s = server
      server = null
      opening = null
      if (!s) return
      s.closeAllConnections?.()
      await new Promise<void>((r) => s.close(() => r()))
    },
  }
}
