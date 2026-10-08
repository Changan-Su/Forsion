/** 未读轮询单飞(Codex 09-11 P2):并发的 refreshUnread 只跑一个 + 一次尾随重跑;同一条新消息只通知一次。 */
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ count: vi.fn(), list: vi.fn(), notify: vi.fn(), patch: vi.fn(() => Promise.resolve()) }))
vi.mock('../services/backendService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInboxUnreadCount: h.count,
  listInbox: h.list,
  patchInboxMessage: h.patch,
}))
vi.mock('./notificationStore', () => ({ notifyApp: h.notify }))

import { useInbox } from './inboxStore'

// store 更新角标时摸 window.tangu(桌面桥);node 环境下给个空壳即可。
vi.stubGlobal('window', {})

describe('refreshUnread 单飞', () => {
  it('并发两次:只跑一个 + 一次尾随;同一条新消息只通知一次', async () => {
    h.count.mockResolvedValueOnce({ count: 1, latestId: 'a' })
    await useInbox.getState().refreshUnread() // 首拉只记基准,不通知

    let release!: (v: { count: number; latestId: string }) => void
    h.count.mockImplementationOnce(() => new Promise((r) => { release = r }))
    h.count.mockResolvedValue({ count: 2, latestId: 'b' })
    h.list.mockResolvedValue([{ id: 'b', title: 'T', body: '', sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null, read_at: null, archived_at: null, created_at: '2026-09-11 09:00:00' }])

    const p1 = useInbox.getState().refreshUnread()
    const p2 = useInbox.getState().refreshUnread()
    release({ count: 2, latestId: 'b' })
    await Promise.all([p1, p2])

    expect(h.notify).toHaveBeenCalledTimes(1) // 判别断言:没有单飞时两个并发体都判成新消息 → 2
    expect(h.count).toHaveBeenCalledTimes(3) // 基准 + 首跑 + 尾随
    expect(useInbox.getState().unreadCount).toBe(2)
    expect(p2).toBe(p1)
  })
})

/** 用户反馈(10-08):在收件箱里批准一封确认信,回信到了只亮红点、列表不出现,切走再切回来才有。
 *  读掉那封(本地未读 1 → 0)和回信到达(服务端未读又是 1)落在同一个 15 秒轮询间隔里,
 *  旧判据拿的是「上一次轮询的未读数」,1 > 1 不成立 → 只更新红点不刷列表。 */
describe('refreshUnread 刷列表', () => {
  const mk = (id: string, read = false) => ({ id, title: id, body: '', sender_kind: 'agent' as const, sender_id: 'muse', origin_broadcast_id: null, read_at: read ? '2026-09-11 09:00:01' : null, archived_at: null, created_at: '2026-09-11 09:00:00' })

  it('读掉一封后同一轮询间隔里来了新的一封(未读数 1 → 1):照样刷列表并通知', async () => {
    h.count.mockResolvedValue({ count: 1, latestId: 'x' })
    h.list.mockResolvedValue([mk('x')])
    await useInbox.getState().refreshList()
    await useInbox.getState().refreshUnread() // 基准:一封未读的确认信
    useInbox.getState().select('x') // 打开即已读 → 本地未读 0
    h.notify.mockClear()

    h.count.mockResolvedValue({ count: 1, latestId: 'y' }) // 批准后回信到了
    h.list.mockResolvedValue([mk('y'), mk('x', true)])
    await useInbox.getState().refreshUnread()

    expect(useInbox.getState().messages.map((m) => m.id)).toContain('y') // 判别断言:旧判据下列表还停在只有 x
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('最新一封没变但未读数变了(定时信到点 / 别的设备读掉了):也刷列表,不通知', async () => {
    h.notify.mockClear(); h.list.mockClear()
    h.count.mockResolvedValue({ count: 2, latestId: 'y' })
    await useInbox.getState().refreshUnread()
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(h.notify).not.toHaveBeenCalled()

    h.list.mockClear()
    await useInbox.getState().refreshUnread() // 服务端和手上的一致 → 不多拉
    expect(h.list).not.toHaveBeenCalled()
  })

  it('拉列表期间本地又点开了一封:旧快照不盖回去,重跑一遍(Codex 评审)', async () => {
    useInbox.setState({ messages: [mk('p'), mk('q')], unreadCount: 2 })
    h.notify.mockClear(); h.list.mockReset(); h.count.mockReset()
    let release: ((v: unknown[]) => void) | undefined
    h.count.mockResolvedValueOnce({ count: 3, latestId: 'r' }).mockResolvedValue({ count: 2, latestId: 'r' })
    h.list.mockImplementationOnce(() => new Promise((r) => { release = r })).mockResolvedValue([mk('r'), mk('p', true), mk('q')])

    const run = useInbox.getState().refreshUnread()
    await vi.waitFor(() => expect(release).toBeDefined())
    useInbox.getState().select('p') // 快照在路上时点开 p
    release!([mk('r'), mk('p'), mk('q')]) // 旧快照里 p 还是未读
    await run

    expect(h.list).toHaveBeenCalledTimes(2) // 判别断言:没有守卫时只拉一次,旧快照直接落地
    expect(useInbox.getState().messages.find((m) => m.id === 'p')?.read_at).toBeTruthy()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
})
