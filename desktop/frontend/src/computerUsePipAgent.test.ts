/** Computer Use 悬浮小画面里的停止 / 状态:pip 窗自己的 store 里没有这一轮,经主进程转给跑着它的窗口。
 *  这里把三段真代码串起来(pip 端 client → 主进程 relay → 宿主窗口 servePipAgent + 真 tanguProbe 读写主窗 store),
 *  只把 IPC 换成同步函数调用。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }))
import { createPipAgentClient, pipTargetKey, type PipAgentBridge } from './computerUsePipAgent'
import { servePipAgent, type PipAgentHostBridge } from './computerUsePipHost'
import { createPipAgentRelay } from '../../electron/computerUsePip'
import { readAgentStatus, stopAgentRun, subscribeAgentStatus } from './tanguProbe'
import { useApp } from './stores/appStore'
import type { UiMessage } from './types'
import './tangu/store/standalone'

const T0 = 7_000_000
const user = (id: string): UiMessage => ({ id, role: 'user', content: 'hi', status: 'done', timestamp: T0 })
const asst = (id: string): UiMessage => ({ id, role: 'assistant', content: '', status: 'streaming', timestamp: T0 + 1 })

/** 一扇「主窗」(真 store)+ 主进程 relay + 一扇 pip(只有 client,没有 store)。 */
function wire() {
  let onRequest: ((req: { id?: number; op: string; key?: string; target?: unknown }) => void) | null = null
  let pipListener: ((key: string, status: unknown) => void) | null = null
  const relay = createPipAgentRelay({
    hosts: () => [{ id: 1, main: true, send: (_c, payload) => onRequest?.(payload as never) }],
    toPip: (key, status) => pipListener?.(key, status),
  })
  const hostBridge: PipAgentHostBridge = {
    ready: () => relay.hostReady(1),
    onRequest: (cb) => { onRequest = cb; return () => { onRequest = null } },
    reply: (id, value) => relay.reply(1, id, value),
    status: (key, status) => relay.status(1, key, status),
  }
  const unserve = servePipAgent(hostBridge, { read: readAgentStatus, subscribe: subscribeAgentStatus, stop: stopAgentRun })
  const pipBridge: PipAgentBridge = {
    stop: (target) => relay.stop(target),
    watch: (key, target) => relay.watch(key, target),
    unwatch: (key) => relay.unwatch(key),
    onStatus: (cb) => { pipListener = cb; return () => { pipListener = null } },
  }
  return { client: createPipAgentClient(pipBridge), relay, unserve }
}

describe('悬浮小画面里的 ctx.tangu.stop / agentStatus 作用到主窗那一轮', () => {
  const stopSpy = vi.fn(async (_sid?: string | null) => true)
  let realStop: unknown
  beforeEach(() => {
    realStop = useApp.getState().stop
    stopSpy.mockClear()
    useApp.setState({
      stop: stopSpy, activeId: 's2',
      messagesBySession: { s1: [user('u1'), asst('a1')], s2: [user('u2'), asst('a2')] },
      runningBySession: { s1: 'r1', s2: 'r2' },
      stoppingBySession: {}, runStatsBySession: {}, llmRetryBySession: {}, groupVoting: {},
    } as never)
  })
  afterEach(() => { useApp.setState({ stop: realStop } as never) })

  it('stop({ runId }) 停的是主窗里跑这个 run 的会话;不命中回 false、不停别人', async () => {
    const { client, unserve } = wire()
    await expect(client.stop({ runId: 'r1' })).resolves.toBe(true)
    expect(stopSpy).toHaveBeenCalledExactlyOnceWith('s1')
    stopSpy.mockClear()
    await expect(client.stop({ runId: 'gone' })).resolves.toBe(false)
    await expect(client.stop({ runId: undefined })).resolves.toBe(false)
    expect(stopSpy).not.toHaveBeenCalled()
    unserve()
  })

  it('subscribe({ runId }) 收到主窗那一轮的状态,run 结束时回 idle;退订后主窗那份订阅也撤掉', async () => {
    const { client, relay, unserve } = wire()
    const seen: Array<{ phase: string; runId: string | null; sessionId: string | null }> = []
    const off = client.subscribe((s) => seen.push({ phase: s.phase, runId: s.runId, sessionId: s.sessionId }), { runId: 'r1' })
    // 订阅时主窗先推一份当前的:pip 那边看到的是 s1 在跑 r1(pip 自己的 store 里根本没有它)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ runId: 'r1', sessionId: 's1' })
    expect(seen[0].phase).not.toBe('idle')
    expect(client.read({ runId: 'r1' })).toMatchObject({ runId: 'r1', sessionId: 's1' })
    useApp.setState({ runningBySession: { s2: 'r2' } } as never)
    expect(seen.at(-1)).toMatchObject({ phase: 'idle', runId: null })
    off()
    expect(relay.watchCount()).toBe(0)
    unserve()
  })

  it('read() 第一次没缓存回 idle 并拉起订阅,之后同步读到主窗推来的快照', () => {
    const { client, unserve } = wire()
    // 同步桥:watch 当场就推回了快照,所以第一次 read 已经命中
    expect(client.read({ runId: 'r2' })).toMatchObject({ runId: 'r2', sessionId: 's2' })
    expect(client.read()).toMatchObject({ sessionId: 's2' }) // 不传 = 主窗的当前会话
    unserve()
  })
})

describe('createPipAgentClient(假桥)', () => {
  function fake() {
    const calls: string[] = []
    let push: ((key: string, status: unknown) => void) | null = null
    const bridge: PipAgentBridge = {
      stop: vi.fn(async () => true),
      watch: (key) => calls.push(`watch ${key}`),
      unwatch: (key) => calls.push(`unwatch ${key}`),
      onStatus: (cb) => { push = cb; return () => {} },
    }
    return { client: createPipAgentClient(bridge), calls, push: (k: string, s: unknown) => push!(k, s), bridge }
  }
  const st = (phase: string, runId: string | null) => ({ phase, runId, sessionId: runId ? 's' : null, since: 0, textChars: 0, reasoningChars: 0 })

  it('没推到之前 read 回 idle;只在 statusKey 变了时回调;坏载荷丢掉', () => {
    const { client, calls, push } = fake()
    expect(client.read({ runId: 'r' })).toMatchObject({ phase: 'idle', runId: null })
    expect(calls).toEqual(['watch o:r:r'])
    const cb = vi.fn()
    client.subscribe(cb, { runId: 'r' })
    expect(calls).toEqual(['watch o:r:r']) // 已经在订,不重复
    push('o:r:r', st('tool', 'r'))
    push('o:r:r', st('tool', 'r'))
    push('o:r:r', { nope: true })
    push('other', st('tool', 'x'))
    expect(cb).toHaveBeenCalledTimes(1)
    expect(client.read({ runId: 'r' })).toMatchObject({ phase: 'tool', runId: 'r' })
  })
  it('read 拉起的订阅一直留着;只有 subscribe 拉起的在最后一个退订时撤', () => {
    const { client, calls } = fake()
    const off = client.subscribe(() => {}, 's1')
    off(); off()
    expect(calls).toEqual(['watch s:s1', 'unwatch s:s1'])
    client.read('s2')
    const off2 = client.subscribe(() => {}, 's2')
    off2()
    expect(calls.slice(2)).toEqual(['watch s:s2'])
  })
  it('stop 只认 true;桥抛错回 false', async () => {
    const { client, bridge } = fake()
    ;(bridge.stop as ReturnType<typeof vi.fn>).mockResolvedValueOnce('yes').mockRejectedValueOnce(new Error('x'))
    await expect(client.stop({ runId: 'r' })).resolves.toBe(false)
    await expect(client.stop({ runId: 'r' })).resolves.toBe(false)
  })
  it('目标键与对象键序无关', () => {
    expect(pipTargetKey({ sessionId: 'a', runId: 'b' })).toBe(pipTargetKey({ runId: 'b', sessionId: 'a' }))
    expect(pipTargetKey(undefined)).toBe('active')
    expect(pipTargetKey({})).toBe('active')
    expect(pipTargetKey(null)).toBe('draft')
  })

  it('read 拉起的被动订阅可淘汰:第 17 个以后的目标照样能订上,最久没读的先退,一直在读的不退', () => {
    const { client, calls, push } = fake()
    for (let i = 0; i < 20; i++) {
      client.read({ runId: `r${i}` })
      client.read({ runId: 'hot' }) // 每帧都在读的那个
    }
    expect(calls.filter((c) => c.startsWith('watch'))).toContain('watch o:r:r19')
    expect(calls).toContain('unwatch o:r:r0')
    expect(calls).not.toContain('unwatch o:r:hot')
    push('o:r:r19', st('tool', 'r19'))
    expect(client.read({ runId: 'r19' })).toMatchObject({ phase: 'tool', runId: 'r19' })
    // 有人订着的不因淘汰退订
    const off = client.subscribe(() => {}, { runId: 'sub' })
    for (let i = 0; i < 20; i++) client.read({ runId: `x${i}` })
    expect(calls).not.toContain('unwatch o:r:sub')
    off()
  })
  it('按 run 读的目标:见过在跑、再回到 idle(runId 为 null)就释放;首份 idle 不算', () => {
    const { client, calls, push } = fake()
    client.read({ runId: 'r' })
    push('o:r:r', st('idle', null)) // 还没跑起来
    expect(calls).not.toContain('unwatch o:r:r')
    push('o:r:r', st('tool', 'r'))
    push('o:r:r', st('idle', null)) // 这一轮结束
    expect(calls).toContain('unwatch o:r:r')
    expect(client.read({ runId: 'r' })).toMatchObject({ phase: 'idle', runId: null })
    expect(calls.filter((c) => c === 'watch o:r:r')).toHaveLength(2) // 再读会重新订
  })
})

describe('servePipAgent 的停止', () => {
  it('这一轮就在本窗:先回「已接手」,停完再回结果;不在本窗不说', async () => {
    let onReq: ((r: { id?: number; op: string; target?: unknown }) => void) | null = null
    const replies: Array<[number, unknown]> = []
    const running = { phase: 'tool', sessionId: 's1', runId: 'r1', since: 0, textChars: 0, reasoningChars: 0 } as const
    let resolveStop!: (v: boolean) => void
    servePipAgent({ ready: () => {}, onRequest: (cb) => { onReq = cb as never; return () => {} }, reply: (id, v) => replies.push([id, v]), status: () => {} }, {
      read: (t) => (t && typeof t === 'object' && t.runId === 'r1' ? running : { ...running, phase: 'idle', runId: null }) as never,
      subscribe: () => () => {},
      stop: () => new Promise((r) => { resolveStop = r }),
    })
    onReq!({ id: 1, op: 'stop', target: { runId: 'r1' } })
    expect(replies).toEqual([[1, 'accepted']])
    resolveStop(true)
    await Promise.resolve(); await Promise.resolve()
    expect(replies).toEqual([[1, 'accepted'], [1, true]])
    onReq!({ id: 2, op: 'stop', target: { runId: 'other' } })
    expect(replies.filter(([id]) => id === 2)).toEqual([])
  })
})
