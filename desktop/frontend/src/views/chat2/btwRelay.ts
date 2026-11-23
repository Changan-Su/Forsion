/**
 * 顺便问的「传话」(11-22 方案 relay.html,用户选 A + 传话):旁问模型没有工具,用户要它带话 / 问题需要主对话动手时,
 * 它在回答末尾写一个 ```relay 块(提示词见 tangu-agent services/aside.ts)。这里把块拆出来画成「转给主对话」卡,
 * **模型只拟稿,发不发由用户点**:
 *  - 发给主对话 = 一条普通用户消息(主对话在跑时照主输入框的规矩走插话 / 排队,useApp.send 自己判);
 *  - 放进输入框 = 接在那个会话主输入框已有草稿后面(pendingShare 带会话 id,别的聊天视图不接;不覆盖打了一半的字);
 *  - 发给别的会话 = 最近的会话里挑一个,同样走 send。
 * 卡片上显示的就是要发的原文(纯文本,不渲染 Markdown:Codex 11-23 #1,渲染会藏掉引用定义一类的字、图片还会当场外连)。
 * 发出去的那条在主对话里画一枚「来自顺便问」小标:记在本机(localStorage,按账号分),按 会话 + 正文 + 时间 认。
 * 换设备看不到小标,消息本身照常同步。
 * 卫星窗(独立窗 / Mini 里的原生浮窗)各握一份 store、不该替主窗发消息:那里只给「放进输入框」(经主窗的 chat-quote)。
 */
import { contentStorageKey, useWorkspace } from '@lcl/engine'
import { useApp } from '../../stores/appStore'
import { onSteerDropped } from '../../tangu/store/steerDropped'
import { windowKind } from '../../windowKind'

/** 回答里拆出来的传话稿。partial = 还在流、块没写完(先别画按钮)。 */
export interface RelaySplit { body: string; relay?: string; partial?: boolean }

/** 一行围栏(同 CommonMark):行首至多 3 个空格,再是反引号 / 波浪号串 + 信息串;闭合要同一种字符、不短于开串。缩进 4 格的是代码行,不算围栏(Codex 11-23 复审)。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** 拆最后一个**顶层** ```relay 块:块之前(和之后,一般没有)的字照常画,块里的字进卡片。没闭合时:流着 = 先藏起来(partial),流完 = 当正文。
 *  按行走一遍围栏:别的代码块(含四个反引号包着的 relay 示例)里的 ```relay 不认(Codex 11-23 #3 的后半)。
 *  只该对「答完」和「还在流」的回答调:停掉 / 出错的回答原样显示,别把半截稿吞掉(Codex 11-23 #3)。 */
export function splitRelay(raw: string, streaming = false): RelaySplit {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  let open: { ch: string; len: number; relay: boolean; at: number } | null = null
  let last: { from: number; to: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i])
    if (!m) continue
    const ch = m[1][0]
    const info = m[2].trim()
    if (!open) {
      if (ch === '`' && info.includes('`')) continue // 行内代码,不是围栏
      open = { ch, len: m[1].length, relay: ch === '`' && /^relay$/i.test(info), at: i }
    } else if (ch === open.ch && m[1].length >= open.len && !info) {
      if (open.relay) last = { from: open.at, to: i }
      open = null
    }
  }
  if (open?.relay) {
    return streaming ? { body: lines.slice(0, open.at).join('\n').trimEnd(), partial: true } : { body: raw }
  }
  if (!last) return { body: raw }
  const relay = lines.slice(last.from + 1, last.to).join('\n').trim()
  const before = lines.slice(0, last.from).join('\n').trimEnd()
  const after = lines.slice(last.to + 1).join('\n').trim()
  return relay ? { body: `${before}${after ? `\n\n${after}` : ''}`, relay } : { body: raw }
}

/* ── 本机记录:哪些消息是从顺便问传过去的(小标 + 卡片的「已发」状态) ── */
export interface RelayRecord {
  /** 传到哪个会话。 */
  to: string
  /** 从哪个会话的顺便问传的(点小标打开那段)。 */
  from: string
  asideId?: string
  messageId?: string
  text: string
  at: number
  how: 'sent' | 'steer'
  /** 发出时进了等待区(插话 / 排队)的那一项 id:撤回 / 退回时按它认是哪一次(同一句从两段顺便问各发一次也分得开)。 */
  pendingId?: string
}
const BASE_KEY = 'forsion_btw_relays_v1'
const MAX = 300
/** 小标认消息时容许的时差:消息时间戳(引擎落库)比本机记下的时刻早这么多以内都算。 */
const SKEW_MS = 2 * 60_000
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
/** 按账号分(切账号不串);每次现取,账号换了缓存跟着作废。 */
const key = (): string => contentStorageKey(BASE_KEY)

function readAll(k: string): RelayRecord[] {
  try {
    const raw = localStorage.getItem(k)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r.to === 'string' && typeof r.text === 'string' && typeof r.at === 'number') : []
  } catch { return [] }
}
const listeners = new Set<() => void>()
let cache: { key: string; rows: RelayRecord[] } | null = null
const all = (): RelayRecord[] => {
  const k = key()
  if (!cache || cache.key !== k) cache = { key: k, rows: readAll(k) }
  return cache.rows
}

/** 记一条(只在真发出去之后调)。写前从 localStorage 重读,别拿本窗口的旧缓存盖掉别的窗口刚写的(Codex 11-23 #6)。 */
export function recordRelay(rec: RelayRecord): void {
  const k = key()
  const fresh = readAll(k)
  const next = [...fresh.filter((r) => !(r.to === rec.to && r.at === rec.at)), rec].slice(-MAX)
  cache = { key: k, rows: next }
  try { localStorage.setItem(k, JSON.stringify(next)) } catch { /* 存不下:小标只是这次看不到,消息照常 */ }
  listeners.forEach((l) => l())
}

/** 别的窗口写了记录(storage 事件):丢掉缓存重读。 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key?.startsWith(BASE_KEY)) { cache = null; listeners.forEach((l) => l()) } })
}
/** 发出去的那句没进对话(用户从等待区撤回 / run 中止退回输入框):撤掉那笔记录,卡片恢复成可发、小标不画。
 *  先按等待项 id 认;对不上(排队项发不出去换了 id)再按正文认最近一笔 —— 这时同字的那句在这笔之后已落进对话
 *  (早先真送达的那次)就不撤,撤回的是用户另打的同一句。 */
export function dropRelay(to: string, text: string, pendingId?: string): boolean {
  const c = norm(text)
  if (!c) return false
  const k = key()
  const fresh = readAll(k)
  let i = pendingId ? fresh.findIndex((r) => r.to === to && r.pendingId === pendingId) : -1
  if (i < 0) {
    const live = new Set((useApp.getState().steerPendingBySession?.[to] || []).map((p) => p.id))
    for (i = fresh.length - 1; i >= 0; i--) {
      const r = fresh[i]
      // 还挂在等待区里的那次不是这回撤掉的
      if (r.to === to && norm(r.text) === c && !(r.pendingId && live.has(r.pendingId))) break
    }
    if (i < 0) return false
    const at = fresh[i].at
    const landed = (useApp.getState().messagesBySession?.[to] || []).some((m) =>
      m.role === 'user' && norm(String(m.content || '')) === c && (m.timestamp ?? 0) >= at)
    if (landed) return false
  }
  const next = fresh.filter((_, j) => j !== i)
  cache = { key: k, rows: next }
  try { localStorage.setItem(k, JSON.stringify(next)) } catch { /* 存不下:本窗口缓存已撤,够这次用 */ }
  listeners.forEach((l) => l())
  return true
}
onSteerDropped((sessionId, items) => { items.forEach((p) => dropRelay(sessionId, p.text, p.id)) })

export function onRelaysChanged(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }

/** 这条用户消息是不是从顺便问传过来的。带上消息时间戳时,比记录早出 SKEW_MS 以上的(手打的老消息碰巧同字)不认。 */
export function relayFor(sessionId: string | null | undefined, content: string, timestamp?: number): RelayRecord | undefined {
  if (!sessionId || !content) return undefined
  const c = norm(content)
  return all().find((r) => r.to === sessionId && norm(r.text) === c && !(timestamp && timestamp < r.at - SKEW_MS))
}
/** 这张卡(某段顺便问里的这句稿)发过没有、发到了哪。两边都有记录 id 时要对上,别的段同一句稿不算。 */
export function relaySentFrom(from: string, text: string, asideId?: string): RelayRecord | undefined {
  const c = norm(text)
  const rows = all()
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.from === from && norm(r.text) === c && (!asideId || !r.asideId || r.asideId === asideId)) return r
  }
  return undefined
}

/** 当前窗口能不能替主对话发消息(主窗 / 网页 / 手机能;卫星窗不能)。 */
export const canSendRelay = (): boolean => windowKind() === 'main'

/** 发:走主输入框同一条路(在跑 → 插话 / 排队,没跑 → 起 run)。发成功才记(失败的重试不碰之前那条成功的记录),返回去向。 */
export async function sendRelay(opts: { from: string; to: string; text: string; asideId?: string; messageId?: string }): Promise<'sent' | 'steer' | null> {
  const text = opts.text.trim()
  if (!text || !canSendRelay()) return null
  const app = useApp.getState()
  const how = app.runningBySession[opts.to] ? 'steer' as const : 'sent' as const
  const at = Date.now()
  const ok = await app.send(text, [], undefined, undefined, undefined, opts.to).catch(() => false)
  if (!ok) return null
  // 进了等待区(插话 / 排队)就记下是哪一项:取同字、还没被别的记录认领的最新一项
  const claimed = new Set(all().map((r) => r.pendingId).filter(Boolean))
  const pend = [...(useApp.getState().steerPendingBySession?.[opts.to] || [])].reverse().find((p) => norm(p.text) === norm(text) && !claimed.has(p.id))
  recordRelay({ to: opts.to, from: opts.from, asideId: opts.asideId, messageId: opts.messageId, text, at, how, ...(pend ? { pendingId: pend.id } : {}) })
  return how
}

/** 放进主输入框:主窗接在那个会话的已有草稿后面(不覆盖;别的聊天视图不接);卫星窗请主窗挂成引用(chat-quote,同「带回这里」)。 */
export function composeRelay(text: string, sessionId: string): void {
  const body = text.trim().slice(0, 20000)
  if (!body) return
  if (!canSendRelay()) { window.tangu?.requestMainAction?.('chat-quote', body); return }
  const app = useApp.getState()
  app.setPendingShare({ text: body, files: [], sessionId })
  if (app.activeId !== sessionId) app.setActiveId(sessionId)
  useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
}

/** 「发给别的会话」的候选:最近更新的几条,不含当前这条、不含归档。 */
export function relayTargets(exclude: string, n = 5): Array<{ id: string; title: string; running: boolean }> {
  const s = useApp.getState()
  const ts = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || Date.parse(String(v)) || 0)
  return [...s.sessions]
    .filter((x) => x.id !== exclude)
    .sort((a, b) => ts(b.updated_at) - ts(a.updated_at))
    .slice(0, n)
    .map((x) => ({ id: x.id, title: x.title || '', running: !!s.runningBySession[x.id] }))
}

/** 发完「跳过去看」:切到那个会话的主区聊天。 */
export function openRelayTarget(sessionId: string): void {
  useApp.getState().setActiveId(sessionId)
  useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
}
