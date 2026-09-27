/**
 * Unit host(扶桑根设备侧):把本机 Forsion 变成账号名下的一个可远程 attach 的 Unit。
 *
 * 通道方向恒为**出站**(NAT 友好):长挂 GET {cloud}/api/units/:id/channel(SSE)收派发信封,
 * 转发给本机 managed 引擎;**小的一次性响应**走 POST resp(整包),event-stream 与大响应
 * (附件/图片/PDF,或长度未知)边收边 POST stream 回传 —— 判据见 streamWorthy。
 * 方案:docs/ToBeImproved/Forsion-Unit扶桑根_多设备统一架构方案_2026-08-23.md §4.2。
 *
 * 安全:剥掉信封外的一切身份声明,给本机引擎盖**本机 token**(env 快照同源);服务端已做
 * owner 校验(同账号)——设备只信自己拨出的这条通道,绝不复用 thin worker 的受信头模型。
 *
 * 在线真实性(设备能力 MCP 方案 §3.2 / P0 ⑦):网关每 15s 往通道写 `: hb`,设备侧**读看门狗** 45s 收不到
 * 任何字节就判通道已死、断开重连(合盖 / 换网后的 TCP 半开连接不会自己报错,不看门狗就是「假在线」);
 * 系统唤醒(powerMonitor resume)时主进程调 reconnect() 立即重拨。每个在飞信封一个 AbortController,
 * 可按信封 id 中止(abortEnvelope,留给网关的 cancel 帧);通道拆除时全部中止 —— 网关那头对未认领的派发
 * 已经 502(failPending),本机没必要替一个没人收的回包继续跑。
 */
import { hostname } from 'node:os'

/** 整包缓冲的上限。超过它(或长度未知)的响应改走流式回包 —— 缓冲路是「设备 base64 → JSON body →
 *  网关整包 parse 回 Buffer」,峰值内存约响应体的 3 倍且随并发线性叠(2026-08-25)。
 *  留着缓冲路是为了小响应的 Content-Length(流式是 chunked,没长度);实测 unitWeb 的 JSON/静态
 *  资产都带 content-length,所以这条判据是真分流,不是「全都走流式」的遮羞布。 */
const MAX_BUFFERED_BODY = 256 * 1024

/**
 * 这个响应该不该走流式回包。
 * ⚠️ `headers.get()` 缺头返回 **null**,而 `Number(null) === 0` —— 直接 Number() 会把「长度未知」
 *    判成 0 字节 = 走缓冲,再对无界 chunked 体 arrayBuffer() 就是挂死。必须 `|| NaN` 兜。
 * event-stream 单列一条不是冗余:万一哪天引擎给 SSE 盖上 content-length,单靠长度判据会把它
 * 送进缓冲路等一个永不结束的 body。
 *
 * ⚠️ `hasSecHeaders && !gatewayStreamsSecHeaders` → **一律退回缓冲路**。两仓不是原子升级的:
 *    新桌面遇到老网关(或 server 回滚),老网关的 /stream 面不认 ?csp=/?xcto= → 附件的
 *    CSP sandbox 被静默剥掉,HTML/SVG 就在鉴权过的 proxy origin 上活着执行(Codex 六轮 P1)。
 *    代价是这种组合下附件退回旧的整包缓冲(= 改版前行为,不是回归);网关一宣告能力就自动恢复。
 *    ⚠️ 别以为这是罕见分支:/vault/asset **每个附件**都盖 nosniff(非 PDF 还加 sandbox),
 *    而且 createReadStream 直 pipe 不报长度 —— 附件正是这条判据的主战场。
 */
export function streamWorthy(
  contentType: string,
  contentLength: string | null,
  opts?: { hasSecHeaders?: boolean; gatewayStreamsSecHeaders?: boolean },
): boolean {
  if (opts?.hasSecHeaders && !opts.gatewayStreamsSecHeaders) return false
  if (contentType.includes('text/event-stream')) return true
  const len = Number(contentLength || NaN)
  return !Number.isFinite(len) || len > MAX_BUFFERED_BODY
}

export interface UnitPairing { unitId: string; secret: string }

export interface UnitHostDeps {
  /** 云端地址 + 当前 forsion_token(每次连接现读,续期自然生效)。 */
  getCreds: () => { cloudUrl: string; token: string }
  /** 本机 unitWeb 服务(v2:一个目标吃全部——页面资产/引擎反代/配对);
   *  internalSecret 走「loopback + 内部密钥头」豁免 unitWeb 鉴权(server 已验 owner)。null=web 未起。 */
  getUnitWeb: () => { url: string | null; internalSecret: string }
  /** 上报给名册的本机局域网直连地址(随通道自报,IP/端口会漂)。 */
  getLanUrl: () => string | null
  /** 已配对凭据(shell 配置);null = 未入册。 */
  getPairing: () => UnitPairing | null
  savePairing: (p: UnitPairing) => Promise<void>
  clearPairing: () => Promise<void>
  log: (msg: string) => void
  /** 通道读看门狗:这么久一个字节都没收到(网关 15s 一次心跳)就断开重连。缺省 45_000;0 = 关(只给测试用)。 */
  readIdleMs?: number
}

/** 缺省读看门狗:网关心跳 15s × 3。 */
const CHANNEL_READ_IDLE_MS = 45_000

export interface UnitHostStatus {
  running: boolean
  connected: boolean
  unitId: string | null
  lastError: string | null
}

interface Envelope { id: string; method: string; path: string; ct?: string; accept?: string; body: string | null }

const apiBase = (cloudUrl: string): string => `${cloudUrl.replace(/\/+$/, '')}/api`

export class UnitHost {
  private deps: UnitHostDeps
  /** 主循环的开关(stop() 才 abort 它)。 */
  private ctrl: AbortController | null = null
  /** 当前这一条通道连接:看门狗 / reconnect() 只断它,主循环照转、立即重拨。 */
  private conn: AbortController | null = null
  /** 退避等待的唤醒器 + 「跳过下一次退避」标记(reconnect() 用)。 */
  private wake: (() => void) | null = null
  private redialNow = false
  /** 在飞信封:dispatch id → 本机 fetch(含流式回传)的中止器 + 它是从哪条通道连接收下的。 */
  private inflight = new Map<string, { ctrl: AbortController; conn: AbortController }>()
  private connected = false
  private lastError: string | null = null
  /** 本次通道上网关宣告的能力(event: ready)。⚠️ 每次连接前清空 —— 重连可能落到**回滚后的老网关**上,
   *  留着上一条通道的 caps 就等于认了它不具备的能力(附件安全头会被静默剥掉)。 */
  private hubCaps = new Set<string>()

  constructor(deps: UnitHostDeps) {
    this.deps = deps
  }

  status(): UnitHostStatus {
    return {
      running: !!this.ctrl,
      connected: this.connected,
      unitId: this.deps.getPairing()?.unitId ?? null,
      lastError: this.lastError,
    }
  }

  start(): void {
    if (this.ctrl) return
    const ctrl = new AbortController()
    this.ctrl = ctrl
    void this.loop(ctrl)
  }

  stop(): void {
    this.ctrl?.abort()
    this.ctrl = null
    this.connected = false
    this.abortEnvelopes()
    this.wake?.()
  }

  /** 立即重拨通道(系统唤醒后调用):断掉当前连接(可能是合盖留下的半开连接)、跳过退避。未运行时无操作。 */
  reconnect(reason: string): void {
    if (!this.ctrl) return
    this.deps.log(`[unit-host] 立即重连通道(${reason})`)
    this.redialNow = true
    this.conn?.abort()
    this.wake?.()
  }

  /** 按信封 id 中止在飞的本机请求(含流式回传)。true = 找到并中止;false = 不在飞(已完成 / 未知 id)。 */
  abortEnvelope(id: string): boolean {
    const e = this.inflight.get(id)
    if (!e) return false
    this.inflight.delete(id)
    e.ctrl.abort()
    return true
  }

  /** 中止在飞信封:给了 conn 只中止那条连接收下的(通道拆除),不给 = 全部(stop)。 */
  private abortEnvelopes(conn?: AbortController): void {
    for (const [id, e] of [...this.inflight]) {
      if (conn && e.conn !== conn) continue
      this.inflight.delete(id)
      e.ctrl.abort()
    }
  }

  /** 可被 reconnect() / stop() 提前唤醒的退避等待。 */
  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(done, ms)
      function done(): void { clearTimeout(t); r() }
      this.wake = () => { this.wake = null; done() }
    })
  }

  /** 连接主循环:注册(如需)→ 长挂通道 → 断线指数退避重连,stop() 即退出。 */
  private async loop(ctrl: AbortController): Promise<void> {
    let backoff = 1000
    while (!ctrl.signal.aborted) {
      const conn = new AbortController()
      const onStop = (): void => conn.abort()
      ctrl.signal.addEventListener('abort', onStop, { once: true })
      this.conn = conn
      try {
        const { cloudUrl, token } = this.deps.getCreds()
        if (!token) throw new Error('未登录 Forsion 账号')
        let pairing = this.deps.getPairing()
        if (!pairing) {
          pairing = await this.register(cloudUrl, token, conn.signal)
          // 入册在途时被 stop()(停用 / 换账号):这份配对属于旧的那一轮,绝不写回(Codex 评审 P1)
          if (conn.signal.aborted) throw new Error('入册期间通道已被停用')
          await this.deps.savePairing(pairing)
          this.deps.log(`[unit-host] 已入册为设备 ${pairing.unitId}`)
        }
        const lanUrl = this.deps.getLanUrl()
        this.hubCaps = new Set() // 每条通道各自协商:重连可能换成回滚后的老网关
        // 看门狗从发起连接就开始计:TCP 连上而网关迟迟不回响应头,同样算死连接(Codex 评审 P1)。
        const idleMs = this.deps.readIdleMs ?? CHANNEL_READ_IDLE_MS
        const headerWatchdog = idleMs ? setTimeout(() => {
          this.deps.log(`[unit-host] 通道 ${Math.round(idleMs / 1000)}s 未收到响应头,判定已断,重连`)
          conn.abort()
        }, idleMs) : null
        let resp: Response
        try {
          resp = await fetch(`${apiBase(cloudUrl)}/units/${pairing.unitId}/channel`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Unit-Secret': pairing.secret,
              ...(lanUrl ? { 'X-Unit-Lan-Url': lanUrl } : {}),
            },
            signal: conn.signal,
          })
        } finally {
          if (headerWatchdog) clearTimeout(headerWatchdog)
        }
        if (resp.status === 403 || resp.status === 404) {
          // 设备行已被注销/密钥失配 → 清配对,下一轮重新入册(自愈)。
          await this.deps.clearPairing()
          throw new Error(`通道被拒(${resp.status}),已清除配对待重新入册`)
        }
        if (!resp.ok || !resp.body) throw new Error(`channel HTTP ${resp.status}`)
        this.connected = true
        this.lastError = null
        backoff = 1000
        this.deps.log('[unit-host] 通道已连接')
        await this.consume(resp.body, conn)
        this.connected = false
        this.deps.log('[unit-host] 通道断开,准备重连')
      } catch (e: any) {
        this.connected = false
        if (ctrl.signal.aborted) return
        this.lastError = conn.signal.aborted ? '通道被本机断开(看门狗 / 重连)' : String(e?.message || e)
        this.deps.log(`[unit-host] ${this.lastError};${this.redialNow ? '立即' : `${Math.round(backoff / 1000)}s 后`}重试`)
      } finally {
        ctrl.signal.removeEventListener('abort', onStop)
        if (this.conn === conn) this.conn = null
        conn.abort()
        this.abortEnvelopes(conn) // 通道拆除:这条连接上收下的在飞信封全部中止(网关已对未认领派发回 502)
      }
      if (ctrl.signal.aborted) return
      if (this.redialNow) {
        this.redialNow = false
        backoff = 1000
        continue
      }
      await this.sleep(backoff)
      if (this.redialNow) { this.redialNow = false; backoff = 1000; continue }
      backoff = Math.min(backoff * 2, 30_000)
    }
  }

  private async register(cloudUrl: string, token: string, signal: AbortSignal): Promise<UnitPairing> {
    const r = await fetch(`${apiBase(cloudUrl)}/units/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: hostname(), platform: process.platform }),
      signal,
    })
    if (!r.ok) throw new Error(`设备入册失败 HTTP ${r.status}`)
    const j = (await r.json()) as { unitId?: string; secret?: string }
    if (!j.unitId || !j.secret) throw new Error('设备入册响应缺字段')
    return { unitId: j.unitId, secret: j.secret }
  }

  /** 解析通道 SSE,逐信封派活(信封间互不阻塞)。读看门狗:readIdleMs 内一个字节都没有 → 断开本条连接。 */
  private async consume(body: ReadableStream<Uint8Array>, conn: AbortController): Promise<void> {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const idleMs = this.deps.readIdleMs ?? CHANNEL_READ_IDLE_MS
    let idle: ReturnType<typeof setTimeout> | null = null
    const arm = (): void => {
      if (!idleMs) return
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => {
        this.deps.log(`[unit-host] 通道 ${Math.round(idleMs / 1000)}s 无任何字节(网关 15s 一次心跳),判定已断,重连`)
        conn.abort()
        void reader.cancel().catch(() => {})
      }, idleMs)
    }
    arm()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || conn.signal.aborted) return
        arm()
        buf = this.parseFrames(buf + dec.decode(value, { stream: true }), conn)
      }
    } finally {
      if (idle) clearTimeout(idle)
    }
  }

  /** 从累积缓冲里切出完整的 SSE 块逐个处理,返回最后一个 `\n\n` 之后的残段(留作下一轮)。 */
  private parseFrames(input: string, conn: AbortController): string {
    let buf = input
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      // 网关能力宣告(首帧)。**老网关不发这帧 → caps 保持空 = 保守档**,见 streamWorthy。
      if (block.includes('event: ready')) {
        const d = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6)
        try {
          const caps = (JSON.parse(d || '{}') as { caps?: unknown }).caps
          this.hubCaps = new Set(Array.isArray(caps) ? caps.map(String) : [])
        } catch { this.hubCaps = new Set() }
        continue
      }
      if (!block.includes('event: dispatch')) continue
      const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6)
      if (!data) continue
      try {
        const env = JSON.parse(data) as Envelope
        void this.dispatch(env, conn).catch((e) => this.deps.log(`[unit-host] 派发处理失败: ${e?.message || e}`))
      } catch { /* 坏帧丢弃 */ }
    }
    return buf
  }

  /** 在飞登记:每个信封一个中止器,处理完(成功 / 失败 / 被中止)即摘除。 */
  private async dispatch(env: Envelope, conn: AbortController): Promise<void> {
    const ctrl = new AbortController()
    if (conn.signal.aborted) return // 这条连接已拆:网关不会再收这份回包
    this.inflight.get(env.id)?.ctrl.abort() // 同 id 重投:旧的那份作废(网关 id 是 UUID,正常不会撞)
    const entry = { ctrl, conn }
    this.inflight.set(env.id, entry)
    try {
      await this.handle(env, ctrl)
    } finally {
      if (this.inflight.get(env.id) === entry) this.inflight.delete(env.id)
    }
  }

  /** v2(B 端渲染):整个信封转发本机 unitWeb —— 页面资产/引擎反代/插件清单一个目标吃全部。
   *  「loopback + per-boot 内部密钥头」= server 已验 owner 的隧道豁免(见 unitWeb.authed)。
   *  ctrl = 本信封自己的中止器(abortEnvelope / 通道拆除 / stop)。 */
  private async handle(env: Envelope, ctrl: AbortController): Promise<void> {
    const web = this.deps.getUnitWeb()
    if (!web.url) {
      await this.respond(env.id, 503, 'application/json', Buffer.from(JSON.stringify({ detail: '本机互联服务未就绪', code: 'UNIT_WEB_NOT_READY' })))
      return
    }
    const headers: Record<string, string> = { 'x-unit-internal': web.internalSecret }
    if (env.ct) headers['Content-Type'] = env.ct
    if (env.accept) headers.Accept = env.accept
    let r: Response
    try {
      r = await fetch(`${web.url}${env.path}`, {
        method: env.method,
        headers,
        body: env.body ?? undefined,
        signal: ctrl.signal,
      })
    } catch (e: any) {
      if (ctrl.signal.aborted) return // 被本机中止(通道拆除 / abortEnvelope):网关那头已不等这份回包
      await this.respond(env.id, 502, 'application/json', Buffer.from(JSON.stringify({ detail: `本机互联服务不可达: ${e?.message || e}` })))
      return
    }
    const ct = r.headers.get('content-type') || ''
    // 安全头白名单:/vault/asset 用 CSP sandbox 惰化不受信附件——隧道剥掉它,HTML 附件就会在
    // 鉴权过的 proxy origin 上活着执行(Codex 二轮 P1)。两条回包路都必须原样带回。
    const extra: Record<string, string> = {}
    for (const k of ['content-security-policy', 'x-content-type-options'] as const) {
      const v = r.headers.get(k)
      if (v) extra[k] = v
    }
    // 缺 Content-Type 的兜底两条路必须一致,且**不能猜**:streamBack 原本只服务 SSE,默认写死
    // 'text/event-stream' —— 普通 chunked 响应挪进来会被当成事件流(浏览器渲染与客户端解析都变样)。
    // octet-stream 是唯一安全的未知标签(不嗅探、不执行、不按流处理)。
    const effCt = ct || 'application/octet-stream'
    const stream = r.body && streamWorthy(ct, r.headers.get('content-length'), {
      hasSecHeaders: Object.keys(extra).length > 0,
      gatewayStreamsSecHeaders: this.hubCaps.has('stream-sec-headers'),
    })
    if (stream) {
      await this.streamBack(env.id, r, ctrl, effCt, extra)
    } else {
      await this.respond(env.id, r.status, effCt, Buffer.from(await r.arrayBuffer()), extra)
    }
  }

  private async respond(dispatchId: string, status: number, ct: string, body: Buffer, extraHeaders?: Record<string, string>): Promise<void> {
    const { cloudUrl, token } = this.deps.getCreds()
    const pairing = this.deps.getPairing()
    if (!pairing) return
    await fetch(`${apiBase(cloudUrl)}/units/${pairing.unitId}/resp/${dispatchId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Unit-Secret': pairing.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, headers: { 'content-type': ct, ...extraHeaders }, bodyB64: body.toString('base64') }),
    }).catch((e) => this.deps.log(`[unit-host] 回包失败: ${e?.message || e}`))
  }

  /** 边收边回传(event-stream 与一切大响应);上行失败(客户端已断)→ 中止本机引擎读取。 */
  private async streamBack(dispatchId: string, engineResp: Response, ctrl: AbortController, ct: string, extraHeaders?: Record<string, string>): Promise<void> {
    const { cloudUrl, token } = this.deps.getCreds()
    const pairing = this.deps.getPairing()
    if (!pairing) return
    // 安全头走 query(网关那边名单是结构性的,只认这两枚)。
    const csp = extraHeaders?.['content-security-policy']
    const xcto = extraHeaders?.['x-content-type-options']
    const url = `${apiBase(cloudUrl)}/units/${pairing.unitId}/stream/${dispatchId}?status=${engineResp.status}&ct=${encodeURIComponent(ct)}`
      + (csp ? `&csp=${encodeURIComponent(csp)}` : '')
      + (xcto ? `&xcto=${encodeURIComponent(xcto)}` : '')
    try {
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Unit-Secret': pairing.secret, 'Content-Type': 'application/octet-stream' },
        body: engineResp.body,
        signal: ctrl.signal,
        duplex: 'half',
      } as RequestInit)
    } catch (e: any) {
      this.deps.log(`[unit-host] 流式回传中断: ${e?.message || e}`)
      try { await engineResp.body?.cancel() } catch { /* 已断 */ }
    }
  }
}
