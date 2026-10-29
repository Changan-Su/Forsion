/**
 * 「到时提醒我」的定时器(只在主窗跑，Root 装一次):到点先查额度、确认回来才弹主窗通知卡(应用在后台时 notifyApp 顺带发系统通知)。
 * 卡片「继续」= 打开那个会话、重发失败的那一轮。会话删了 / 那一轮已经不是失败的最后一轮(重试过、丢弃了、接着聊成了)→ 不叫，直接删掉提醒。
 */
import { translate } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { notifyApp } from '../../stores/notificationStore'
import { getModelQuota, listMessages } from '../../services/backendService'
import { targetForSession } from '../../services/engine/targets'
import { openSession } from '../../sessionNav'
import { GIVE_UP_AFTER_MS, nextCheckAt, quotaIsBack, sameReminder, useQuotaReminders, type QuotaReminder } from '../../tangu/store/quotaReminders'

export type CheckResult = 'back' | 'wait' | 'gone'
export const CHECK_TIMEOUT_MS = 30_000

export interface SchedulerDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(h: unknown): void
  check(r: QuotaReminder): Promise<CheckResult>
  fire(r: QuotaReminder): void
}

/** 纯调度:每个会话一个定时器;提醒被删 / 换了就重排。测试用假时钟直接驱动它。 */
export function createReminderScheduler(deps: SchedulerDeps) {
  const timers = new Map<string, { h: unknown; r: QuotaReminder; attempt: number }>()
  const arm = (r: QuotaReminder, attempt: number) => {
    const at = nextCheckAt(r.resetAt, attempt, deps.now())
    const h = deps.setTimer(() => void run(r, attempt), at - deps.now())
    timers.set(r.sessionId, { h, r, attempt })
  }
  const drop = (r: QuotaReminder) => { timers.delete(r.sessionId); useQuotaReminders.getState().cancel(r.sessionId) }
  const run = async (r: QuotaReminder, attempt: number) => {
    // 过期先判(重启时早已过了 24 小时的，别再弹一张迟到的卡)
    if (deps.now() - r.resetAt > GIVE_UP_AFTER_MS) { drop(r); return }
    let res: CheckResult = 'wait'
    // 查一次最多等 CHECK_TIMEOUT_MS:引擎那头挂住不回，也要接着退避，不能卡死这条提醒
    try { res = await Promise.race([deps.check(r), new Promise<CheckResult>((ok) => deps.setTimer(() => ok('wait'), CHECK_TIMEOUT_MS))]) } catch { /* 读失败 = 还不知道 */ }
    const cur = timers.get(r.sessionId)
    if (!cur || !sameReminder(cur.r, r)) return // 等结果期间被取消 / 换掉了
    if (res === 'back') { drop(r); deps.fire(r); return }
    if (res === 'gone') { drop(r); return }
    arm(r, attempt + 1)
  }
  const sync = (items: Record<string, QuotaReminder>) => {
    for (const [sid, t] of timers) if (!sameReminder(items[sid], t.r)) { deps.clearTimer(t.h); timers.delete(sid) }
    for (const r of Object.values(items)) if (!timers.has(r.sessionId)) arm(r, 0)
  }
  sync(useQuotaReminders.getState().items)
  const unsub = useQuotaReminders.subscribe((s) => sync(s.items))
  return { stop: () => { unsub(); for (const t of timers.values()) deps.clearTimer(t.h); timers.clear() }, pending: () => timers.size }
}

/** 失败的那一轮还在、还是最后一轮。会话没了(404)= gone。 */
async function stillFailed(sessionId: string): Promise<boolean | 'gone'> {
  try {
    const list = await listMessages(targetForSession(sessionId), sessionId, 20)
    const last = [...list].reverse().find((m) => m.role !== 'user' && m.role !== 'system') // 落库的回答 role 是 model / assistant
    return !!last?.is_error
  } catch (e: any) {
    if (e?.status === 404) return 'gone'
    throw e
  }
}

async function check(r: QuotaReminder): Promise<CheckResult> {
  const failed = await stillFailed(r.sessionId)
  if (failed !== true) return 'gone'
  const { quota } = await getModelQuota(targetForSession(r.sessionId), r.modelId)
  return quotaIsBack(quota, r.resetAt) ? 'back' : 'wait'
}

/** 打开会话，等消息载进来，重发最后那条失败的回答(就是错误条上的「重试」)。 */
function continueTurn(sessionId: string) {
  openSession(sessionId)
  // 只认「最后一条回答是失败的」:主窗缓存里可能还是更早那条成功的(失败发生在别的窗口),等载进来再重发
  const retry = () => {
    const list = useApp.getState().messagesBySession[sessionId]
    const failed = list && [...list].reverse().find((m) => m.role === 'assistant')
    if (failed?.status !== 'error') return false
    useApp.getState().regenerate(failed.id, sessionId)
    return true
  }
  if (retry()) return
  const unsub = useApp.subscribe(() => { if (retry()) { unsub(); clearTimeout(stop) } })
  const stop = setTimeout(unsub, 15_000)
}

function fire(r: QuotaReminder) {
  notifyApp({
    title: translate('quotaRemind.cardTitle', { provider: r.provider }),
    text: translate('quotaRemind.cardText', { session: r.title }),
    level: 'info', event: 'quota.reminder', sticky: true, dedupeKey: `quota-reminder:${r.sessionId}`,
    action: { label: translate('quotaRemind.continue'), run: () => continueTurn(r.sessionId) },
  })
}

let started: ReturnType<typeof createReminderScheduler> | null = null
/** 幂等:主窗 Root 装一次。 */
export function startQuotaReminders(): void {
  if (started) return
  started = createReminderScheduler({ now: Date.now, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), check, fire })
}
