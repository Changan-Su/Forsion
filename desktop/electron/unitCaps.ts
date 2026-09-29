/**
 * 桌面 caps 上报器(P1 · K7a,规格 K7 §3.10;归属 INTEGRATION R-30)。
 *
 * 为什么要它:server 早就收 `POST /api/units/:id/caps {engine, tools}`(P0 ⑧,双闸 forsion_token + X-Unit-Secret,
 * 且必须在这条通道 `event: ready` 之后到 —— 绑在这条连接上,名册的 capsLive 才为真),但桌面从没报过 → 名册的 caps
 * 恒为 null,手机分不出「电脑在线但引擎没起」与「电脑在线、可以用」。本模块在通道 ready 之后报一次引擎态,之后引擎态
 * 变了(起停 / 崩溃 / 项目根种子做完)再报;通道断了就停、忘掉上次报的值(重连后名册的 capsLive 归零,须重报)。
 *
 * 线格式:`POST {cloud}/api/units/{unitId}/caps`,头 `Authorization: Bearer <forsion_token>` + `X-Unit-Secret` +
 * `Content-Type: application/json`,体 `{"engine":"ready","tools":[]}`(tools 到 P2 / P3 才有内容)。
 * 处置:404 / 405(老网关没有这条路由)→ 本条连接内不再报;400 / 401 / 403 → 记一次日志;其余失败 → 记日志,等下一次变化 /
 * 重连再报。**永不向通道主循环抛错**(所有入口都是同步的 void,内部自吞)。
 *
 * caps 是设备**自报**的快照:只驱动手机上的提示文案,永不作授权依据(真正的拒绝恒是 HTTP 码)。
 */

export type EngineCapsState = 'ready' | 'starting' | 'external' | 'stopped'

/** 引擎态 → caps.engine。seeded = 本机项目根种子做完(没做完之前 unitWeb 对远端回 503 ENGINE_NOT_READY,手机上应显示「在启动」)。 */
export function engineCapsState(i: { agentBackend: boolean; backend: 'stopped' | 'starting' | 'ready' | 'crashed'; seeded: boolean }): EngineCapsState {
  if (!i.agentBackend) return 'external'
  if (i.backend === 'ready') return i.seeded ? 'ready' : 'starting'
  if (i.backend === 'starting') return 'starting'
  return 'stopped'
}

export interface UnitCapsDeps {
  /** 云端地址(不含 /api)+ 当前 forsion_token(每次现读)。 */
  getCreds(): { cloudUrl: string; token: string }
  /** 设备配对(unitId + 设备密钥);null = 未入册 → 不报。 */
  getPairing(): { unitId: string; secret: string } | null
  /** 此刻的引擎态(每次现算)。 */
  current(): EngineCapsState
  /** 打云端网关用的 fetch(测试注入;缺省全局 fetch)。 */
  hubFetch?: typeof fetch
  log(m: string): void
  /** 单次上报的时限;缺省 10s。 */
  timeoutMs?: number
  /** engineChanged 的去抖;缺省 500ms(backend.onStatus 起停时会连发几次)。 */
  debounceMs?: number
}

export class UnitCapsReporter {
  private readonly d: UnitCapsDeps
  /** 这条通道已 ready(报得进去)。 */
  private up = false
  /** 连接代:channelDown / channelReady 递增,在飞的上报回来时代不对就作废(不把旧连接的结果记成本连接的)。 */
  private gen = 0
  /** 本连接已成功报过的值(null = 还没报过 / 上次失败)。 */
  private lastSent: EngineCapsState | null = null
  /** 老网关(404 / 405):本连接内不再报。 */
  private disabled = false
  private inflight = false
  /** 在飞时又来了变化:回来后再核一次。 */
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 400 / 401 / 403 只记一次(按状态码)。 */
  private readonly warned = new Set<number>()

  constructor(d: UnitCapsDeps) {
    this.d = d
  }

  /** UnitHost 在通道 `event: ready` 之后调:本连接从头报一次当前引擎态。 */
  channelReady(): void {
    this.gen++
    this.up = true
    this.lastSent = null
    this.disabled = false
    this.clearTimer()
    this.again = false
    void this.flush()
  }

  /** 通道断了:停报、忘掉上次的值(名册那侧 capsLive 已随连接归零,重连后必须重报)。 */
  channelDown(): void {
    this.gen++
    this.up = false
    this.lastSent = null
    this.again = false
    this.clearTimer()
  }

  /** 引擎态可能变了(backend.onStatus / 项目根种子做完):去抖后与上次报的值比,变了才报。通道没 ready 时什么都不做。 */
  engineChanged(): void {
    if (!this.up || this.disabled) return
    this.clearTimer()
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, this.d.debounceMs ?? 500)
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private async flush(): Promise<void> {
    if (!this.up || this.disabled) return
    if (this.inflight) { this.again = true; return }
    let value: EngineCapsState
    try { value = this.d.current() } catch (e: any) { this.d.log(`[unit-caps] 读引擎态失败:${e?.message || e}`); return }
    if (value === this.lastSent) return
    const pairing = this.d.getPairing()
    let creds: { cloudUrl: string; token: string }
    try { creds = this.d.getCreds() } catch { return }
    if (!pairing || !creds.token || !creds.cloudUrl) return
    const gen = this.gen
    this.inflight = true
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.d.timeoutMs ?? 10_000)
    try {
      const url = `${creds.cloudUrl.replace(/\/+$/, '')}/api/units/${encodeURIComponent(pairing.unitId)}/caps`
      const r = await (this.d.hubFetch ?? fetch)(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.token}`, 'X-Unit-Secret': pairing.secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: value, tools: [] }),
        signal: ctrl.signal,
      })
      try { await r.text() } catch { /* 体不要 */ }
      if (gen !== this.gen) return
      if (r.ok) {
        this.lastSent = value
        this.d.log(`[unit-caps] 已上报引擎态 ${value}`)
      } else if (r.status === 404 || r.status === 405) {
        this.disabled = true
        this.d.log(`[unit-caps] 网关不收 caps(HTTP ${r.status},老版本),本连接内不再上报`)
      } else if (r.status === 400 || r.status === 401 || r.status === 403) {
        if (!this.warned.has(r.status)) { this.warned.add(r.status); this.d.log(`[unit-caps] 上报被拒 HTTP ${r.status}`) }
      } else {
        this.d.log(`[unit-caps] 上报失败 HTTP ${r.status},等下次变化 / 重连再报`)
      }
    } catch (e: any) {
      if (gen === this.gen) this.d.log(`[unit-caps] 上报失败:${ctrl.signal.aborted ? '超时' : e?.message || e}`)
    } finally {
      clearTimeout(timer)
      this.inflight = false
      // 在飞期间引擎态又变了(或换了连接,新连接的 channelReady 碰上了在飞):回来再核一次
      if (this.again && this.up && !this.disabled) { this.again = false; void this.flush() }
    }
  }
}
