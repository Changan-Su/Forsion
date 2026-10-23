/** 任务卡(```forsion-task)的「处理过了没」+ 会话里还在等你选的那几张(对话末尾的卡片堆收它们,方案「待确认卡片」B)。
 *  处理记录落 localStorage:卡片堆按它判断收不收一张卡,不落盘的话重启后 7 天内的旧卡全部回到卡片堆。
 *  键 = 会话(收件箱是信 id)+ 卡内容哈希,不含消息 id 和卡序:消息 id 在乐观气泡 / 落库之间可能换,卡序在重排后会变。 */
import { useSyncExternalStore } from 'react'
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { splitSuggestions, type TaskCard } from './suggest'

/** 任务卡落点:开个子会话 / 在这里做 / 新会话执行(收件箱,没有当前会话)/ 交给 Muse / 忽略(spawn_task 的 worktree、云端两档刻意不搬)。 */
export type TaskLanding = 'child' | 'here' | 'new' | 'muse' | 'ignore'
/** 卡片 7 天内有效(方案「子会话与任务卡」第 3 步):过了就定格成「已过期」,要做让 agent 重写一张。 */
export const TASK_CARD_TTL_MS = 7 * 24 * 3600_000

const KEY = 'forsion_task_cards_handled'
type Rec = { l: TaskLanding; t: number; c?: string }

function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
/** Muse 待办按待办 id、带 id 的卡按卡 id 认(同样文字的两张不同待办不能共用一条记录,Codex 10-23);其余按内容。 */
export function taskDoneKey(scope: string, c: TaskCard): string {
  return `${scope}:${c.todo ? `todo:${c.todo}` : c.id ? `id:${c.id}` : hashStr(`${c.title}|${c.prompt}`)}`
}

let recs: Record<string, Rec> | null = null
let version = 0
const listeners = new Set<() => void>()
function read(): Record<string, Rec> {
  const out: Record<string, Rec> = {}
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Rec>
    // 卡 7 天就过期,记录多留一天够了
    const keep = Date.now() - TASK_CARD_TTL_MS - 24 * 3600_000
    for (const [k, v] of Object.entries(raw)) if (v && typeof v.t === 'number' && v.t > keep) out[k] = v
  } catch { /* 私密窗口 / 坏数据:当作没有记录 */ }
  return out
}
function load(): Record<string, Rec> {
  return (recs ??= read())
}
const bump = (): void => { version++; for (const f of listeners) f() }
// 别的窗口(Mini / 分离窗口各是一个渲染进程)记了一笔:作废缓存,跟着重渲
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) { recs = null; bump() } })
export function taskHandled(key: string): { landing: TaskLanding; childId?: string } | undefined {
  const r = load()[key]
  return r ? { landing: r.l, childId: r.c } : undefined
}
export function markTaskHandled(key: string, landing: TaskLanding, childId?: string): void {
  // 写之前重读一遍再并上:两个窗口各拿着旧快照整份写回,后写的会抹掉先写的那条(Codex 10-23)
  recs = { ...load(), ...read(), [key]: { l: landing, t: Date.now(), ...(childId ? { c: childId } : {}) } }
  try { localStorage.setItem(KEY, JSON.stringify(recs)) } catch { /* 存不下就只活到应用关闭 */ }
  bump()
}
/** 处理记录一变就重渲(卡片堆据此把处理过的卡拿走)。 */
export function useTaskHandledVersion(): number {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f) } }, () => version)
}

/** 卡片堆里的一张任务卡。id 带消息 id 和卡序,只在这一屏里用来区分;判断处理过没用 doneKey。 */
export interface PendingTask { kind: 'task'; id: string; messageId: string; card: TaskCard; createdAt?: number; doneKey: string }

const tasksCache = new WeakMap<UiMessage, TaskCard[]>()
function tasksOf(m: UiMessage): TaskCard[] {
  let hit = tasksCache.get(m)
  if (!hit) { hit = m.content.includes('forsion-task') ? splitSuggestions(m.content, { kinds: ['task'] }).tasks : []; tasksCache.set(m, hit) }
  return hit
}

/** 会话里还在等你选的任务卡,按出现顺序。不收:流式中的、Muse 自己提的待办(origin proactive:todo,状态在服务端,
 *  另有一套)、撤回的、过 7 天的、处理过的。 */
export function pendingTaskCardsOf(list: UiMessage[] | undefined, sessionId: string, now = Date.now()): PendingTask[] {
  const done = (m: UiMessage): boolean => m.role === 'assistant' && m.status === 'done' && m.origin !== 'proactive:todo'
  const withdrawn = new Set<string>()
  for (const m of list || []) if (done(m)) for (const c of tasksOf(m)) if (c.withdraw) withdrawn.add(c.withdraw)
  const out: PendingTask[] = []
  for (const m of list || []) {
    if (!done(m)) continue
    if (m.timestamp && now - m.timestamp > TASK_CARD_TTL_MS) continue
    tasksOf(m).forEach((card, i) => {
      if (card.withdraw || (card.id && withdrawn.has(card.id))) return
      const doneKey = taskDoneKey(sessionId, card)
      if (taskHandled(doneKey)) return
      out.push({ kind: 'task', id: `task:${m.id}:${i}`, messageId: m.id, card, createdAt: m.timestamp || undefined, doneKey })
    })
  }
  return out
}
