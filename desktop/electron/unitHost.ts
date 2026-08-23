/**
 * Unit host(扶桑根设备侧):把本机 Forsion 变成账号名下的一个可远程 attach 的 Unit。
 *
 * 通道方向恒为**出站**(NAT 友好):长挂 GET {cloud}/api/units/:id/channel(SSE)收派发信封,
 * 转发给本机 managed 引擎;一次性响应走 POST resp,event-stream 响应边收边 POST stream 回传。
 * 方案:docs/ToBeImproved/Forsion-Unit扶桑根_多设备统一架构方案_2026-08-23.md §4.2。
 *
 * 安全:剥掉信封外的一切身份声明,给本机引擎盖**本机 token**(env 快照同源);服务端已做
 * owner 校验(同账号)——设备只信自己拨出的这条通道,绝不复用 thin worker 的受信头模型。
 */
import { hostname } from 'node:os'

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
}

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
  private ctrl: AbortController | null = null
  private connected = false
  private lastError: string | null = null

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
  }

  /** 连接主循环:注册(如需)→ 长挂通道 → 断线指数退避重连,stop() 即退出。 */
  private async loop(ctrl: AbortController): Promise<void> {
    let backoff = 1000
    while (!ctrl.signal.aborted) {
      try {
        const { cloudUrl, token } = this.deps.getCreds()
        if (!token) throw new Error('未登录 Forsion 账号')
        let pairing = this.deps.getPairing()
        if (!pairing) {
          pairing = await this.register(cloudUrl, token)
          await this.deps.savePairing(pairing)
          this.deps.log(`[unit-host] 已入册为设备 ${pairing.unitId}`)
        }
        const lanUrl = this.deps.getLanUrl()
        const resp = await fetch(`${apiBase(cloudUrl)}/units/${pairing.unitId}/channel`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Unit-Secret': pairing.secret,
            ...(lanUrl ? { 'X-Unit-Lan-Url': lanUrl } : {}),
          },
          signal: ctrl.signal,
        })
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
        await this.consume(resp.body, ctrl)
        this.connected = false
        this.deps.log('[unit-host] 通道断开,准备重连')
      } catch (e: any) {
        this.connected = false
        if (ctrl.signal.aborted) return
        this.lastError = String(e?.message || e)
        this.deps.log(`[unit-host] ${this.lastError};${Math.round(backoff / 1000)}s 后重试`)
      }
      if (ctrl.signal.aborted) return
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 30_000)
    }
  }

  private async register(cloudUrl: string, token: string): Promise<UnitPairing> {
    const r = await fetch(`${apiBase(cloudUrl)}/units/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: hostname(), platform: process.platform }),
    })
    if (!r.ok) throw new Error(`设备入册失败 HTTP ${r.status}`)
    const j = (await r.json()) as { unitId?: string; secret?: string }
    if (!j.unitId || !j.secret) throw new Error('设备入册响应缺字段')
    return { unitId: j.unitId, secret: j.secret }
  }

  /** 解析通道 SSE,逐信封派活(信封间互不阻塞)。 */
  private async consume(body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<void> {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done || ctrl.signal.aborted) return
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (!block.includes('event: dispatch')) continue
        const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6)
        if (!data) continue
        try {
          const env = JSON.parse(data) as Envelope
          void this.handle(env, ctrl).catch((e) => this.deps.log(`[unit-host] 派发处理失败: ${e?.message || e}`))
        } catch { /* 坏帧丢弃 */ }
      }
    }
  }

  /** v2(B 端渲染):整个信封转发本机 unitWeb —— 页面资产/引擎反代/插件清单一个目标吃全部。
   *  「loopback + per-boot 内部密钥头」= server 已验 owner 的隧道豁免(见 unitWeb.authed)。 */
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
      await this.respond(env.id, 502, 'application/json', Buffer.from(JSON.stringify({ detail: `本机互联服务不可达: ${e?.message || e}` })))
      return
    }
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('text/event-stream') && r.body) {
      await this.streamBack(env.id, r, ctrl)
    } else {
      const buf = Buffer.from(await r.arrayBuffer())
      await this.respond(env.id, r.status, ct || 'application/json', buf)
    }
  }

  private async respond(dispatchId: string, status: number, ct: string, body: Buffer): Promise<void> {
    const { cloudUrl, token } = this.deps.getCreds()
    const pairing = this.deps.getPairing()
    if (!pairing) return
    await fetch(`${apiBase(cloudUrl)}/units/${pairing.unitId}/resp/${dispatchId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Unit-Secret': pairing.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, headers: { 'content-type': ct }, bodyB64: body.toString('base64') }),
    }).catch((e) => this.deps.log(`[unit-host] 回包失败: ${e?.message || e}`))
  }

  /** event-stream 边收边回传;上行失败(客户端已断)→ 中止本机引擎读取。 */
  private async streamBack(dispatchId: string, engineResp: Response, ctrl: AbortController): Promise<void> {
    const { cloudUrl, token } = this.deps.getCreds()
    const pairing = this.deps.getPairing()
    if (!pairing) return
    const ct = engineResp.headers.get('content-type') || 'text/event-stream'
    const url = `${apiBase(cloudUrl)}/units/${pairing.unitId}/stream/${dispatchId}?status=${engineResp.status}&ct=${encodeURIComponent(ct)}`
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
