// P1-K9 · 事件流被 hub 半截掐断后的续订(INTEGRATION §4 G1「>1h 流续订」的 CI 半;全链路在 scripts/stream-renew.check.cjs)。
// 生产上一条经 hub 的事件流有两道时限(设备上行的 1h requestTimeout、15min 空闲),都以 client.destroy() 收场 —— 渲染层读到的是
// 流读到一半抛错(不是干净收尾)。钉三件事:
//   ① 连续 8 次半截断开(越过 subscribeRunEvents 的 6 次失败上限)照样续订到终态,不抛;
//   ② 每次续订都带上已见到的最大 seq 作 fromSeq,单调前进;
//   ③ 回调收到的事件 seq 恰好 1..N 各一次(不丢、不重)。
//   ④(M1B)续订时引擎 / hub 从更早处回放(fromSeq 被改回 0):已见过的 seq 丢掉,回调仍是 1..N 各一次。
// 负对照(K9 交付时实跑、未入库):把 subscribeRunEvents 读流中断那条路改成「计一次失败、续订成功也不清零」→ ① 两条都红(第 7 次断开就抛)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Reply = { status: number; body?: BodyInit; headers?: Record<string, string> }
let router: (url: string) => Reply = () => ({ status: 500 })
const calls: string[] = []
vi.mock('./http', () => ({
  authFetch: async (url: string) => {
    calls.push(url)
    const r = router(url)
    return new Response(r.body ?? '', { status: r.status, headers: r.headers })
  },
}))

const run = await import('./agentRunService')
const T = await import('./engine/targets')
const H = await import('./engine/health')

const U = '7f0e8a52-0000-4000-8000-00000000000b'
const API = 'https://api.forsion.test/api'
const home = { backendUrl: 'http://127.0.0.1:4100', token: 'engine-token', modelId: '' }
const frame = (seq: number, type = 'token'): string => `data: ${JSON.stringify({ seq, type, payload: { delta: `[${seq}]` } })}\n\n`

/** 一段事件流:吐 frames,然后要么半截断开(error,带一截没发完的帧 —— 同 hub destroy 时缓冲里的残段),要么干净结束。 */
function stream(frames: string[], abrupt: boolean): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  // 残段:被掐在一帧中间,这截绝不能被当成事件。⚠️ 必须逐块 pull:controller.error() 会丢掉队列里还没读的块(规范如此)
  const chunks = [...frames, ...(abrupt ? ['data: {"seq":99999,"ty'] : [])]
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) { c.enqueue(enc.encode(chunks[i++])); return }
      if (abrupt) c.error(new TypeError('network error'))
      else c.close()
    },
  })
}

/** 引擎语义:回放 seq > fromSeq 的事件,每条连接最多吐 perConn 帧就被掐;最后一帧 done。 */
function engineWithCuts(total: number, perConn: number) {
  return (url: string): Reply => {
    if (!url.includes('/events')) return { status: 200, body: '{}' }
    const from = Number(/fromSeq=(\d+)/.exec(url)?.[1] || 0)
    const seqs: number[] = []
    for (let s = from + 1; s <= total && seqs.length < perConn; s++) seqs.push(s)
    const frames = seqs.map((s) => frame(s, s === total ? 'done' : 'token'))
    const done = seqs.includes(total)
    return { status: 200, body: stream(frames, !done), headers: { 'Content-Type': 'text/event-stream' } }
  }
}

/** 回放不认 fromSeq 的「引擎」(hub 把 fromSeq 改回 0 / 设备重连后从头重放):每条连接从 seq 1 吐到 fromSeq + perConn 就被掐。 */
function engineReplayingFromZero(total: number, perConn: number) {
  return (url: string): Reply => {
    if (!url.includes('/events')) return { status: 200, body: '{}' }
    const from = Number(/fromSeq=(\d+)/.exec(url)?.[1] || 0)
    const upto = Math.min(total, from + perConn)
    const frames = Array.from({ length: upto }, (_, i) => frame(i + 1, i + 1 === total ? 'done' : 'token'))
    return { status: 200, body: stream(frames, upto < total), headers: { 'Content-Type': 'text/event-stream' } }
  }
}

beforeEach(() => {
  calls.length = 0
  vi.useFakeTimers()
  H.resetHealth()
  T.resetFocusForTests()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function drive(cfg: Parameters<typeof run.subscribeRunEvents>[0], total: number, perConn: number, engine = engineWithCuts) {
  router = engine(total, perConn)
  const seqs: number[] = []
  let settled: unknown = 'pending'
  const ac = new AbortController()
  const p = run.subscribeRunEvents(cfg, 'r-renew', (ev) => { seqs.push(ev.seq) }, ac.signal)
  p.then(() => { settled = 'ok' }, (e) => { settled = e })
  for (let i = 0; i < 40 && settled === 'pending'; i++) await vi.advanceTimersByTimeAsync(900)
  ac.abort() // 没到终态的(失败时)收掉,别让它挂到下一条用例
  const fromSeqs = calls.filter((u) => u.includes('/events')).map((u) => Number(/fromSeq=(\d+)/.exec(u)?.[1]))
  return { settled, seqs, fromSeqs }
}

describe('subscribeRunEvents × hub 半截断流(P1-K9)', () => {
  it('home 目标:连续 8 次半截断开 → 按 fromSeq 续订到 done,不丢不重、不抛', async () => {
    const r = await drive(T.connectionTarget(home), 36, 4) // 36 帧、每连接 4 帧 → 8 次断开 + 1 次收尾
    expect(r.settled).toBe('ok')
    expect(r.fromSeqs).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32])
    expect(r.seqs).toEqual(Array.from({ length: 36 }, (_, i) => i + 1))
  })

  it('unit 目标(手机经 hub):同样续订,健康不记错', async () => {
    vi.stubGlobal('window', { tangu: { mobile: true }, addEventListener: () => {}, removeEventListener: () => {} })
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: 'forsion-token', modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    const r = await drive(t, 36, 4)
    expect(r.settled).toBe('ok')
    expect(r.fromSeqs).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32])
    expect(r.seqs).toEqual(Array.from({ length: 36 }, (_, i) => i + 1))
    expect(H.healthOf(t.key).state).toBe('ready')
  })

  it('M1B:续订时从更早处回放(fromSeq 被改回 0)→ 按 seq 丢掉已见过的事件,回调 1..N 各一次', async () => {
    const r = await drive(T.connectionTarget(home), 36, 4, engineReplayingFromZero)
    expect(r.settled).toBe('ok')
    expect(r.fromSeqs).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32])
    expect(r.seqs).toEqual(Array.from({ length: 36 }, (_, i) => i + 1))
  })
})
