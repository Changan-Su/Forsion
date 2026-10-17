/**
 * 会话列表「等你处理」点的数据源(设备能力 MCP 方案 P1 · K3 §3.7)。desktop 与 mobile 经 useBootstrap 共用。
 *
 * 两路合并(mergeAttention):
 *   ① 引擎的待批索引 GET /agent/approvals/pending(只给按会话的计数,远端经隧道可读)—— 覆盖**没订阅**的会话:
 *      手机驱动的远程 run、后台 Agent、别的窗口开着的会话。20s 轮询 + 回前台立即拉 + 隐藏时暂停,?rev= 未变只回几十字节。
 *   ② 本地派生:订阅着的会话(runningBySession)以本地 messagesBySession 的待批卡为准 —— 更新鲜(事件流实时),
 *      答掉的那一刻点就灭,不等下一轮轮询。
 *
 * 目标来源 = K6 的 knownTargets()(INTEGRATION R-20:今天只有 home;S4 起含有绑定会话的 unit)。持有的是 home 的**活目标**,
 * 跨引擎重启 / 重连 base 与 token 自动跟上 —— 不要换成 asTarget(cfg) 快照(6649c760 专为这个轮询修过)。
 * 某个目标回 404(云端 worker / 老引擎)→ 标 disabled,本次启动不再拉;离线 / 5xx → 保留旧值、下一轮再拉。
 * 会话键 = 裸会话 id(uuid,R-20 删掉了 sessionKeyOf)。
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import { engineFetch, homeTarget, knownTargets } from '../services/engine/targets'
import type { UiMessage } from '../types'
import { rowStatus, type RowStatus } from '../views/chat2/sessionTree'
import { setActiveSpace } from '@lcl/engine'
import { useApp } from './appStore'
import { notifyApp } from './notificationStore'

export interface SessionAttention {
  sessionId: string
  approvals: number
  inquiries: number
  localOnly: number
  oldestAt: string
  remote: boolean
}

export interface TargetAttention {
  rev: string | null
  sessions: SessionAttention[]
  /** 404:这个目标没有待批索引(云端 / 老引擎),本次启动不再拉。 */
  disabled?: boolean
  at: number
}

/** 私聊的「有新消息 / 等你」(引擎 GET /agent/sessions/attention,只拉本端):Muse 主动发来的未读、它问了一句在等回答、
 *  它后台有待批(pending_approvals,不在上面那份 run 内存索引里)。run 跑完的未读照旧在 appStore.unread。 */
export interface DmAttention { unread: boolean; awaiting: boolean }

interface AttentionState {
  byTarget: Record<string, TargetAttention>
  dm: Record<string, DmAttention>
  /** 读过:本地先熄、再告诉引擎(proactive_at ≤ last_read_at)。 */
  markRead(sessionId: string): void
  /** 装轮询(幂等,可重复调用 —— StrictMode 双 effect 只装一份);返回卸载。 */
  install(): () => void
  refresh(targetKey?: string): Promise<void>
}

export const ATTENTION_POLL_MS = 20_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_SESSIONS = 500

const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, 999) : 0)
/** 响应清洗:远端经隧道来的 JSON,形状不对的行丢掉(渲染层据此画点,不能被一行脏数据炸掉)。 */
function sanitizeSessions(raw: unknown): SessionAttention[] {
  if (!Array.isArray(raw)) return []
  const out: SessionAttention[] = []
  for (const r of raw.slice(0, MAX_SESSIONS)) {
    if (!r || typeof r !== 'object' || typeof (r as any).sessionId !== 'string' || !(r as any).sessionId || (r as any).sessionId.length > 64) continue
    const o = r as Record<string, unknown>
    out.push({
      sessionId: o.sessionId as string, approvals: count(o.approvals), inquiries: count(o.inquiries), localOnly: count(o.localOnly),
      oldestAt: typeof o.oldestAt === 'string' ? o.oldestAt.slice(0, 40) : '', remote: o.remote === true,
    })
  }
  return out
}

function sanitizeDm(raw: unknown): Record<string, DmAttention> {
  const out: Record<string, DmAttention> = {}
  if (!Array.isArray(raw)) return out
  for (const r of raw.slice(0, MAX_SESSIONS)) {
    if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 64) continue
    out[r.id] = { unread: r.unread === true, awaiting: r.awaiting === true }
  }
  return out
}

const inflight = new Set<string>()
let dmDisabled = false // 老引擎没有这个端点(404):本次启动不再拉
let dmLoaded = false
let installs = 0
let teardown: (() => void) | null = null

export const useAttention = create<AttentionState>((set, get) => ({
  byTarget: {},
  dm: {},

  markRead(sessionId) {
    const cur = get().dm[sessionId]
    if (!cur?.unread) return
    set((s) => ({ dm: { ...s.dm, [sessionId]: { ...cur, unread: false } } }))
    void engineFetch(homeTarget(), `/agent/sessions/${encodeURIComponent(sessionId)}/read`, { method: 'POST' }, { timeoutMs: REQUEST_TIMEOUT_MS }).catch(() => {})
  },

  async refresh(targetKey) {
    if (useApp.getState().connState !== 'ok') return
    let targets
    try { targets = knownTargets() } catch { return } // 宿主还没装(启动极早期)
    if (!dmDisabled && (!targetKey || targetKey === 'home') && !inflight.has('dm')) {
      inflight.add('dm')
      void engineFetch(homeTarget(), '/agent/sessions/attention', {}, { timeoutMs: REQUEST_TIMEOUT_MS })
        .then(async (r) => {
          if (r.status === 404) { dmDisabled = true; return }
          if (!r.ok) return
          const j = await r.json().catch(() => null) as { sessions?: unknown } | null
          if (!j) return
          const dm = sanitizeDm(j.sessions)
          const prev = get().dm
          const first = !dmLoaded
          dmLoaded = true
          set({ dm })
          readActiveDm()
          if (!first) notifyNewWaits(prev, dm) // 启动那一拉不弹:那些是之前就在等的
        })
        .catch(() => {})
        .finally(() => inflight.delete('dm'))
    }
    await Promise.all(targets.filter((t) => !targetKey || t.key === targetKey).map(async (t) => {
      const prev = get().byTarget[t.key]
      if (prev?.disabled || inflight.has(t.key)) return
      inflight.add(t.key)
      try {
        const q = prev?.rev ? `?rev=${encodeURIComponent(prev.rev)}` : ''
        const r = await engineFetch(t, `/agent/approvals/pending${q}`, {}, { timeoutMs: REQUEST_TIMEOUT_MS })
        if (r.status === 404) {
          set((s) => ({ byTarget: { ...s.byTarget, [t.key]: { rev: null, sessions: [], disabled: true, at: Date.now() } } }))
          return
        }
        if (!r.ok) return // 离线 / 5xx / 401:保留旧值,下一轮再拉
        const j = await r.json().catch(() => null) as { rev?: unknown; unchanged?: unknown; sessions?: unknown } | null
        if (!j || typeof j.rev !== 'string') return
        if (j.unchanged === true && prev && j.rev === prev.rev) {
          set((s) => ({ byTarget: { ...s.byTarget, [t.key]: { ...prev, at: Date.now() } } }))
          return
        }
        set((s) => ({ byTarget: { ...s.byTarget, [t.key]: { rev: j.rev as string, sessions: sanitizeSessions(j.sessions), at: Date.now() } } }))
      } catch { /* 网络异常:保留旧值 */ } finally {
        inflight.delete(t.key)
      }
    }))
  },

  install() {
    installs++
    if (!teardown && typeof window !== 'undefined') {
      const tick = (): void => {
        if (typeof document !== 'undefined' && document.hidden) return // 隐藏时暂停(移动端后台 / 桌面最小化)
        void get().refresh()
      }
      const timer = window.setInterval(tick, ATTENTION_POLL_MS)
      const onVis = (): void => { if (typeof document !== 'undefined' && !document.hidden) void get().refresh() }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
      // 连上的那一刻拉一次(启动 / 断线重连 / 引擎重启):别等 20s。打开一条私聊 = 读过。
      let prevConn = useApp.getState().connState
      let prevActive = useApp.getState().activeId
      const unsub = useApp.subscribe((s) => {
        if (s.connState === 'ok' && prevConn !== 'ok') void get().refresh()
        prevConn = s.connState
        if (s.activeId !== prevActive) { prevActive = s.activeId; readActiveDm() }
      })
      tick()
      teardown = () => {
        window.clearInterval(timer)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
        unsub()
      }
    }
    let done = false
    return () => {
      if (done) return
      done = true
      if (--installs > 0) return
      teardown?.()
      teardown = null
    }
  },
}))

/** 私聊新进入「等你」→ 系统通知(只这一种弹;提醒只亮角标)。用户正看着那条就不弹。 */
function notifyNewWaits(prev: Record<string, DmAttention>, next: Record<string, DmAttention>): void {
  const st = useApp.getState()
  const visible = typeof document === 'undefined' || !document.hidden
  for (const [id, d] of Object.entries(next)) {
    if (!d.awaiting || prev[id]?.awaiting || (id === st.activeId && visible)) continue
    const x = st.sessions.find((s) => s.id === id)
    if (!x || !soloOf(st.configBySession[id] ?? x.agent_config)) continue
    notifyApp({
      event: 'dm.waiting', level: 'info', dedupeKey: `dm.waiting:${id}`,
      title: x.title || '', text: st.tr('ntf.dmWaiting'),
      action: { label: st.tr('ntf.view'), run: () => { setActiveSpace('tangu'); void import('../sessionNav').then((m) => m.openSession(id)) } },
    })
  }
}

/** 正开着(窗口可见)的那条私聊有新消息 → 就地算读过(用户就在看它)。 */
function readActiveDm(): void {
  const id = useApp.getState().activeId
  if (id && (typeof document === 'undefined' || !document.hidden)) useAttention.getState().markRead(id)
}

/**
 * 纯函数:合并索引与本地派生 → 会话 id → { n, localOnly }(n = 等你处理的审批 + 询问数)。
 * 订阅着的会话(runningBySession 里有)以本地为准:事件流实时、比 20s 一轮的索引新 —— 本地说 0 就是 0(刚答掉)。
 * 其余用索引(多个目标的同一会话 id 相加;id 是 uuid,正常不会撞)。
 */
export function mergeAttention(
  index: Record<string, SessionAttention>,
  messagesBySession: Record<string, UiMessage[] | undefined>,
  runningBySession: Record<string, string>,
): Map<string, { n: number; localOnly: boolean }> {
  const out = new Map<string, { n: number; localOnly: boolean }>()
  for (const [sid, a] of Object.entries(index)) {
    if (runningBySession[sid]) continue
    const n = a.approvals + a.inquiries
    if (n > 0) out.set(sid, { n, localOnly: a.localOnly > 0 })
  }
  for (const sid of Object.keys(runningBySession)) {
    let n = 0
    let localOnly = false
    for (const m of messagesBySession[sid] || []) {
      for (const a of m.approvals || []) if (a.status === 'pending') { n++; if (a.localOnly) localOnly = true }
      for (const q of m.inquiries || []) if (q.status === 'pending') n++
    }
    if (n > 0) out.set(sid, { n, localOnly })
  }
  return out
}

/** byTarget → 按会话 id 汇总的索引(给 mergeAttention)。disabled 的目标不计。 */
export function attentionIndex(byTarget: Record<string, TargetAttention>): Record<string, SessionAttention> {
  const out: Record<string, SessionAttention> = {}
  for (const t of Object.values(byTarget)) {
    if (t.disabled) continue
    for (const a of t.sessions) {
      const cur = out[a.sessionId]
      out[a.sessionId] = cur
        ? { ...cur, approvals: cur.approvals + a.approvals, inquiries: cur.inquiries + a.inquiries, localOnly: cur.localOnly + a.localOnly, remote: cur.remote || a.remote }
        : { ...a }
    }
  }
  return out
}

/**
 * 订阅着的会话的本地待批签名(`sid:n:lo`,排序后拼接)。组件用它作 zustand 选择器:字符串相等就不重渲染 ——
 * 直接订阅 messagesBySession 会让整个侧栏每个 token 重绘一遍。
 */
export function localAttentionSignature(s: { messagesBySession: Record<string, UiMessage[] | undefined>; runningBySession: Record<string, string> }): string {
  const parts: string[] = []
  for (const sid of Object.keys(s.runningBySession)) {
    let n = 0
    let lo = false
    for (const m of s.messagesBySession[sid] || []) {
      if (m.approvals) for (const a of m.approvals) if (a.status === 'pending') { n++; if (a.localOnly) lo = true }
      if (m.inquiries) for (const q of m.inquiries) if (q.status === 'pending') n++
    }
    parts.push(`${sid}:${n}:${lo ? 1 : 0}`)
  }
  return parts.sort().join('|')
}

/** 会话列表用:会话 id → { n, localOnly }(索引 × 本地派生,见 mergeAttention)。只在计数真变了时才给新 Map。 */
export function useSessionAttention(): Map<string, { n: number; localOnly: boolean }> {
  const byTarget = useAttention((s) => s.byTarget)
  const sig = useApp(localAttentionSignature)
  return useMemo(() => {
    const st = useApp.getState()
    return mergeAttention(attentionIndex(byTarget), st.messagesBySession, st.runningBySession)
    // sig 是本地那半的变化信号(读的是 getState 的现值)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byTarget, sig])
}

/** @internal 测试用 */
export function __resetAttentionForTests(): void {
  teardown?.()
  teardown = null
  installs = 0
  inflight.clear()
  dmDisabled = false
  dmLoaded = false
  useAttention.setState({ byTarget: {}, dm: {} })
}

const soloOf = (c: { soloAgentSlug?: string; soloEngineId?: string } | null | undefined): boolean => !!(c?.soloAgentSlug || c?.soloEngineId)

/**
 * 私聊(Agent / 引擎的单人会话)→ 行尾状态:run 待批 / Muse 后台待批 / 它问了一句 = 等你;在跑;Muse 主动发来没看 / run 跑完没看 = 有新消息。
 * 侧栏 Agent 轨道行与 Tangu Space 角标共用这一份(方案 B:角标数 = 有新消息或在等你的私聊个数)。
 * enabled=false 时选择器直接回空串,不为每颗 Space 按钮扫一遍会话。
 */
export function useSoloStatus(enabled = true): Map<string, RowStatus> {
  const dm = useAttention((s) => s.dm)
  const attention = useSessionAttention()
  const sig = useApp((s) => {
    if (!enabled) return ''
    const parts: string[] = []
    for (const x of s.sessions) {
      if (!soloOf(s.configBySession[x.id] ?? x.agent_config)) continue
      parts.push(`${x.id}:${x.busy ? 1 : 0}${x.awaiting_user ? 1 : 0}${s.unread.has(x.id) ? 1 : 0}${s.runningBySession[x.id] ? 1 : 0}`)
    }
    return parts.join('|')
  })
  return useMemo(() => {
    const out = new Map<string, RowStatus>()
    if (!sig) return out
    const st = useApp.getState()
    for (const x of st.sessions) {
      if (!soloOf(st.configBySession[x.id] ?? x.agent_config)) continue
      const d = dm[x.id]
      const v = rowStatus({ busy: x.busy, awaiting_user: x.awaiting_user || d?.awaiting }, !!attention.get(x.id), !!st.runningBySession[x.id], st.unread.has(x.id) || !!d?.unread)
      if (v) out.set(x.id, v)
    }
    return out
  }, [sig, dm, attention])
}

/** Tangu 角标:有新消息或在等你的私聊个数;有一条在等你就用警示色。 */
export function soloBadge(status: Map<string, RowStatus>): { n: number; wait: boolean } {
  let n = 0
  let wait = false
  for (const v of status.values()) {
    if (v === 'wait') { n++; wait = true } else if (v === 'done') n++
  }
  return { n, wait }
}
