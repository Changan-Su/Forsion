// @vitest-environment happy-dom
/**
 * 「到时提醒我」:定时规则(重置后 30 秒,再按 1 / 2 / 4 / 8 / 10 分钟退避)、「回来了」的判定(旧缓存不算)、
 * 一个会话只挂一个、取消 / 会话没了不叫、只叫一次。假时钟驱动纯调度器，不碰真引擎。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReminderScheduler, type CheckResult } from './quotaReminderScheduler'
import { nextCheckAt, quotaIsBack, reminderResetAt, useQuotaReminders, type QuotaReminder } from '../../tangu/store/quotaReminders'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 28, 10, 0, 0)

describe('规则', () => {
  it('第一次查在重置后 30 秒，之后 1 / 2 / 4 / 8 / 10 / 10 分钟', () => {
    expect(nextCheckAt(T0 + 60 * MIN, 0, T0)).toBe(T0 + 60 * MIN + 30_000)
    expect(nextCheckAt(T0 - MIN, 0, T0)).toBe(T0) // 重启时已经过了点:立刻查
    expect([1, 2, 3, 4, 5, 6].map((a) => (nextCheckAt(0, a, T0) - T0) / MIN)).toEqual([1, 2, 4, 8, 10, 10])
  })

  it('回来了 = 重置之后读到的、每个窗口都没满;读不到 / 旧缓存 / 没窗口都不算', () => {
    const reset = T0
    expect(quotaIsBack(null, reset)).toBe(false)
    expect(quotaIsBack({ fetchedAt: reset - 1, windows: [{ usedPercent: 3 }] }, reset)).toBe(false)
    expect(quotaIsBack({ fetchedAt: reset + 1, windows: [{ usedPercent: 0 }, { usedPercent: 100 }] }, reset)).toBe(false)
    expect(quotaIsBack({ fetchedAt: reset + 1, windows: [] }, reset)).toBe(false)
    expect(quotaIsBack({ fetchedAt: reset + 1, windows: [{ usedPercent: 0 }, { usedPercent: 62 }] }, reset)).toBe(true)
  })

  it('重置时刻先认报错里的，再认满了的窗口;都没有就不出按钮', () => {
    const w = [{ usedPercent: 100, resetAt: T0 + 90 * MIN }, { usedPercent: 40, resetAt: T0 + 5 * 24 * 60 * MIN }]
    expect(reminderResetAt(T0 + 30 * MIN, w, T0)).toBe(T0 + 30 * MIN)
    expect(reminderResetAt(T0 - MIN, w, T0)).toBe(T0 + 90 * MIN) // 报错里的已经过了
    expect(reminderResetAt(undefined, [{ usedPercent: 40, resetAt: T0 + MIN }], T0)).toBeUndefined()
    expect(reminderResetAt(undefined, undefined, T0)).toBeUndefined()
  })
})

describe('调度', () => {
  let results: CheckResult[]
  let checks: number[]
  let fired: string[]
  let sched: ReturnType<typeof createReminderScheduler>
  const rem = (sid: string, resetAt = T0 + 60 * MIN): QuotaReminder => ({ sessionId: sid, modelId: 'codex/gpt-6-luna', resetAt, provider: 'Codex', title: '周报数据汇总' })
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(T0)
    localStorage.clear(); useQuotaReminders.setState({ items: {} })
    results = []; checks = []; fired = []
    sched = createReminderScheduler({
      now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as any),
      check: async () => { checks.push((Date.now() - T0) / 1000); const r = results.shift() ?? 'wait'; if (r === ('throw' as any)) throw new Error('offline'); return r },
      fire: (r) => fired.push(r.sessionId),
    })
  })
  afterEach(() => { sched.stop(); vi.useRealTimers() })

  it('到点先查，没回来就退避;回来了只叫一次、提醒随即删掉', async () => {
    results = ['wait', 'throw' as any, 'wait', 'back']
    useQuotaReminders.getState().set(rem('s1'))
    await vi.advanceTimersByTimeAsync(60 * MIN + 29_000); await flush()
    expect(checks).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(checks).toEqual([3630])
    await vi.advanceTimersByTimeAsync(1 * MIN); await flush() // 读失败 = 还不知道，接着退避
    await vi.advanceTimersByTimeAsync(2 * MIN); await flush()
    await vi.advanceTimersByTimeAsync(4 * MIN); await flush()
    expect(checks).toEqual([3630, 3690, 3810, 4050])
    expect(fired).toEqual(['s1'])
    expect(useQuotaReminders.getState().items.s1).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60 * MIN); await flush()
    expect(checks.length).toBe(4)
    expect(fired).toEqual(['s1'])
  })

  it('同一会话再点一次是替换，不叠加;取消了就不查也不叫', async () => {
    useQuotaReminders.getState().set(rem('s1'))
    useQuotaReminders.getState().set(rem('s1', T0 + 90 * MIN))
    expect(sched.pending()).toBe(1)
    await vi.advanceTimersByTimeAsync(61 * MIN); await flush()
    expect(checks).toEqual([]) // 旧的那个定时器已经撤了
    useQuotaReminders.getState().cancel('s1')
    await vi.advanceTimersByTimeAsync(60 * MIN); await flush()
    expect([checks, fired, sched.pending()]).toEqual([[], [], 0])
  })

  it('会话删了 / 那一轮重试过了(check 报 gone):不叫，提醒删掉', async () => {
    results = ['gone']
    useQuotaReminders.getState().set(rem('s2'))
    await vi.advanceTimersByTimeAsync(61 * MIN); await flush()
    expect([checks.length, fired, useQuotaReminders.getState().items.s2]).toEqual([1, [], undefined])
  })

  it('查询挂住不回:最多等 30 秒就当没回来，照常退避', async () => {
    sched.stop()
    let calls = 0
    sched = createReminderScheduler({ now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as any), check: () => { calls++; return new Promise<CheckResult>(() => {}) }, fire: (r) => fired.push(r.sessionId) })
    useQuotaReminders.getState().set(rem('s4'))
    await vi.advanceTimersByTimeAsync(60 * MIN + 30_000); await flush()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000 + MIN); await flush()
    expect([calls, fired]).toEqual([2, []])
  })

  it('别的窗口写了一下(storage 重读出新对象，值没变):不把退避清零', async () => {
    useQuotaReminders.getState().set(rem('s5'))
    await vi.advanceTimersByTimeAsync(60 * MIN + 30_000); await flush()
    expect(checks.length).toBe(1)
    useQuotaReminders.setState({ items: JSON.parse(JSON.stringify(useQuotaReminders.getState().items)) })
    await vi.advanceTimersByTimeAsync(30_000); await flush()
    expect(checks.length).toBe(1) // 下一次仍在 +1 分钟，不是立刻
    await vi.advanceTimersByTimeAsync(30_000); await flush()
    expect(checks.length).toBe(2)
  })

  it('重启时早过了 24 小时:不查也不叫，直接删掉', async () => {
    useQuotaReminders.getState().set(rem('s6', T0 - 25 * 60 * MIN))
    results = ['back']
    await vi.advanceTimersByTimeAsync(0); await flush()
    expect([checks, fired, useQuotaReminders.getState().items.s6]).toEqual([[], [], undefined])
  })

  it('重启后从 localStorage 接回来:已经过了点的立刻查', async () => {
    sched.stop()
    useQuotaReminders.getState().set(rem('s3', T0 - 10 * MIN))
    results = ['back']
    sched = createReminderScheduler({ now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as any), check: async () => { checks.push(0); return results.shift() ?? 'wait' }, fire: (r) => fired.push(r.sessionId) })
    await vi.advanceTimersByTimeAsync(0); await flush()
    expect(fired).toEqual(['s3'])
  })
})
