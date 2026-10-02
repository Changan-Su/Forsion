/**
 * `client_cmd`(手机操控等客户端动作,契约 tangu-agent/docs/phone-control.md §3.1 / §5)在渲染层的早筛与转交。
 *
 * 钉三件事:
 *  ① 四道闸(not-owner / duplicate / stopped / no-surface)拦下的一律不 exec;
 *  ② 放行的只 exec 一次 —— 至少一次投递会把同一 ackId 换个新 seq 再送一遍;
 *  ③ **JS 永不回执**:每个用例都断言 sendUiAck 没被调(回执归原生,这是和 ui_cmd 的本质区别)。
 * 另有 endRun → onRunEnd、登出(非 managed 的 onAuthChanged)→ onReset。
 *
 * ⚠️ 模块级 Set(uiActionOwnedRuns / uiActionDoneAcks / stoppedRuns)不随 useApp.setState(initial) 复位 →
 *    每个用例用各自的 runId / ackId,需要归属的用例最后用终态事件走一遍 endRun 释放。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ stop: vi.fn(), steer: vi.fn(), ack: vi.fn(), testConnection: vi.fn() }))
vi.mock('../services/agentRunService', async (original) => ({
  ...await original<typeof import('../services/agentRunService')>(),
  abortRunAndWait: service.stop, steerRun: service.steer, sendUiAck: service.ack, testConnection: service.testConnection,
}))
import { useApp } from './appStore'
import { uiActionLog } from '../diag'
import { __resetClientSurfacesForTest, registerClientSurface, type ClientSurface } from '../services/clientSurfaces'

const initial = useApp.getState()
let seq = 0
const event = (runId: string, type: string, payload: any = {}) =>
  useApp.getState().reduceEvent('s', runId, { current: 'a' }, { seq: ++seq, type, payload })
const cmd = (runId: string, ackId: string, extra: Record<string, unknown> = {}) =>
  event(runId, 'client_cmd', { ackId, ns: 'phone', body: JSON.stringify({ v: 1, runId, ackId, ns: 'phone', op: 'view' }), ...extra })

let exec: ReturnType<typeof vi.fn>
let onRunEnd: ReturnType<typeof vi.fn>
let onReset: ReturnType<typeof vi.fn>
function phone(extra: Partial<ClientSurface> = {}): void {
  registerClientSurface('phone', { capabilities: () => ['phone.intents'], exec, onRunEnd, onReset, ...extra })
}

/** 让本窗口认领 runId(G2):run 在跑时发一句话 → steer 受理 = 归属转到本窗口(appStore send 的 steer 分支)。 */
async function own(runId: string): Promise<void> {
  useApp.setState({ runningBySession: { s: runId } })
  service.steer.mockResolvedValueOnce({ ok: true, userMessageId: `u-${runId}` })
  expect(await useApp.getState().send('go', [], undefined, undefined, undefined, 's')).toBe(true)
}
const drops = () => uiActionLog.filter((r) => r.kind === 'client').map((r) => r.drop ?? 'exec')

beforeEach(() => {
  vi.resetAllMocks()
  __resetClientSurfacesForTest()
  uiActionLog.length = 0
  exec = vi.fn(); onRunEnd = vi.fn(); onReset = vi.fn()
  vi.stubGlobal('window', { tangu: {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  useApp.setState(initial, true)
  useApp.setState({ activeId: 's', tr: (key) => key, toast: vi.fn(),
    messagesBySession: { s: [{ id: 'a', role: 'assistant', content: '', timestamp: 1, status: 'streaming' }] },
    stoppingBySession: {},
  })
})
afterEach(() => { useApp.setState(initial, true); __resetClientSurfacesForTest(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('client_cmd 早筛与转交', () => {
  it('本窗口发起的 run:转交给能力面一次,原样带 runId/ackId/body,且 JS 不回执', async () => {
    phone()
    await own('r-pass')
    cmd('r-pass', 'cc_pass')
    expect(exec).toHaveBeenCalledOnce()
    const body = JSON.stringify({ v: 1, runId: 'r-pass', ackId: 'cc_pass', ns: 'phone', op: 'view' })
    expect(exec).toHaveBeenCalledWith({ runId: 'r-pass', ackId: 'cc_pass', body })
    expect(drops()).toEqual(['exec'])
    expect(JSON.stringify(uiActionLog)).not.toContain('view') // diag 绝不记 body(可能含短信正文)
    expect(service.ack).not.toHaveBeenCalled()
    event('r-pass', 'error', { aborted: true })
  })

  it('同一 ackId 换新 seq 重放(至少一次投递)→ 只执行一次', async () => {
    phone()
    await own('r-replay')
    cmd('r-replay', 'cc_replay')
    cmd('r-replay', 'cc_replay')
    cmd('r-replay', 'cc_replay')
    expect(exec).toHaveBeenCalledOnce()
    expect(drops()).toEqual(['exec', 'duplicate', 'duplicate'])
    expect(service.ack).not.toHaveBeenCalled()
    event('r-replay', 'error', { aborted: true })
  })

  it('非本窗口发起的 run(别的设备 / 恢复订阅)→ 丢弃、不执行、不回执', () => {
    phone()
    useApp.setState({ runningBySession: { s: 'r-foreign' } })
    cmd('r-foreign', 'cc_foreign')
    expect(exec).not.toHaveBeenCalled()
    expect(drops()).toEqual(['not-owner'])
    expect(service.ack).not.toHaveBeenCalled()
  })

  it('用户已按停止 → 丢弃、不执行、不回执', async () => {
    phone()
    await own('r-stopped')
    service.stop.mockReturnValue(new Promise(() => {})) // 停止确认悬着:stoppedRuns 已落
    void useApp.getState().stop('s')
    cmd('r-stopped', 'cc_stopped')
    expect(exec).not.toHaveBeenCalled()
    expect(drops()).toEqual(['stopped'])
    expect(service.ack).not.toHaveBeenCalled()
  })

  it('本端没注册该能力面(desktop/web)→ 丢弃、不回执', async () => {
    await own('r-nosurface')
    cmd('r-nosurface', 'cc_nosurface')
    expect(drops()).toEqual(['no-surface'])
    expect(service.ack).not.toHaveBeenCalled()
    // 没执行就不占 ackId:之后能力面就位(极端时序)同一条仍可放行,真权威在原生 claim
    phone()
    cmd('r-nosurface', 'cc_nosurface')
    expect(exec).toHaveBeenCalledOnce()
    event('r-nosurface', 'error', { aborted: true })
  })

  it('畸形载荷(缺 ackId / body 非字符串 / 缺 ns)→ 丢弃', async () => {
    phone()
    await own('r-bad')
    event('r-bad', 'client_cmd', { ns: 'phone', body: '{}' })
    cmd('r-bad', 'cc_bad1', { body: { v: 1 } })
    cmd('r-bad', 'cc_bad2', { ns: '' })
    expect(exec).not.toHaveBeenCalled()
    expect(drops()).toEqual(['no-ackId', 'invalid', 'invalid'])
    event('r-bad', 'error', { aborted: true })
  })

  it('能力面 exec 抛错(同步或异步)不炸事件流,记进 diag', async () => {
    exec.mockImplementationOnce(() => { throw new Error('bridge gone') }).mockRejectedValueOnce(new Error('native reject'))
    phone()
    await own('r-throw')
    expect(() => cmd('r-throw', 'cc_throw1')).not.toThrow()
    cmd('r-throw', 'cc_throw2')
    await vi.waitFor(() => expect(drops()).toEqual(['exec', 'exception', 'exec', 'exception']))
    expect(uiActionLog.filter((r) => r.drop === 'exception').map((r) => r.error)).toEqual(['bridge gone', 'native reject'])
    expect(service.ack).not.toHaveBeenCalled()
    event('r-throw', 'error', { aborted: true })
  })
})

describe('能力面生命周期', () => {
  it('run 终结(endRun)→ onRunEnd(runId)', async () => {
    phone()
    await own('r-end')
    event('r-end', 'error', { aborted: true })
    expect(onRunEnd).toHaveBeenCalledWith('r-end')
    expect(onReset).not.toHaveBeenCalled()
    // 终结后 G2 已释放:即便 reducer 的 running 闸被绕过(重新订阅同一 run),迟到的指令也不再转交
    useApp.setState({ runningBySession: { s: 'r-end' } })
    cmd('r-end', 'cc_late')
    expect(exec).not.toHaveBeenCalled()
    expect(drops()).toEqual(['not-owner'])
  })

  /** 照 appStore.boot.test 的假桥:boot 注册 onAuthChanged,broadcastAuth() 摹登出 / 换号。 */
  async function bootWith(mode: 'managed' | 'external'): Promise<() => void> {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    service.testConnection.mockResolvedValue({ ok: false, message: 'offline' })
    const authListeners = new Set<() => void>()
    const cfg = { mode, backendUrl: 'http://127.0.0.1:1', token: 'tok', modelId: '', backendState: { state: 'ready' } }
    vi.stubGlobal('window', { tangu: {
      getConfig: () => Promise.resolve({ ...cfg }),
      onBackendStatus: () => () => {},
      onAuthChanged: (cb: () => void) => { authListeners.add(cb); return () => authListeners.delete(cb) },
      backendStatus: () => Promise.resolve({ state: 'ready', url: cfg.backendUrl, pid: 1, lastError: null }),
      authStatus: () => Promise.resolve(null),
    } })
    const p = useApp.getState().boot()
    await vi.advanceTimersByTimeAsync(10)
    await p
    return () => authListeners.forEach((cb) => cb())
  }

  it('登出 / 鉴权重置(非 managed:run 被直接 abort、不走 endRun)→ onReset', async () => {
    phone()
    const broadcastAuth = await bootWith('external')
    expect(onReset).not.toHaveBeenCalled()
    broadcastAuth()
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('managed 的鉴权变化不中止 run → 不发 onReset(run 照常经 endRun 收尾)', async () => {
    phone()
    const broadcastAuth = await bootWith('managed')
    broadcastAuth()
    expect(onReset).not.toHaveBeenCalled()
  })
})
