/**
 * 顺便问的「传话」(11-22 方案 relay.html,用户选 A + 传话):旁问模型没有工具,用户要它带话 / 问题需要主对话动手时,
 * 它在回答末尾写一个 ```relay 块(提示词见 tangu-agent services/aside.ts)。这里把块拆出来画成「转给主对话」卡,
 * **模型只拟稿,发不发由用户点**:
 *  - 发给主对话 = 一条普通用户消息(主对话在跑时照主输入框的规矩走插话 / 排队,useApp.send 自己判);
 *  - 放进输入框 = 接在主输入框已有草稿后面(pendingShare,不覆盖打了一半的字);
 *  - 发给别的会话 = 最近的会话里挑一个,同样走 send。
 * 发出去的那条在主对话里画一枚「来自顺便问」小标:记在本机(localStorage),按 会话 + 正文 认。换设备看不到小标,消息本身照常同步。
 * 卫星窗(独立窗 / Mini 里的原生浮窗)各握一份 store、不该替主窗发消息:那里只给「放进输入框」(经主窗的 chat-quote)。
 */
import { useWorkspace } from '@lcl/engine'
import { useApp } from '../../stores/appStore'
import { windowKind } from '../../windowKind'

/** 回答里拆出来的传话稿。partial = 还在流、块没写完(先别画按钮)。 */
export interface RelaySplit { body: string; relay?: string; partial?: boolean }

const OPEN_RE = /(^|\n)[ \t]*```[ \t]*relay[ \t]*\n/gi

/** 拆最后一个 ```relay 块:块之前(和之后,一般没有)的字照常画,块里的字进卡片。没闭合时:流着 = 先藏起来(partial),流完 = 当正文。 */
export function splitRelay(answer: string, streaming = false): RelaySplit {
  let open: RegExpExecArray | null = null
  for (let m = OPEN_RE.exec(answer); m; m = OPEN_RE.exec(answer)) open = m
  OPEN_RE.lastIndex = 0
  if (!open) return { body: answer }
  const start = open.index + open[1].length
  const inner = open.index + open[0].length
  const close = /\n[ \t]*```[ \t]*(?=\n|$)/.exec(answer.slice(inner - 1))
  if (!close) {
    return streaming ? { body: answer.slice(0, start).trimEnd(), partial: true } : { body: answer }
  }
  const innerEnd = inner - 1 + close.index
  const relay = answer.slice(inner, innerEnd).trim()
  const after = answer.slice(innerEnd + close[0].length)
  const body = `${answer.slice(0, start).trimEnd()}${after.trim() ? `\n\n${after.trim()}` : ''}`
  return relay ? { body, relay } : { body }
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
}
const KEY = 'forsion_btw_relays_v1'
const MAX = 300
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

function readAll(): RelayRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r.to === 'string' && typeof r.text === 'string') : []
  } catch { return [] }
}
const listeners = new Set<() => void>()
let cache: RelayRecord[] | null = null
const all = (): RelayRecord[] => (cache ??= readAll())

export function recordRelay(rec: RelayRecord): void {
  const next = [...all().filter((r) => !(r.to === rec.to && norm(r.text) === norm(rec.text))), rec].slice(-MAX)
  cache = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* 存不下:小标只是这次看不到,消息照常 */ }
  listeners.forEach((l) => l())
}

/** 别的窗口写了记录(storage 事件):丢掉缓存重读。 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === KEY) { cache = null; listeners.forEach((l) => l()) } })
}
export function onRelaysChanged(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }

/** 这条用户消息是不是从顺便问传过来的。 */
export function relayFor(sessionId: string | null | undefined, content: string): RelayRecord | undefined {
  if (!sessionId || !content) return undefined
  const c = norm(content)
  return all().find((r) => r.to === sessionId && norm(r.text) === c)
}
/** 这张卡(某段顺便问里的这句稿)发过没有、发到了哪。 */
export function relaySentFrom(from: string, text: string): RelayRecord | undefined {
  const c = norm(text)
  return [...all()].reverse().find((r) => r.from === from && norm(r.text) === c)
}

/** 当前窗口能不能替主对话发消息(主窗 / 网页 / 手机能;卫星窗不能)。 */
export const canSendRelay = (): boolean => windowKind() === 'main'

/** 发:走主输入框同一条路(在跑 → 插话 / 排队,没跑 → 起 run)。成功才记,返回去向。 */
export async function sendRelay(opts: { from: string; to: string; text: string; asideId?: string; messageId?: string }): Promise<'sent' | 'steer' | null> {
  const text = opts.text.trim()
  if (!text || !canSendRelay()) return null
  const app = useApp.getState()
  const how = app.runningBySession[opts.to] ? 'steer' as const : 'sent' as const
  // 先记再发:send 里用户消息一上屏就会渲染,先记小标才不闪一下
  const rec: RelayRecord = { to: opts.to, from: opts.from, asideId: opts.asideId, messageId: opts.messageId, text, at: Date.now(), how }
  recordRelay(rec)
  const ok = await app.send(text, [], undefined, undefined, undefined, opts.to).catch(() => false)
  if (!ok) { forgetRelay(rec); return null }
  return how
}

function forgetRelay(rec: RelayRecord): void {
  const next = all().filter((r) => r !== rec && !(r.to === rec.to && r.at === rec.at))
  cache = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* ignore */ }
  listeners.forEach((l) => l())
}

/** 放进主输入框:主窗接在已有草稿后面(不覆盖);卫星窗请主窗挂成引用(chat-quote,同「带回这里」)。 */
export function composeRelay(text: string): void {
  const body = text.trim().slice(0, 20000)
  if (!body) return
  if (!canSendRelay()) { window.tangu?.requestMainAction?.('chat-quote', body); return }
  useApp.getState().setPendingShare({ text: body, files: [] })
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
