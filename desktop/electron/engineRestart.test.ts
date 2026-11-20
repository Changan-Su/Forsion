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

// 评审 #4:修订号 + 进行中的重启。假的 ensureBackend 照 main.ts 的样子:开头 cancel()、登记 track()、等旧进程退出、
// 读配置前 markCovered()、再读配置 / 拉起。这里自己发起的重启也走它(开头的 cancel 不能把修订号和进行中的那次清掉)。
describe('engine restart: changes a running restart already carries are not restarted for again', () => {
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r }); return { p, open } }
  let probe: ReturnType<typeof vi.fn>
  let exit: ReturnType<typeof gate>
  let read: ReturnType<typeof gate>
  let running = 0
  let overlapped = false
  let restarts = 0
  let d: ReturnType<typeof createDeferredRestart>
  const ensureBackend = (): Promise<void> => {
    d.cancel()
    const p = (async () => {
      restarts++
      if (running++) overlapped = true
      await exit.p // 旧进程退出(最多 5s)
      d.markCovered()
      await read.p // 读配置 / 拉起新引擎
      running--
    })()
    d.track(p)
    return p
  }
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  beforeEach(() => {
    probe = vi.fn(async (): Promise<EngineBusy> => 'idle')
    exit = gate(); read = gate()
    running = 0; overlapped = false; restarts = 0
    d = createDeferredRestart({ probe, restart: () => ensureBackend() })
  })

  it('a provider saved while the old engine is still exiting rides along with the restart already under way', async () => {
    const r1 = d.request()
    await flush()
    expect(restarts).toBe(1)
    const r2 = d.request() // 第一次重启还在等旧进程退出时又存了一个提供方
    exit.open(); read.open()
    await Promise.all([r1, r2]); await flush()
    expect(restarts).toBe(1)
    expect(probe).toHaveBeenCalledOnce()
  })

  it('a change saved after the restart read its config gets exactly one follow-up, after the first one is done', async () => {
    void d.request()
    await flush()
    exit.open(); await flush() // 已 markCovered,正在读配置 / 拉起
    const later = [d.request(), d.request(), d.request()] // 读完配置之后又存了三笔
    await flush()
    expect(restarts).toBe(1) // 不和进行中的那次并发
    const second = { exit: gate(), read: gate() }
    const first = { read }
    exit = second.exit; read = second.read
    first.read.open()
    await flush()
    expect(restarts).toBe(2)
    second.exit.open(); second.read.open()
    await Promise.all(later); await flush()
    expect(restarts).toBe(2) // 三笔合成一次
    expect(overlapped).toBe(false)
  })

  it('a deferred request during an immediate restart (restart button, sign-in) is carried by it', async () => {
    void ensureBackend() // 立即重启,不经调度器
    await flush()
    const r = d.request() // 读配置之前存的
    exit.open(); read.open()
    await r; await flush()
    expect(restarts).toBe(1)
    expect(probe).not.toHaveBeenCalled()
  })

  it('a pending wait whose change a later restart carried does not restart again on the next poll', async () => {
    vi.useFakeTimers()
    try {
      probe.mockResolvedValueOnce('busy')
      await d.request() // 有任务在跑:等
      expect(d.isPending()).toBe(true)
      // 别的路已经重启过一次、把这笔带上了(没经 cancel 也一样:轮询只看修订号)
      d.markCovered()
      await vi.advanceTimersByTimeAsync(RESTART_POLL_MS)
      expect(restarts).toBe(0)
      expect(d.isPending()).toBe(false)
    } finally { vi.useRealTimers() }
  })
})
