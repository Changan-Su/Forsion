/** 未读轮询单飞(Codex 09-11 P2):并发的 refreshUnread 只跑一个 + 一次尾随重跑;同一条新消息只通知一次。 */
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ count: vi.fn(), list: vi.fn(), notify: vi.fn() }))
vi.mock('../services/backendService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInboxUnreadCount: h.count,
  listInbox: h.list,
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
