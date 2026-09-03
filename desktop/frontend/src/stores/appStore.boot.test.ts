/**
 * P0-a:boot 的 ready 事件缺口 + managed 自动重连(2026-09-02)。
 *   ① 引擎 ready 广播落在 boot 的 `await getConfig()` 期间 → 监听器必须已注册,connState 仍到 ok
 *      (旧代码在 await 之后才注册,广播丢失,快照 starting 永远停在「后端启动中」);
 *   ② 引导判定的 authStatus/listProviders 不阻塞 boot 的 resolve;
 *   ③ managed 且引擎 ready 但 connState≠ok → 15s 一次只 connect,上限 8 次;非 managed 不重试。
 * window.tangu 用假桥:广播像真 IPC 一样「没人订阅就丢」,这样负对照(把注册挪回 await 之后)真会红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testConnection = vi.fn<(c: { backendUrl: string; token: string }) => Promise<{ ok: boolean; message: string; authRejected?: boolean }>>()
vi.mock('../services/agentRunService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/agentRunService')>()),
  testConnection: (c: any) => testConnection(c),
}))

const { useApp, BOOT_RETRY_MAX, BOOT_RETRY_MS } = await import('./appStore')
const initial = useApp.getState()

type St = { state: 'stopped' | 'starting' | 'ready' | 'crashed'; url: string | null; pid: number | null; lastError: string | null }
const ready: St = { state: 'ready', url: 'http://127.0.0.1:1', pid: 1, lastError: null }

/** 假 window.tangu:getConfig 延迟 resolve;broadcast() 只送给当下已注册的监听器(没人订阅就丢,与真 IPC 同)。 */
function arm(opts: { mode?: 'managed' | 'external'; snapshot?: St['state']; getConfigDelayMs?: number; status?: St; listProvidersNever?: boolean }) {
  const listeners = new Set<(st: St) => void>()
  const cfg = { mode: opts.mode ?? 'managed', backendUrl: 'http://127.0.0.1:1', token: 'tok', modelId: '', backendState: { state: opts.snapshot ?? 'starting' } }
  const tangu = {
    getConfig: () => new Promise((r) => setTimeout(() => r(cfg), opts.getConfigDelayMs ?? 0)),
    onBackendStatus: (cb: (st: St) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
    backendStatus: () => Promise.resolve(opts.status ?? ready),
    authStatus: () => Promise.resolve(null),
    listProviders: () => (opts.listProvidersNever ? new Promise(() => {}) : Promise.resolve([])),
    envCheck: () => Promise.resolve({}),
  }
  ;(globalThis as any).window = { tangu }
  useApp.setState({ ...initial, tr: (k: string) => k, toast: () => {} }, true)
  return { broadcast: (st: St) => listeners.forEach((cb) => cb(st)), listeners }
}

/** 假桥的 getConfig 走 setTimeout(0):fake timers 下必须推一下时钟 boot 才会 resolve。 */
async function bootNow(): Promise<void> {
  const p = useApp.getState().boot()
  await vi.advanceTimersByTimeAsync(10)
  await p
}

describe('appStore.boot:ready 广播缺口 + managed 重连', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    testConnection.mockReset()
    testConnection.mockResolvedValue({ ok: true, message: 'ok' })
    // connect 后面的 listSessions/listModels… 全走 fetch:离线即拒,各自有 catch
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    // 引导判定分支读 localStorage:node 里没有它会 ReferenceError 被外层 try 吞掉 → ② 假绿(负对照不翻红),所以必须打桩
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (globalThis as any).window
  })

  it('① ready 广播落在 getConfig 的 await 期间 → 仍到 ok(监听器在 await 之前就注册)', async () => {
    const { broadcast, listeners } = arm({ snapshot: 'starting', getConfigDelayMs: 50 })
    const p = useApp.getState().boot()
    expect(listeners.size).toBe(1) // 同步注册:还没等到 getConfig 就已经在听
    await vi.advanceTimersByTimeAsync(10)
    broadcast(ready) // 落在 await 缝里
    await vi.advanceTimersByTimeAsync(100)
    await p
    await vi.waitFor(() => expect(useApp.getState().connState).toBe('ok'))
    expect(testConnection).toHaveBeenCalledTimes(1)
  })

  it('①b 广播在没人订阅时发出 → 确实丢(假桥忠实于 IPC,负对照有效性的前提)', () => {
    const { broadcast, listeners } = arm({})
    expect(listeners.size).toBe(0)
    broadcast(ready)
    expect(useApp.getState().connState).toBe('idle')
  })

  it('①c 快照 ready + 回放 ready 同时到 → 同一 (url,token) 只 connect 一次', async () => {
    const { broadcast } = arm({ snapshot: 'ready' })
    const p = useApp.getState().boot()
    broadcast(ready) // 模拟 preload 的注册即回放
    await vi.advanceTimersByTimeAsync(20)
    await p
    await vi.waitFor(() => expect(useApp.getState().connState).toBe('ok'))
    expect(testConnection).toHaveBeenCalledTimes(1)
  })

  it('② listProviders 永不 resolve,boot 照样 resolve(引导判定不阻塞)', async () => {
    arm({ snapshot: 'ready', listProvidersNever: true })
    let done = false
    void useApp.getState().boot().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(50)
    expect(done).toBe(true)
  })

  it('③ managed:引擎 ready 但首连失败 → 15s 后重连,连上即停', async () => {
    testConnection.mockResolvedValueOnce({ ok: false, message: 'ECONNREFUSED' }).mockResolvedValueOnce({ ok: false, message: 'ECONNREFUSED' })
    arm({ snapshot: 'ready' })
    await bootNow()
    expect(useApp.getState().connState).toBe('err')
    expect(testConnection).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS + 10)
    expect(testConnection).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS + 10)
    expect(testConnection).toHaveBeenCalledTimes(3)
    expect(useApp.getState().connState).toBe('ok')
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS * 3)
    expect(testConnection).toHaveBeenCalledTimes(3) // 连上就不再打
  })

  it('③b 一直失败 → 最多重试 8 次后停;starting 期不打', async () => {
    testConnection.mockResolvedValue({ ok: false, message: 'ECONNREFUSED' })
    arm({ snapshot: 'ready' })
    await bootNow()
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS * (BOOT_RETRY_MAX + 5))
    expect(testConnection).toHaveBeenCalledTimes(1 + BOOT_RETRY_MAX)
    // 引擎自报 starting:重试轮到了也不 connect(打过去必拒,会把「启动中」顶成「错误」)
    testConnection.mockClear()
    const { broadcast } = arm({ snapshot: 'starting', status: { ...ready, state: 'starting' } })
    await bootNow()
    broadcast({ ...ready, state: 'starting' })
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS * 3)
    expect(testConnection).not.toHaveBeenCalled()
    expect(useApp.getState().connState).toBe('idle')
  })

  it('③d 探针 401(authRejected)→ 重试环停:15s×3 内 testConnection 只叫 1 次;ready 广播后重新给机会', async () => {
    testConnection.mockResolvedValue({ ok: false, message: '401', authRejected: true })
    const { broadcast } = arm({ snapshot: 'ready' })
    await bootNow()
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS * 3 + 30)
    expect(testConnection).toHaveBeenCalledTimes(1)
    expect(useApp.getState().connState).toBe('err')
    // 引擎带新 token 重启:starting → ready 广播 → 再连一次(不是永久禁连)
    testConnection.mockResolvedValue({ ok: true, message: 'ok' })
    broadcast({ ...ready, state: 'starting' })
    broadcast(ready)
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(useApp.getState().connState).toBe('ok'))
    expect(testConnection).toHaveBeenCalledTimes(2)
  })

  it('③c 非 managed 不重试', async () => {
    testConnection.mockResolvedValue({ ok: false, message: 'ECONNREFUSED' })
    arm({ mode: 'external', snapshot: 'ready' })
    await bootNow()
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS * 3)
    expect(testConnection).toHaveBeenCalledTimes(1)
  })
})
