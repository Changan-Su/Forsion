// @vitest-environment happy-dom
/**
 * 会话列表「等你处理」点的数据源(P1 · K3 §3.7):mergeAttention / rev 短路 / 404 禁用目标 / 离线保留旧值 / 未连接不拉 /
 * 隐藏暂停、回前台立即拉 / install 幂等 / 多目标汇总 / 本地签名只随计数变。
 * 负对照(实跑见红,记在 K3 交付报告):mergeAttention 不让订阅着的会话以本地为准 → 「刚答掉」那条红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  /** 私聊 attention(/agent/sessions/*,10-18 Muse 私聊方案 B)单独一路,不搅上面那份待批索引的调用计数。 */
  dm: vi.fn(),
  notify: vi.fn(),
  targets: [{ key: 'home' }] as Array<{ key: string }>,
}))
vi.mock('../services/engine/targets', async (orig) => ({
  ...(await orig<typeof import('../services/engine/targets')>()),
  knownTargets: () => state.targets,
  engineFetch: (t: unknown, path: string, init: unknown, opts: unknown) => (path.startsWith('/agent/sessions') ? state.dm(path, init) : state.fetch(t, path, init, opts)),
}))
vi.mock('./notificationStore', () => ({ notifyApp: (x: unknown) => state.notify(x) }))

import { __resetAttentionForTests, ATTENTION_POLL_MS, attentionIndex, localAttentionSignature, mergeAttention, useAttention, type SessionAttention } from './attentionStore'
import { useApp } from './appStore'
import type { UiMessage } from '../types'

const A = (sessionId: string, approvals = 1, inquiries = 0, localOnly = 0): SessionAttention => ({ sessionId, approvals, inquiries, localOnly, oldestAt: '2026-09-28T00:00:00.000Z', remote: true })
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const msg = (approvals: Array<{ status: 'pending' | 'approved'; localOnly?: boolean }>, inquiries: Array<'pending' | 'answered'> = []): UiMessage => ({
  id: `m${Math.random()}`, role: 'assistant', content: '', timestamp: 1,
  approvals: approvals.map((a, i) => ({ approvalId: `a${i}`, runId: 'r', name: 'run_bash', preview: '', status: a.status, ...(a.localOnly ? { localOnly: true } : {}) })),
  inquiries: inquiries.map((st, i) => ({ inquiryId: `q${i}`, runId: 'r', question: '?', options: [], status: st })),
}) as UiMessage
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

const initial = useApp.getState()
beforeEach(() => {
  __resetAttentionForTests()
  state.fetch.mockReset()
  state.dm.mockReset()
  state.dm.mockImplementation(async () => json({ sessions: [] }))
  state.notify.mockReset()
  state.targets = [{ key: 'home' }]
  useApp.setState({ connState: 'ok' } as any)
})
afterEach(() => {
  __resetAttentionForTests()
  useApp.setState(initial, true)
  vi.useRealTimers()
})

describe('mergeAttention(纯函数)', () => {
  it('没订阅的会话用索引;订阅着的以本地为准(本地 0 = 刚答掉,索引的旧计数不算)', () => {
    const index = { s1: A('s1', 2, 1, 1), s2: A('s2', 3), s3: A('s3', 0, 0) }
    const messages = { s2: [msg([{ status: 'approved' }])], s4: [msg([{ status: 'pending', localOnly: true }], ['pending'])] }
    const running = { s2: 'r2', s4: 'r4' }
    const m = mergeAttention(index, messages, running)
    expect([...m.entries()].sort()).toEqual([
      ['s1', { n: 3, localOnly: true }],
      ['s4', { n: 2, localOnly: true }],
    ])
  })

  it('attentionIndex:多个目标的同一会话相加;disabled 的目标不计', () => {
    const idx = attentionIndex({
      home: { rev: 'a:1', sessions: [A('s1', 1), A('s2', 1)], at: 1 },
      'unit:x': { rev: 'b:1', sessions: [A('s1', 2, 1)], at: 1 },
      'unit:y': { rev: null, sessions: [A('s9', 5)], disabled: true, at: 1 },
    })
    expect(idx.s1).toMatchObject({ approvals: 3, inquiries: 1 })
    expect(idx.s2.approvals).toBe(1)
    expect(idx.s9).toBeUndefined()
  })

  it('本地签名只随订阅着的会话的待批计数变(token 流不改签名 → 侧栏不因每个 token 重绘)', () => {
    const base = { s1: [msg([{ status: 'pending' }])] }
    const sig1 = localAttentionSignature({ messagesBySession: base, runningBySession: { s1: 'r' } })
    const streamed = { s1: [{ ...base.s1[0], content: 'more tokens' }] }
    expect(localAttentionSignature({ messagesBySession: streamed, runningBySession: { s1: 'r' } })).toBe(sig1)
    expect(localAttentionSignature({ messagesBySession: { s1: [msg([{ status: 'approved' }])] }, runningBySession: { s1: 'r' } })).not.toBe(sig1)
  })
})

describe('refresh', () => {
  it('首拉不带 rev;之后带 ?rev=,unchanged 时保留原计数', async () => {
    state.fetch.mockResolvedValueOnce(json({ rev: 'b:2', sessions: [A('s1', 1)] }))
    await useAttention.getState().refresh()
    expect(state.fetch.mock.calls[0][1]).toBe('/agent/approvals/pending')
    expect(state.fetch.mock.calls[0][3]).toMatchObject({ timeoutMs: expect.any(Number) })
    state.fetch.mockResolvedValueOnce(json({ rev: 'b:2', unchanged: true }))
    await useAttention.getState().refresh()
    expect(state.fetch.mock.calls[1][1]).toBe('/agent/approvals/pending?rev=b%3A2')
    expect(useAttention.getState().byTarget.home.sessions).toEqual([A('s1', 1)])
  })

  it('响应清洗:形状不对的行丢掉,计数非法按 0', async () => {
    state.fetch.mockResolvedValueOnce(json({ rev: 'b:3', sessions: [A('ok', 2), { sessionId: 7 }, null, { sessionId: 'x', approvals: -1, inquiries: 'lots', remote: 'yes' }] }))
    await useAttention.getState().refresh()
    expect(useAttention.getState().byTarget.home.sessions).toEqual([A('ok', 2), { sessionId: 'x', approvals: 0, inquiries: 0, localOnly: 0, oldestAt: '', remote: false }])
  })

  it('404(云端 / 老引擎)→ 禁用该目标,不再拉;离线 / 5xx → 保留旧值', async () => {
    state.fetch.mockResolvedValueOnce(json({ rev: 'b:1', sessions: [A('s1')] }))
    await useAttention.getState().refresh()
    state.fetch.mockResolvedValueOnce(json({ detail: 'boom' }, 502))
    await useAttention.getState().refresh()
    state.fetch.mockRejectedValueOnce(new Error('offline'))
    await useAttention.getState().refresh()
    expect(useAttention.getState().byTarget.home.sessions).toEqual([A('s1')])
    state.fetch.mockResolvedValueOnce(json({ detail: 'not found' }, 404))
    await useAttention.getState().refresh()
    expect(useAttention.getState().byTarget.home).toMatchObject({ disabled: true, sessions: [] })
    const n = state.fetch.mock.calls.length
    await useAttention.getState().refresh()
    expect(state.fetch.mock.calls.length).toBe(n)
  })

  it('未连上(connState !== ok)不拉', async () => {
    useApp.setState({ connState: 'connecting' } as any)
    await useAttention.getState().refresh()
    expect(state.fetch).not.toHaveBeenCalled()
  })
})

describe('install', () => {
  it('20s 轮询;隐藏时暂停,回前台立即拉;重复 install 只装一份;全部卸载后停', async () => {
    vi.useFakeTimers()
    state.fetch.mockImplementation(async () => json({ rev: 'b:1', sessions: [] }))
    const off1 = useAttention.getState().install()
    const off2 = useAttention.getState().install() // StrictMode 双 effect
    await flush()
    expect(state.fetch).toHaveBeenCalledTimes(1) // 装上即拉一次
    await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS)
    expect(state.fetch).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS * 3)
    expect(state.fetch).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(state.fetch).toHaveBeenCalledTimes(3)
    off1()
    await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS)
    expect(state.fetch).toHaveBeenCalledTimes(4) // 还有一份在用
    off2()
    await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS * 3)
    expect(state.fetch).toHaveBeenCalledTimes(4)
  })

  it('连上的那一刻(connState → ok)立即拉,不等 20s', async () => {
    vi.useFakeTimers()
    useApp.setState({ connState: 'connecting' } as any)
    state.fetch.mockImplementation(async () => json({ rev: 'b:1', sessions: [] }))
    const off = useAttention.getState().install()
    await flush()
    expect(state.fetch).not.toHaveBeenCalled()
    useApp.setState({ connState: 'ok' } as any)
    await flush()
    expect(state.fetch).toHaveBeenCalledTimes(1)
    off()
  })
})

describe('私聊 attention(Muse 主动发来 / 等你)', () => {
  const solo = { id: 'dm1', title: 'Muse', agent_config: { soloAgentSlug: 'muse' } }
  it('拉到未读 / 等你;打开那条 = 读过(本地先熄 + POST read);新进入等你才弹(启动那一拉不弹),正看着的不弹', async () => {
    useApp.setState({ sessions: [solo, { id: 'p1', title: 'x', agent_config: {} }], configBySession: {}, activeId: null } as any)
    state.dm.mockImplementation(async () => json({ sessions: [{ id: 'dm1', unread: true, awaiting: false }, { id: 7 }] }))
    await useAttention.getState().refresh()
    await flush()
    expect(useAttention.getState().dm).toEqual({ dm1: { unread: true, awaiting: false } })
    expect(state.notify).not.toHaveBeenCalled()

    state.dm.mockImplementation(async (path: string) => (path.endsWith('/read') ? json({ ok: true }) : json({ sessions: [{ id: 'dm1', unread: true, awaiting: true }, { id: 'p1', unread: false, awaiting: true }] })))
    await useAttention.getState().refresh()
    await flush()
    expect(state.notify).toHaveBeenCalledTimes(1) // 只弹私聊那条;项目会话的等你不弹
    expect(state.notify.mock.calls[0][0]).toMatchObject({ event: 'dm.waiting', title: 'Muse' })

    const off = useAttention.getState().install()
    useApp.setState({ activeId: 'dm1' } as any)
    await flush()
    expect(useAttention.getState().dm.dm1).toEqual({ unread: false, awaiting: true }) // 等你听引擎的(这里 /read 没回 awaiting:false)
    expect(state.dm.mock.calls.some(([path, init]) => path === '/agent/sessions/dm1/read' && (init as any)?.method === 'POST')).toBe(true)
    off()
  })

  it('收尾问句的等你(awaiting_user):点进去算看过;正看着的那条列表刷新带回 awaiting_user 也当场熄(10-27 黄点不灭)', async () => {
    let still = new Set<string>()
    state.dm.mockImplementation(async (path: string) => json({ ok: true, awaiting: still.has(path) }))
    useApp.setState({ sessions: [{ id: 'p1', title: 'x', awaiting_user: true }, { id: 'p2', title: 'y', awaiting_user: true }], configBySession: {}, activeId: null } as any)
    const off = useAttention.getState().install()
    await flush()
    const reads = (): string[] => state.dm.mock.calls.filter(([, init]) => (init as any)?.method === 'POST').map(([path]) => path as string)
    useApp.setState({ activeId: 'p1' } as any)
    await flush()
    expect(useApp.getState().sessions.map((x: any) => x.awaiting_user)).toEqual([false, true])
    expect(reads()).toEqual(['/agent/sessions/p1/read'])

    useApp.setState({ sessions: [{ id: 'p1', title: 'x', awaiting_user: true }, { id: 'p2', title: 'y', awaiting_user: true }] } as any) // 一轮问句收尾后列表刷新
    await flush()
    expect(useApp.getState().sessions.map((x: any) => x.awaiting_user)).toEqual([false, true])
    expect(reads()).toEqual(['/agent/sessions/p1/read', '/agent/sessions/p1/read'])

    useApp.setState({ sessions: [...useApp.getState().sessions] } as any) // 没在等:不再发
    await flush()
    expect(reads()).toHaveLength(2)

    still = new Set(['/agent/sessions/p2/read']) // 引擎说读了还在等(回报没送回的子会话 / 老引擎)→ 不熄
    useApp.setState({ activeId: 'p2' } as any)
    await flush()
    expect(reads()).toHaveLength(3)
    expect(useApp.getState().sessions.map((x: any) => x.awaiting_user)).toEqual([false, true])
    off()
  })

  it('后台第一次建出的私聊本地列表里没有 → 补拉一次会话列表,角标 / 通知才认得它;每个 id 只补拉一次(Codex 10-18 #2)', async () => {
    const refreshSessions = vi.fn(async () => { useApp.setState({ sessions: [solo] } as any); return [] })
    useApp.setState({ sessions: [], configBySession: {}, activeId: null, refreshSessions } as any)
    await useAttention.getState().refresh() // 启动那一拉:还没有私聊
    await flush()
    state.dm.mockImplementation(async () => json({ sessions: [{ id: 'dm1', unread: true, awaiting: true }] }))
    await useAttention.getState().refresh()
    await flush()
    expect(refreshSessions).toHaveBeenCalledTimes(1)
    expect(state.notify).toHaveBeenCalledTimes(1)
    useApp.setState({ sessions: [] } as any) // 列表仍带不上它(分页):不每轮重拉
    await useAttention.getState().refresh()
    await flush()
    expect(refreshSessions).toHaveBeenCalledTimes(1)
  })

  it('老引擎没有这个端点(404)→ 本次启动不再拉', async () => {
    state.dm.mockImplementation(async () => json({ detail: 'nope' }, 404))
    await useAttention.getState().refresh()
    await flush()
    await useAttention.getState().refresh()
    await flush()
    expect(state.dm).toHaveBeenCalledTimes(1)
  })
})
