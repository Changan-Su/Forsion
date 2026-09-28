/**
 * 主进程审批送达(P1 · K3 §3.5):假 SSE(流式 Response,测试手推帧)+ 假通知 + 手动时钟。
 *   远程 added 弹 / 本机 added 不弹 / 同会话 30s 内合并 / removed 关闭(S9:中止 → expired 也关)/ 快照对账 /
 *   引擎重启退避重连、快照清零 / 引擎非 ready → idle 且通知全关 / 404 停用 /
 *   60s 投递(body 只有 {sessionId,count,kinds})/ 10 分钟冷却 / 通道未连不投 / 429 记冷却 / 点击调 openSession /
 *   S5 通知不含命令 / 参数 / 调用方标签先看 callerUnit(名字清洗后为空 → 「已登记设备」,K1 评审缺口)。
 * 负对照(实跑见红,记在 K3 交付报告):去掉 onAdded 里的 `if (!it.remote) return` → 「本机 added 不弹」红;
 *   bodyOf 改用 preview → S5 红;escalate 去掉「按剩下最老一条重新计时」→ 「A 先答、B 才等 10s」红。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createApprovalDelivery, ESCALATE_AFTER_MS, ESCALATE_COOLDOWN_MS, RENOTIFY_AFTER_MS, type ApprovalDeliveryDeps, type PendingPromptWire } from './approvalDelivery'
import { mtFor } from './mainI18n'

const SID = '9f40ad71-5e6c-4d8f-9021-3c4d5e6f7081'
const SID2 = '0a51be82-6f7d-4e90-8132-4d5e6f708192'
const UNIT = '6c1d7a4e-2b3f-4a5c-8d9e-0f1a2b3c4d5e'
const REMOTE = { via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: 'Pixel 9' }
let seq = 0
const item = (over: Partial<PendingPromptWire> & Record<string, unknown> = {}): PendingPromptWire => ({
  id: `apv_${++seq}`, kind: 'approval', runId: 'R1', sessionId: SID, sessionTitle: '部署生产', tool: 'run_bash', localOnly: false,
  remote: REMOTE, createdAt: new Date().toISOString(), ...over,
} as PendingPromptWire)

/** 手动时钟:setTimeout 进队列,advance 时按时刻顺序跑到期的(回调里再排的也算)。 */
function clock() {
  let t = 1_000_000
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number): unknown => { const h = ++id; timers.set(h, { at: t + ms, fn }); return h },
    clearTimeout: (h: unknown): void => { timers.delete(h as number) },
    async advance(ms: number): Promise<void> {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = due[1].at
        due[1].fn()
        await flush()
      }
      t = end
      await flush()
    },
    pending: () => timers.size,
  }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

interface Stream { push(frame: unknown): void; end(): void }
function harness(opts: { creds?: boolean; streamStatus?: number } = {}) {
  const c = clock()
  const enc = new TextEncoder()
  const streams: Stream[] = []
  const posts: { url: string; init: RequestInit }[] = []
  const notes: { title: string; body: string; closed: boolean; click?: () => void }[] = []
  const opened: string[] = []
  const logs: string[] = []
  let engine: { url: string | null; token: string } = { url: 'http://127.0.0.1:4100', token: 'local-tok' }
  let statusCb: ((ready: boolean) => void) | null = null
  let postStatus = 200
  let streamStatus = opts.streamStatus ?? 200
  let creds: ReturnType<ApprovalDeliveryDeps['unitCreds']> = opts.creds === false ? null
    : { cloudUrl: 'https://api.forsion.test/', token: 'forsion-tok', unitId: 'unit-mac', secret: 'dev-secret' }
  const streamUrls: string[] = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/agent/approvals/stream')) {
      streamUrls.push(url)
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${engine.token}`)
      expect(Object.keys(init.headers as object).some((k) => k.toLowerCase().startsWith('x-forsion-remote'))).toBe(false)
      if (streamStatus !== 200) return new Response('{}', { status: streamStatus })
      let ctl!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start(k) { ctl = k } })
      init.signal?.addEventListener('abort', () => { try { ctl.error(new Error('aborted')) } catch { /* closed */ } })
      ctl.enqueue(enc.encode(': open\n\n'))
      streams.push({ push: (f) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`)), end: () => { try { ctl.close() } catch { /* */ } } })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    posts.push({ url, init })
    return new Response('{"ok":true}', { status: postStatus })
  }) as unknown as typeof fetch
  const d = createApprovalDelivery({
    getEngine: () => engine,
    onEngineStatus: (cb) => { statusCb = cb; return () => { statusCb = null } },
    unitCreds: () => creds,
    t: (k, v) => mtFor('en', k, v),
    notify: (o) => {
      const n: { title: string; body: string; closed: boolean; click?: () => void } = { ...o, closed: false }
      notes.push(n)
      return { close: () => { n.closed = true }, onClick: (cb) => { n.click = cb } }
    },
    openSession: (sid) => opened.push(sid),
    log: (m) => logs.push(m),
    fetch: fetchImpl,
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
  })
  return {
    d, c, streams, posts, notes, opened, logs, streamUrls,
    open: () => notes.filter((n) => !n.closed),
    setEngine: (e: typeof engine) => { engine = e },
    status: (ready: boolean) => statusCb?.(ready),
    setCreds: (v: typeof creds) => { creds = v },
    setPostStatus: (s: number) => { postStatus = s },
    setStreamStatus: (s: number) => { streamStatus = s },
    last: () => streams[streams.length - 1],
  }
}
async function started(h: ReturnType<typeof harness>, items: PendingPromptWire[] = []): Promise<void> {
  h.d.start()
  await flush()
  h.last().push({ type: 'snapshot', rev: 'b:1', items })
  await flush()
}

beforeEach(() => { seq = 0 })

describe('通知', () => {
  it('远程 added → 弹一条(标题带调用方设备名、正文带会话标题与工具);点击 → openSession', async () => {
    const h = harness()
    await started(h)
    h.last().push({ type: 'added', rev: 'b:2', item: item() })
    await flush()
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toMatchObject({ title: 'Remote session from Pixel 9 needs your approval', body: '“部署生产” wants to use run_bash. Click to review.' })
    h.notes[0].click?.()
    expect(h.opened).toEqual([SID])
  })

  it('本机 run 的 added 不弹(渲染层托盘负责),但 pending() 里有', async () => {
    const h = harness()
    await started(h)
    h.last().push({ type: 'added', rev: 'b:2', item: item({ remote: null }) })
    await flush()
    expect(h.notes).toEqual([])
    expect(h.d.pending()).toHaveLength(1)
  })

  it('S5 通知不含命令 / 参数 / preview(流里本就没有;有也不用)', async () => {
    const h = harness()
    await started(h)
    h.last().push({ type: 'added', rev: 'b:2', item: item({ preview: '$ rm -rf ~/', arguments: '{"command":"rm -rf ~/"}' } as any) })
    await flush()
    const text = `${h.notes[0].title}\n${h.notes[0].body}`
    expect(text).not.toMatch(/rm -rf|command/)
  })

  it('调用方标签先看 callerUnit:有名字 → 名字;名字清洗后为空 → 已登记设备;没有 callerUnit → 未识别;只有询问 → 询问文案', async () => {
    const h = harness()
    await started(h)
    h.last().push({ type: 'added', rev: 'b:2', item: item({ sessionId: SID, remote: { via: 'tunnel', callerUnit: UNIT, callerKind: 'phone' } }) })
    h.last().push({ type: 'added', rev: 'b:3', item: item({ sessionId: SID2, sessionTitle: null, kind: 'inquiry', tool: null, remote: { via: 'lan' } }) })
    await flush()
    expect(h.notes.map((n) => n.title)).toEqual(['A remote session from a registered device needs your approval', 'A remote session has a question for you'])
    expect(h.notes[1].body).toBe('“Untitled session” is waiting for your answer. Click to review.')
    expect(mtFor('zh', 'main.approvalDelivery.approvalTitle', { device: 'Pixel 9' })).toBe('Pixel 9 上的远程会话等你批准')
  })

  it('同会话 30s 内的第二条只记数;30s 后的新一条 → 关旧弹新(bodyMany);另一会话各弹各的', async () => {
    const h = harness()
    await started(h)
    h.last().push({ type: 'added', rev: 'b:2', item: item() })
    await flush()
    await h.c.advance(5_000)
    h.last().push({ type: 'added', rev: 'b:3', item: item() })
    await flush()
    expect(h.notes).toHaveLength(1)
    await h.c.advance(RENOTIFY_AFTER_MS)
    h.last().push({ type: 'added', rev: 'b:4', item: item() })
    await flush()
    expect(h.notes).toHaveLength(2)
    expect(h.notes[0].closed).toBe(true)
    expect(h.notes[1].body).toBe('“部署生产” has 3 items waiting for you. Click to review.')
    h.last().push({ type: 'added', rev: 'b:5', item: item({ sessionId: SID2 }) })
    await flush()
    expect(h.open()).toHaveLength(2)
  })

  it('removed(对方先答 / 中止 expired,S9):会话清空才关通知;还剩的不重弹', async () => {
    const h = harness()
    await started(h)
    const a = item()
    const b = item()
    h.last().push({ type: 'added', rev: 'b:2', item: a })
    h.last().push({ type: 'added', rev: 'b:3', item: b })
    await flush()
    h.last().push({ type: 'removed', rev: 'b:4', id: a.id, sessionId: SID, outcome: 'approved', by: { via: 'tunnel' } })
    await flush()
    expect(h.open()).toHaveLength(1)
    expect(h.notes).toHaveLength(1)
    h.last().push({ type: 'removed', rev: 'b:5', id: b.id, sessionId: SID, outcome: 'expired' })
    await flush()
    expect(h.open()).toEqual([])
    expect(h.d.pending()).toEqual([])
  })

  it('快照对账:快照里没有的下架(关通知),快照里新出现的远程条目照 added 弹', async () => {
    const h = harness()
    const gone = item()
    await started(h, [gone])
    expect(h.open()).toHaveLength(1)
    h.last().end() // 引擎重启:流断
    await flush()
    await h.c.advance(1_000) // 退避 1s 重连
    expect(h.streams).toHaveLength(2)
    const fresh = item({ sessionId: SID2 })
    h.last().push({ type: 'snapshot', rev: 'c:1', items: [fresh] })
    await flush()
    expect(h.notes.find((n) => n.closed === false)?.body).toContain('部署生产')
    expect(h.open()).toHaveLength(1)
    expect(h.d.pending().map((p) => p.id)).toEqual([fresh.id])
  })
})

describe('连接', () => {
  it('断开 → 1s、2s、4s 退避;拿到快照清零', async () => {
    const h = harness()
    await started(h)
    h.last().end(); await flush()
    await h.c.advance(999); expect(h.streams).toHaveLength(1)
    await h.c.advance(1); expect(h.streams).toHaveLength(2)
    h.last().end(); await flush()
    await h.c.advance(1_999); expect(h.streams).toHaveLength(2)
    await h.c.advance(1); expect(h.streams).toHaveLength(3)
    h.last().push({ type: 'snapshot', rev: 'x:1', items: [] }); await flush()
    h.last().end(); await flush()
    await h.c.advance(1_000); expect(h.streams).toHaveLength(4)
  })

  it('读空闲 45s(连心跳都没有)→ 断开重连', async () => {
    const h = harness()
    await started(h)
    await h.c.advance(45_000)
    await h.c.advance(1_000)
    expect(h.streams).toHaveLength(2)
    expect(h.logs.some((l) => l.includes('45s'))).toBe(true)
  })

  it('引擎非 ready → idle 且通知全关、定时器撤;再 ready → 重连(用新地址 / 新令牌)', async () => {
    const h = harness()
    await started(h, [item()])
    expect(h.open()).toHaveLength(1)
    h.setEngine({ url: null, token: 'local-tok' })
    h.status(false)
    await flush()
    expect(h.open()).toEqual([])
    await h.c.advance(ESCALATE_AFTER_MS + 60_000)
    expect(h.posts).toEqual([])
    expect(h.streams).toHaveLength(1)
    h.setEngine({ url: 'http://127.0.0.1:4200', token: 'tok-2' })
    h.status(true)
    await flush()
    expect(h.streamUrls.at(-1)).toBe('http://127.0.0.1:4200/agent/approvals/stream')
  })

  it('404(老引擎)→ 停用、不退避重试;引擎状态再变(重启 / 升级)才再试', async () => {
    const h = harness({ streamStatus: 404 })
    h.d.start(); await flush()
    await h.c.advance(120_000)
    expect(h.streamUrls).toHaveLength(1)
    h.setStreamStatus(200)
    h.status(true); await flush()
    expect(h.streamUrls).toHaveLength(2)
  })

  it('stop():断流、关通知、不再重连', async () => {
    const h = harness()
    await started(h, [item()])
    h.d.stop(); await flush()
    expect(h.open()).toEqual([])
    await h.c.advance(120_000)
    expect(h.streams).toHaveLength(1)
  })
})

describe('投收件箱', () => {
  it('远程待批 60s 没人答 → POST {cloud}/api/units/:id/attention,头带 forsion_token + 设备密钥,body 只有 {sessionId,count,kinds}', async () => {
    const h = harness()
    await started(h)
    h.last().push({ type: 'added', rev: 'b:2', item: item() })
    h.last().push({ type: 'added', rev: 'b:3', item: item({ kind: 'plan', tool: null }) })
    await flush()
    await h.c.advance(ESCALATE_AFTER_MS - 1)
    expect(h.posts).toEqual([])
    await h.c.advance(1)
    expect(h.posts).toHaveLength(1)
    const p = h.posts[0]
    expect(p.url).toBe('https://api.forsion.test/api/units/unit-mac/attention')
    expect(p.init.headers).toMatchObject({ Authorization: 'Bearer forsion-tok', 'X-Unit-Secret': 'dev-secret' })
    expect(JSON.parse(String(p.init.body))).toEqual({ sessionId: SID, count: 2, kinds: ['approval', 'inquiry'] })
    expect(String(p.init.body)).not.toContain('部署生产')
  })

  it('60s 内被答掉 → 不投', async () => {
    const h = harness()
    await started(h)
    const a = item()
    h.last().push({ type: 'added', rev: 'b:2', item: a }); await flush()
    await h.c.advance(30_000)
    h.last().push({ type: 'removed', rev: 'b:3', id: a.id, sessionId: SID, outcome: 'approved' }); await flush()
    await h.c.advance(ESCALATE_AFTER_MS)
    expect(h.posts).toEqual([])
  })

  it('计时按剩下里最老的一条:A 在 0s、B 在 50s 到,A 在 55s 被答 → 60s 不投(B 才等了 10s),B 等满 60s(110s)才投、count=1', async () => {
    const h = harness()
    await started(h)
    const a = item()
    h.last().push({ type: 'added', rev: 'b:2', item: a }); await flush()
    await h.c.advance(50_000)
    h.last().push({ type: 'added', rev: 'b:3', item: item({ kind: 'inquiry', tool: null }) }); await flush()
    await h.c.advance(5_000)
    h.last().push({ type: 'removed', rev: 'b:4', id: a.id, sessionId: SID, outcome: 'approved' }); await flush()
    await h.c.advance(5_000) // t = 60s:原定时器到点
    expect(h.posts).toEqual([])
    await h.c.advance(ESCALATE_AFTER_MS - 10_000 - 1) // t = 110s - 1ms
    expect(h.posts).toEqual([])
    await h.c.advance(1)
    expect(h.posts).toHaveLength(1)
    expect(JSON.parse(String(h.posts[0].init.body))).toEqual({ sessionId: SID, count: 1, kinds: ['inquiry'] })
  })

  it('同会话 10 分钟冷却:答完又来一条 → 60s 后不再投;冷却过了才投', async () => {
    const h = harness()
    await started(h)
    const a = item()
    h.last().push({ type: 'added', rev: 'b:2', item: a }); await flush()
    await h.c.advance(ESCALATE_AFTER_MS)
    expect(h.posts).toHaveLength(1)
    h.last().push({ type: 'removed', rev: 'b:3', id: a.id, sessionId: SID, outcome: 'approved' }); await flush()
    h.last().push({ type: 'added', rev: 'b:4', item: item() }); await flush()
    await h.c.advance(ESCALATE_AFTER_MS)
    expect(h.posts).toHaveLength(1)
    await h.c.advance(ESCALATE_COOLDOWN_MS)
    h.last().push({ type: 'added', rev: 'b:5', item: item() }); await flush()
    await h.c.advance(ESCALATE_AFTER_MS)
    expect(h.posts).toHaveLength(2)
  })

  it('设备通道未连 → 不投(只记日志);429 → 记冷却,不重试', async () => {
    const h = harness({ creds: false })
    await started(h)
    h.last().push({ type: 'added', rev: 'b:2', item: item() }); await flush()
    await h.c.advance(ESCALATE_AFTER_MS)
    expect(h.posts).toEqual([])
    expect(h.logs.some((l) => l.includes('通道未连'))).toBe(true)

    const h2 = harness()
    h2.setPostStatus(429)
    await started(h2)
    const a = item()
    h2.last().push({ type: 'added', rev: 'b:2', item: a }); await flush()
    await h2.c.advance(ESCALATE_AFTER_MS)
    expect(h2.posts).toHaveLength(1)
    h2.last().push({ type: 'removed', rev: 'b:3', id: a.id, sessionId: SID, outcome: 'approved' }); await flush()
    h2.last().push({ type: 'added', rev: 'b:4', item: item() }); await flush()
    await h2.c.advance(ESCALATE_AFTER_MS)
    expect(h2.posts).toHaveLength(1)
  })

  it('本机 run 的待批永不投(K3 U2)', async () => {
    const h = harness()
    await started(h)
    h.last().push({ type: 'added', rev: 'b:2', item: item({ remote: null }) }); await flush()
    await h.c.advance(ESCALATE_AFTER_MS * 3)
    expect(h.posts).toEqual([])
  })
})
