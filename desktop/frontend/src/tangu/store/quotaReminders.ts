/**
 * 额度用完后「到时提醒我」(借鉴 magpie 第三轮第 20 条,方案 A,docs/ToBeImproved/借鉴magpie方案_2026-10-28/round3.html):
 * 一个会话最多挂一个提醒，记在本机 localStorage(重启还在，几个窗口靠 storage 事件同步)。
 * 这里只有数据与定时规则，不引 appStore(tanguSlice 的重试要调 cancel,反向引用会成环);
 * 到点去查额度、弹卡片的是 views/chat2/quotaReminderScheduler.ts。
 */
import { create } from 'zustand'

export interface QuotaReminder {
  sessionId: string
  /** 额度用完的那个模型(查它所属来源的额度)。 */
  modelId: string
  /** 来源报的重置时刻(ms)。 */
  resetAt: number
  /** 卡片标题里的来源名(「Codex 订阅 · 额度回来了」)。 */
  provider: string
  /** 卡片正文里的会话名;设提醒那一刻的标题。 */
  title: string
}

const KEY = 'forsion.quotaReminders'
const read = (): Record<string, QuotaReminder> => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
const write = (items: Record<string, QuotaReminder>) => { try { localStorage.setItem(KEY, JSON.stringify(items)) } catch { /* 存不了:这次进程里照样提醒 */ } }

interface QuotaReminderState {
  items: Record<string, QuotaReminder>
  /** 同一会话再设一次是替换，不叠加。 */
  set(r: QuotaReminder): void
  cancel(sessionId: string): void
}

export const useQuotaReminders = create<QuotaReminderState>((set, get) => ({
  items: read(),
  // 每次改都从 localStorage 现读一份再改(读-改-写):别的窗口刚写进去的不会被这个窗口手里的旧快照盖掉
  set: (r) => { const items = { ...read(), [r.sessionId]: r }; write(items); set({ items }) },
  cancel: (sessionId) => {
    const items = read()
    if (!items[sessionId] && !get().items[sessionId]) return
    delete items[sessionId]
    write(items); set({ items })
  },
}))

/** 同一条提醒:storage 事件重读会换出新对象，按值比，别把退避次数清零。 */
export const sameReminder = (a: QuotaReminder | undefined, b: QuotaReminder | undefined): boolean =>
  !!a && !!b && a.sessionId === b.sessionId && a.modelId === b.modelId && a.resetAt === b.resetAt

// 只认真浏览器窗口:单测会把 window 换成空对象再 import 本模块(notificationWiring.test),那时没有 addEventListener
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('storage', (e) => { if (e.key === KEY) useQuotaReminders.setState({ items: read() }) })

export const cancelQuotaReminder = (sessionId: string) => useQuotaReminders.getState().cancel(sessionId)

/** 照 magpie quota wait:重置后 30 秒查第一次，没回来按 1 / 2 / 4 / 8 / 10 分钟退避，之后每 10 分钟。attempt 从 0 数。 */
const BACKOFF_MIN = [1, 2, 4, 8, 10]
export function nextCheckAt(resetAt: number, attempt: number, now: number): number {
  if (attempt === 0) return Math.max(now, resetAt + 30_000)
  return now + BACKOFF_MIN[Math.min(attempt, BACKOFF_MIN.length) - 1] * 60_000
}
/** ponytail: 重置后 24 小时还没确认回来就放弃这条提醒(来源一直读不到 / 一直满着),不无限查下去。 */
export const GIVE_UP_AFTER_MS = 24 * 3600_000

/** 额度回来了 = 读到的是重置之后的数(引擎缓存 5 分钟，旧缓存不算)且每个窗口都没满。读不到 / 没有窗口 = 不知道。 */
export function quotaIsBack(q: { fetchedAt: number; windows?: Array<{ usedPercent: number }> } | null | undefined, resetAt: number): boolean {
  return !!q && q.fetchedAt >= resetAt && !!q.windows?.length && q.windows.every((w) => w.usedPercent < 100)
}

/** 设提醒时用的重置时刻:先认报错里的,没有再用额度显示里满了的那个窗口的;都没有 = 不出按钮(不猜)。 */
export function reminderResetAt(errorResetAt: number | undefined, windows: Array<{ usedPercent: number; resetAt?: number }> | undefined, now: number): number | undefined {
  if (errorResetAt && errorResetAt > now) return errorResetAt
  const full = windows?.filter((w) => w.usedPercent >= 100 && (w.resetAt ?? 0) > now).map((w) => w.resetAt!) ?? []
  return full.length ? Math.max(...full) : undefined
}
