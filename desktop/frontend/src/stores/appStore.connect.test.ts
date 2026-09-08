/**
 * connect 代数(2026-09-02 Codex 评审 #3):老 token 的 connectOnce 晚到的 401 不许盖掉新 token 已成功的 connState,
 * 也不许把 lastConnectAuthRejected 置真停掉 boot 的重试环。两条乱序场景都用 boot 真流程跑(managed、快照 ready、
 * 引擎带新 token 重启 = starting → ready 广播),testConnection 按 token 各给一个 deferred,手动控制完成顺序。
 * 负对照:去掉 connectOnce 里的 `if (!latest()) return` → ① connState 变 err、② 15s 后不再 connect。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ConnResult = { ok: boolean; message: string; authRejected?: boolean }
const deferreds = new Map<string, { resolve: (r: ConnResult) => void }>()
const testConnection = vi.fn((c: { backendUrl: string; token: string }) => new Promise<ConnResult>((resolve) => { deferreds.set(c.token, { resolve }) }))
vi.mock('../services/agentRunService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/agentRunService')>()),
  testConnection: (c: any) => testConnection(c),
}))

const { useApp, BOOT_RETRY_MS } = await import('./appStore')
const backendApi = await import('../services/backendService')
const initial = useApp.getState()

type St = { state: 'stopped' | 'starting' | 'ready' | 'crashed'; url: string | null; pid: number | null; lastError: string | null }
const ready: St = { state: 'ready', url: 'http://127.0.0.1:1', pid: 1, lastError: null }

/** 假 window.tangu(照 appStore.boot.test):cfg 可改 token 模拟引擎换 token 重启;广播只送给已注册监听器。 */
function arm() {
  const listeners = new Set<(st: St) => void>()
  const authListeners = new Set<() => void>()
  let status = ready
  const cfg = { mode: 'managed', backendUrl: 'http://127.0.0.1:1', token: 'old', modelId: '', backendState: { state: 'ready' } }
  const tangu = {
    getConfig: () => new Promise((r) => setTimeout(() => r({ ...cfg }), 0)),
    onBackendStatus: (cb: (st: St) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
    onAuthChanged: (cb: () => void) => { authListeners.add(cb); return () => authListeners.delete(cb) },
    backendStatus: () => Promise.resolve(status),
    authStatus: () => Promise.resolve(null),
    listProviders: () => Promise.resolve([]),
    envCheck: () => Promise.resolve({}),
  }
  ;(globalThis as any).window = { tangu }
  useApp.setState({ ...initial, tr: (k: string) => k, toast: () => {} }, true)
  return { cfg, broadcast: (st: St) => { status = st; listeners.forEach((cb) => cb(st)) }, broadcastAuth: () => authListeners.forEach((cb) => cb()) }
}
const tick = (ms = 5) => vi.advanceTimersByTimeAsync(ms)

/** boot(老 token 起一次 connect,挂起)→ 引擎带新 token 重启(starting → ready)→ 新 token 再起一次 connect(挂起)。 */
async function twoInFlight() {
  const { cfg, broadcast } = arm()
  const p = useApp.getState().boot()
  await tick(10)
  await p
  expect(testConnection).toHaveBeenCalledTimes(1)
  expect(deferreds.has('old')).toBe(true)
  cfg.token = 'new'
  broadcast({ ...ready, state: 'starting' })
  broadcast(ready)
  await tick(10)
  expect(testConnection).toHaveBeenCalledTimes(2)
  expect(deferreds.has('new')).toBe(true)
  return { broadcast }
}

describe('appStore.connect:代数只认最新', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    deferreds.clear()
    testConnection.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (globalThis as any).window
  })

  it('① 新 token 先成功、老 token 的 401 后到 → connState 仍是 ok(老结果作废)', async () => {
    await twoInFlight()
    deferreds.get('new')!.resolve({ ok: true, message: 'ok' })
    await tick()
    expect(useApp.getState().connState).toBe('ok')
    deferreds.get('old')!.resolve({ ok: false, message: '401', authRejected: true })
    await tick()
    expect(useApp.getState().connState).toBe('ok')
    expect(useApp.getState().connMessage).toBe('ok')
  })

  it('② 新 token 先 ECONNREFUSED、老 token 的 401 后到 → 重试环不被停:15s 后照样再 connect,连上即 ok', async () => {
    await twoInFlight()
    deferreds.get('new')!.resolve({ ok: false, message: 'ECONNREFUSED' })
    await tick()
    expect(useApp.getState().connState).toBe('err')
    deferreds.get('old')!.resolve({ ok: false, message: '401', authRejected: true })
    await tick()
    expect(useApp.getState().connMessage).toBe('ECONNREFUSED') // 老 401 没盖上来
    await tick(BOOT_RETRY_MS + 20)
    expect(testConnection).toHaveBeenCalledTimes(3) // 重试环活着(旧代码:老 401 把 lastConnectAuthRejected 置真 → 停)
    expect(testConnection.mock.calls[2][0].token).toBe('new')
    deferreds.get('new')!.resolve({ ok: true, message: 'ok' })
    await tick()
    expect(useApp.getState().connState).toBe('ok')
  })

  it('③ 正常顺序(老先回、新后回)不受影响:两次都按序落 state', async () => {
    await twoInFlight()
    deferreds.get('old')!.resolve({ ok: false, message: '401', authRejected: true })
    await tick()
    expect(useApp.getState().connState).toBe('idle') // 老代作废:starting 广播压下去的 idle 保持,不被老 401 顶成 err
    deferreds.get('new')!.resolve({ ok: true, message: 'ok' })
    await tick()
    expect(useApp.getState().connState).toBe('ok')
  })

  it('invalidates the old connection and pending catalog results as soon as auth changes', async () => {
    const { broadcastAuth, broadcast } = arm()
    const boot = useApp.getState().boot()
    await tick(10)
    await boot
    const localSession = { id: 'local-session', title: 'Local work' } as any
    useApp.setState({ sessions: [localSession], authInfo: { loggedIn: true, username: 'old' } as any })
    // Use a separate deferred for each call to complete both list branches after the boundary.
    const pending: Array<(value: any[]) => void> = []
    vi.spyOn(backendApi, 'listSessions').mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const refresh = useApp.getState().refreshSessions(useApp.getState().cfg)
    broadcast({ ...ready, state: 'starting' })
    broadcastAuth()
    expect(useApp.getState().authInfo).toBeNull()
    expect(useApp.getState().cfg.token).toBe('')
    expect(useApp.getState().sessions).toEqual([localSession])
    pending.forEach((resolve) => resolve([{ id: 'old-cloud-response' }] as any))
    await refresh
    deferreds.get('old')!.resolve({ ok: true, message: 'stale connected' })
    await tick()
    expect(useApp.getState().sessions).toEqual([localSession])
    expect(useApp.getState().connState).toBe('idle')
  })

  it.each([true, false])('reconnects when backend ready arrives before auth:changed = %s', async (readyFirst) => {
    const { cfg, broadcastAuth, broadcast } = arm()
    const boot = useApp.getState().boot()
    await tick(10)
    await boot
    cfg.token = 'new'
    broadcast({ ...ready, state: 'starting' })
    if (readyFirst) broadcast(ready)
    broadcastAuth()
    await tick(10)
    if (!readyFirst) {
      expect(useApp.getState().connState).toBe('idle')
      broadcast(ready)
      await tick(10)
    }
    expect(useApp.getState().cfg.token).toBe('new')
    deferreds.get('new')!.resolve({ ok: true, message: 'new connected' })
    deferreds.get('old')!.resolve({ ok: false, message: 'old 401', authRejected: true })
    await tick()
    expect(useApp.getState().connState).toBe('ok')
    expect(useApp.getState().connMessage).toBe('new connected')
  })
})
