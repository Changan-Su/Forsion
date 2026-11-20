import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeferredRestart, RESTART_POLL_MS, type EngineBusy } from './engineRestart'

// 中断任务续跑方案 B 6.6:改设置引起的引擎重启,有任务在跑就等任务结束再重启;调用方不挂住。
describe('engine restart deferred until running tasks finish', () => {
  let states: EngineBusy[]
  let probe: ReturnType<typeof vi.fn>
  let restart: ReturnType<typeof vi.fn>
  let onDeferred: ReturnType<typeof vi.fn>
  const make = () => createDeferredRestart({ probe, restart, onDeferred })
  beforeEach(() => {
    vi.useFakeTimers()
    states = []
    probe = vi.fn(async () => states.shift() ?? 'idle')
    restart = vi.fn(async () => {})
    onDeferred = vi.fn()
  })
  afterEach(() => { vi.useRealTimers() })

  it('restarts right away when the engine is idle, down or its status is unknown', async () => {
    for (const s of ['idle', 'down', 'unknown'] as const) {
      restart.mockClear(); states = [s]
      await make().request()
      expect(restart).toHaveBeenCalledOnce()
    }
    restart.mockClear(); probe.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await make().request() // 问不到 = unknown:不能当「有任务」一直等下去
    expect(restart).toHaveBeenCalledOnce()
    expect(onDeferred).not.toHaveBeenCalled()
  })

  it('returns at once while tasks run, then restarts on the first idle poll', async () => {
    states = ['busy', 'busy', 'idle']
    const d = make()
    await d.request() // 不挂住调用方
    expect(restart).not.toHaveBeenCalled()
    expect(onDeferred).toHaveBeenCalledOnce()
    expect(d.isPending()).toBe(true)
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS)
    expect(restart).not.toHaveBeenCalled() // 第二次问还忙
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS)
    expect(restart).toHaveBeenCalledOnce()
    expect(d.isPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS * 3)
    expect(probe).toHaveBeenCalledTimes(3) // 重启之后不再问
  })

  it('restarts right away if the engine goes down or stops answering while waiting', async () => {
    for (const s of ['down', 'unknown'] as const) {
      restart.mockClear(); states = ['busy', s]
      const d = make()
      await d.request()
      await vi.advanceTimersByTimeAsync(RESTART_POLL_MS)
      expect(restart).toHaveBeenCalledOnce()
    }
  })

  it('coalesces repeated requests into one wait and one restart', async () => {
    states = ['busy', 'busy', 'idle']
    const d = make()
    await Promise.all([d.request(), d.request()]) // 同一刻的两次共用第一次询问
    await d.request(); await d.request() // 等待期间再来的
    expect(onDeferred).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS * 2)
    expect(restart).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('an immediate restart (or quitting) absorbs the pending one', async () => {
    states = ['busy', 'idle']
    const d = make()
    await d.request()
    d.cancel()
    expect(d.isPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS * 3)
    expect(restart).not.toHaveBeenCalled()
    // 之后的新请求照常
    states = ['idle']
    await d.request()
    expect(restart).toHaveBeenCalledOnce()
  })

  it('a cancel that lands while the first probe is in flight wins', async () => {
    let answer!: (s: EngineBusy) => void
    probe.mockImplementationOnce(() => new Promise<EngineBusy>((r) => { answer = r }))
    const d = make()
    const asked = d.request()
    d.cancel()
    answer('idle')
    await asked
    expect(restart).not.toHaveBeenCalled()
  })
})
