/**
 * 执行设备不在前台时的审批送达(设备能力 MCP 方案 P1 · K3 §3.5):主进程订阅本机引擎的待批流,
 * **远程来源** run 的审批 / 询问弹系统通知(点击 → 打开那条会话),对方先答 → 关通知;60s 没人答 → 经 unit-hub 给本人投一封收件箱信
 * (手机下次拉收件箱时看得到、可一键打开会话)。
 *
 * 为什么在主进程:渲染层只知道**自己订阅着**的 run 的待批(appStore.messagesBySession),手机驱动的远程 run 桌面窗口根本没开;
 * 引擎今天也只有按 run 的事件流 —— 待批的全局视图是引擎侧的 pendingPromptIndex,出口 GET /agent/approvals/stream(本机专用)。
 *
 * 边界:
 *   - 只管远程 run(item.remote 非空);本机 run 由渲染层托盘负责(它订阅着)。
 *   - 通知**不含命令 / 参数 / preview**(锁屏可见;截断的命令会骗人批准),也**不放任何按钮**(K3 U1:点一下就到完整审批卡)。
 *   - 投收件箱只带会话 id 与计数(方案 §6.7:远程会话内容只存执行设备本机),服务端限频之外本端再按会话冷却 10 分钟。
 *   - 外部模式 / 引擎未就绪:停在 idle(远程会话本就只在托管模式可用)。
 *
 * 连接状态机:idle —(引擎 ready)→ connecting → streaming —(错误 / 读空闲 45s / 引擎非 ready)→ backoff(1s→2s→…→30s,
 * 拿到 snapshot 即清零)→ connecting;stop() 或引擎非 ready → idle(关掉所有通知:引擎一停,待批全失效)。
 * 404 = 引擎不认这条路由(老引擎)→ 本次引擎寿命内不再试,直到引擎状态再次变化。
 *
 * 文案一律 mt('main.approvalDelivery.*')(K5,调用时求值,跟随界面语言)。
 */
import { defineMainMessages } from './mainI18n'

export const APPROVAL_DELIVERY_MESSAGES = defineMainMessages({
  'main.approvalDelivery.approvalTitle': { zh: '{device} 上的远程会话等你批准', en: 'Remote session from {device} needs your approval' },
  'main.approvalDelivery.approvalTitleDevice': { zh: '已登记设备上的远程会话等你批准', en: 'A remote session from a registered device needs your approval' },
  'main.approvalDelivery.approvalTitleUnknown': { zh: '远程会话等你批准', en: 'A remote session needs your approval' },
  'main.approvalDelivery.inquiryTitle': { zh: '{device} 上的远程会话在问你', en: 'Remote session from {device} has a question for you' },
  'main.approvalDelivery.inquiryTitleDevice': { zh: '已登记设备上的远程会话在问你', en: 'A remote session from a registered device has a question for you' },
  'main.approvalDelivery.inquiryTitleUnknown': { zh: '远程会话在问你', en: 'A remote session has a question for you' },
  'main.approvalDelivery.approvalBody': { zh: '「{session}」请求使用 {tool}。点击查看。', en: '“{session}” wants to use {tool}. Click to review.' },
  'main.approvalDelivery.inquiryBody': { zh: '「{session}」在等你回答。点击查看。', en: '“{session}” is waiting for your answer. Click to review.' },
  'main.approvalDelivery.bodyMany': { zh: '「{session}」有 {n} 项等你处理。点击查看。', en: '“{session}” has {n} items waiting for you. Click to review.' },
  'main.approvalDelivery.untitled': { zh: '未命名会话', en: 'Untitled session' },
})

/** 引擎 /agent/approvals/stream 的条目(与 tangu-agent routes/approvals.ts wireOf 同形):不含 preview / 参数。 */
export interface PendingPromptWire {
  id: string
  kind: 'approval' | 'inquiry' | 'plan'
  runId: string
  sessionId: string
  sessionTitle: string | null
  tool: string | null
  localOnly: boolean
  remote: { via?: string; callerUnit?: string; callerKind?: string; callerName?: string } | null
  createdAt: string
}

export interface NotificationHandle { close(): void; onClick(cb: () => void): void }

export interface ApprovalDeliveryDeps {
  /** backend.getStatus().url(仅 ready,否则 null)+ backend.getToken()(本机令牌)。 */
  getEngine(): { url: string | null; token: string }
  /** backend.onStatus 的二值化:ready ↔ 非 ready。返回退订。 */
  onEngineStatus(cb: (ready: boolean) => void): () => void
  /** 本机设备凭据;未入册 / 通道未连 → null(不投收件箱)。 */
  unitCreds(): { cloudUrl: string; token: string; unitId: string; secret: string } | null
  /** 主进程 i18n(K5 的 mt)。 */
  t(key: string, vars?: Record<string, string | number>): string
  /** Electron Notification 包装;不支持 → null。 */
  notify(o: { title: string; body: string }): NotificationHandle | null
  /** showMainWindow + send('approval:open', { sessionId })。 */
  openSession(sessionId: string): void
  log(msg: string): void
  fetch?: typeof fetch
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (h: unknown) => void
}

export interface ApprovalDelivery {
  start(): void
  stop(): void
  /** 当前流里的全部条目(含本机 run 的;测试钩子 / 调试用)。 */
  pending(): PendingPromptWire[]
}

/** 远程待批多久没人答就投收件箱。 */
export const ESCALATE_AFTER_MS = 60_000
/** 同一会话两次投递的最小间隔。 */
export const ESCALATE_COOLDOWN_MS = 10 * 60_000
/** 同一会话两次弹通知的最小间隔(Electron 不能原地改通知正文,每次都是关旧弹新 —— 太频繁就是骚扰)。 */
export const RENOTIFY_AFTER_MS = 30_000
/** 读空闲看门狗:引擎 15s 一次心跳 × 3。 */
export const STREAM_IDLE_MS = 45_000
const BACKOFF_MAX_MS = 30_000
const SESSION_TITLE_MAX = 60

interface SessionState {
  sessionId: string
  items: Map<string, PendingPromptWire>
  notif: NotificationHandle | null
  shownCount: number
  lastShownAt: number
  escalateTimer: unknown
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function createApprovalDelivery(d: ApprovalDeliveryDeps): ApprovalDelivery {
  const doFetch = d.fetch ?? fetch
  const now = d.now ?? Date.now
  const setT = d.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearT = d.clearTimeout ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>))

  let started = false
  let offStatus: (() => void) | null = null
  let conn: AbortController | null = null
  let retryTimer: unknown = null
  let idleTimer: unknown = null
  let attempt = 0
  /** 引擎不认这条路由(404):本次引擎寿命内不再试。 */
  let unsupported = false
  const all = new Map<string, PendingPromptWire>()
  const sessions = new Map<string, SessionState>()
  /** 会话 → 上次投收件箱的时刻;会话条目清空也留着(冷却要跨过「答完又来一条」)。 */
  const escalatedAt = new Map<string, number>()
  /** 条目 → 本端第一次见到它的时刻(本端时钟;不用引擎的 createdAt —— 两边时钟、测试里的假钟都不必对齐)。 */
  const arrivedAt = new Map<string, number>()

  // ── 通知 ──
  const deviceTitle = (items: PendingPromptWire[]): string => {
    const onlyInquiries = items.every((i) => i.kind !== 'approval')
    const latest = items[items.length - 1]
    const r = latest?.remote
    const base = onlyInquiries ? 'main.approvalDelivery.inquiryTitle' : 'main.approvalDelivery.approvalTitle'
    // 先看 callerUnit 再看名字:登记名可以只由零宽 / 双向符号组成,清洗后为空 —— 验过的设备不能因此被说成「未识别」(K1 评审)。
    if (r?.callerUnit) return r.callerName ? d.t(base, { device: r.callerName }) : d.t(`${base}Device`)
    return d.t(`${base}Unknown`)
  }
  const bodyOf = (items: PendingPromptWire[]): string => {
    const first = items[0]
    const session = clip(first?.sessionTitle?.trim() || d.t('main.approvalDelivery.untitled'), SESSION_TITLE_MAX)
    if (items.length > 1) return d.t('main.approvalDelivery.bodyMany', { session, n: items.length })
    if (first.kind === 'approval') return d.t('main.approvalDelivery.approvalBody', { session, tool: first.tool || '?' })
    return d.t('main.approvalDelivery.inquiryBody', { session })
  }
  const closeNotif = (s: SessionState): void => {
    try { s.notif?.close() } catch { /* 系统已收走 */ }
    s.notif = null
  }
  const show = (s: SessionState): void => {
    const items = [...s.items.values()]
    closeNotif(s)
    let h: NotificationHandle | null = null
    try { h = d.notify({ title: deviceTitle(items), body: bodyOf(items) }) } catch (e) { d.log(`[approval-delivery] 通知失败: ${(e as Error)?.message || e}`) }
    if (h) {
      const sid = s.sessionId
      h.onClick(() => d.openSession(sid))
    }
    s.notif = h
    s.shownCount = items.length
    s.lastShownAt = now()
  }

  // ── 投收件箱 ──
  const escalate = async (s: SessionState): Promise<void> => {
    s.escalateTimer = null
    if (!s.items.size || !s.sessionId) return
    // 定时器是会话第一条远程待批到达时起的;那条先被答掉、剩下的还没等满 60s → 按剩下里最老的一条重新计时,
    // 别替一条才等了几秒的待批发提醒(还顺手吃掉这个会话 10 分钟的冷却)。
    let oldest = Infinity
    for (const id of s.items.keys()) oldest = Math.min(oldest, arrivedAt.get(id) ?? now())
    const waited = now() - oldest
    if (waited < ESCALATE_AFTER_MS) {
      s.escalateTimer = setT(() => { void escalate(s) }, ESCALATE_AFTER_MS - waited)
      return
    }
    const last = escalatedAt.get(s.sessionId)
    if (last !== undefined && now() - last < ESCALATE_COOLDOWN_MS) return
    const creds = d.unitCreds()
    if (!creds) { d.log('[approval-delivery] 设备通道未连,跳过收件箱提醒'); return }
    const items = [...s.items.values()]
    const kinds = [...new Set(items.map((i) => (i.kind === 'approval' ? 'approval' : 'inquiry')))]
    const body = { sessionId: s.sessionId, count: Math.min(99, items.length), kinds }
    try {
      const r = await doFetch(`${creds.cloudUrl.replace(/\/+$/, '')}/api/units/${encodeURIComponent(creds.unitId)}/attention`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.token}`, 'X-Unit-Secret': creds.secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (r.ok || r.status === 429) escalatedAt.set(s.sessionId, now())
      if (!r.ok) d.log(`[approval-delivery] 收件箱提醒 HTTP ${r.status}`)
    } catch (e) {
      d.log(`[approval-delivery] 收件箱提醒失败: ${(e as Error)?.message || e}`) // 不重试:下一条新待批会再起定时器
    }
  }

  // ── 条目增删 ──
  const sessionKey = (it: PendingPromptWire): string => it.sessionId || `run:${it.runId}`
  const onAdded = (it: PendingPromptWire): void => {
    all.set(it.id, it)
    if (!arrivedAt.has(it.id)) arrivedAt.set(it.id, now())
    if (!it.remote) return // 本机 run 由渲染层托盘负责
    const key = sessionKey(it)
    let s = sessions.get(key)
    if (!s) {
      s = { sessionId: it.sessionId, items: new Map(), notif: null, shownCount: 0, lastShownAt: 0, escalateTimer: null }
      sessions.set(key, s)
    }
    s.items.set(it.id, it)
    if (s.items.size > s.shownCount && (!s.notif || now() - s.lastShownAt >= RENOTIFY_AFTER_MS)) show(s)
    if (!s.escalateTimer && s.sessionId) {
      const st = s
      st.escalateTimer = setT(() => { void escalate(st) }, ESCALATE_AFTER_MS)
    }
  }
  const dropSession = (key: string, s: SessionState): void => {
    closeNotif(s)
    if (s.escalateTimer) clearT(s.escalateTimer)
    s.escalateTimer = null
    sessions.delete(key)
  }
  const onRemoved = (id: string): void => {
    all.delete(id)
    arrivedAt.delete(id)
    for (const [key, s] of sessions) {
      if (!s.items.delete(id)) continue
      // 先答先得的桌面侧收起:手机先答、别的窗口先答、run 中止 —— 会话里没有远程待批了就关通知、撤投递。
      if (!s.items.size) dropSession(key, s)
      return
    }
  }
  const onSnapshot = (items: PendingPromptWire[]): void => {
    const next = new Set(items.map((i) => i.id))
    for (const id of [...all.keys()]) if (!next.has(id)) onRemoved(id)
    for (const it of items) if (!all.has(it.id)) onAdded(it)
    attempt = 0
  }
  const clearAll = (): void => {
    for (const [key, s] of [...sessions]) dropSession(key, s)
    all.clear()
    arrivedAt.clear()
  }

  // ── 连接 ──
  const armIdle = (c: AbortController): void => {
    if (idleTimer) clearT(idleTimer)
    idleTimer = setT(() => {
      d.log(`[approval-delivery] 待批流 ${Math.round(STREAM_IDLE_MS / 1000)}s 没有任何字节(引擎 15s 一次心跳),重连`)
      c.abort()
    }, STREAM_IDLE_MS)
  }
  const disconnect = (): void => {
    conn?.abort()
    conn = null
    if (idleTimer) clearT(idleTimer)
    idleTimer = null
    if (retryTimer) clearT(retryTimer)
    retryTimer = null
  }
  const scheduleRetry = (): void => {
    if (!started || retryTimer) return
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** attempt)
    attempt++
    retryTimer = setT(() => { retryTimer = null; void connect() }, delay)
  }
  const handleFrame = (data: string): void => {
    let f: any
    try { f = JSON.parse(data) } catch { return }
    if (f?.type === 'snapshot' && Array.isArray(f.items)) onSnapshot(f.items)
    else if (f?.type === 'added' && f.item?.id) onAdded(f.item)
    else if (f?.type === 'removed' && typeof f.id === 'string') onRemoved(f.id)
  }
  const connect = async (): Promise<void> => {
    if (!started || conn || unsupported) return
    const { url, token } = d.getEngine()
    if (!url) return // 引擎未就绪 / 外部模式:idle,等 onEngineStatus
    const c = new AbortController()
    conn = c
    try {
      const r = await doFetch(`${url}/agent/approvals/stream`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: c.signal })
      if (r.status === 404) { unsupported = true; d.log('[approval-delivery] 引擎不支持待批流(老版本),停用'); return }
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      armIdle(c)
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done || c.signal.aborted) break
        armIdle(c)
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = block.split('\n').find((l) => l.startsWith('data: '))
          if (line) handleFrame(line.slice(6))
        }
      }
    } catch (e) {
      if (!c.signal.aborted || conn === c) d.log(`[approval-delivery] 待批流断开: ${(e as Error)?.message || e}`)
    } finally {
      if (conn === c) {
        conn = null
        if (idleTimer) clearT(idleTimer)
        idleTimer = null
        if (!unsupported) scheduleRetry()
      }
    }
  }

  return {
    start(): void {
      if (started) return
      started = true
      offStatus = d.onEngineStatus((ready) => {
        if (ready) {
          unsupported = false // 引擎换了(重启 / 升级):再试一次
          if (!conn && !retryTimer) { attempt = 0; void connect() }
        } else {
          disconnect()
          clearAll() // 引擎一停,待批全失效;新引擎的快照会补回仍在等的(不会有)
        }
      })
      void connect()
    },
    stop(): void {
      if (!started) return
      started = false
      offStatus?.()
      offStatus = null
      disconnect()
      clearAll()
    },
    pending: () => [...all.values()],
  }
}
