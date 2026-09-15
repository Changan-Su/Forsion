import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useInbox, type InboxMessage } from '../../stores/inboxStore'
import { inboxListSource as src } from './inboxListSource'

const msg = (id: string, extra: Partial<InboxMessage> = {}): InboxMessage => ({
  id, title: `标题${id}`, body: '', sender_kind: 'agent', sender_id: 'muse', origin_broadcast_id: null,
  read_at: null, archived_at: null, created_at: '2026-09-11 09:00:00', ...extra,
} as InboxMessage)

const spies = { refreshList: vi.fn(async () => {}), refreshUnread: vi.fn(async () => {}), refreshArchived: vi.fn(async () => {}) }
beforeEach(() => {
  Object.values(spies).forEach((f) => f.mockClear())
  useInbox.setState({
    messages: [
      msg('1'),
      msg('2', { read_at: '2026-09-11 09:05:00' }),
      msg('3', { sender_kind: 'server', sender_id: null, body: '服务端公告 alpha' }),
      msg('5', { sender_kind: 'system', sender_id: 'plugin:callroom' }),
      msg('6', { sender_kind: 'system', sender_id: 'plugin:pc-erp' }),
      msg('7', { archived_at: '2026-09-11 09:30:00' }), // 刚点了归档、PATCH 未回
    ],
    archived: [msg('4', { archived_at: '2026-09-10 08:00:00', read_at: '2026-09-10 08:00:00' })],
    archivedLoaded: true, unreadCount: 4, ...spies,
  })
})

describe('收件箱列表源(统一工作区)', () => {
  it('全部 = 未归档那份(刚归档的立即挪走);未读点只挂未读行;未读 / 按发信人客户端筛;搜索叠加正文', () => {
    expect(src.items().map((i) => i.key)).toEqual(['1', '2', '3', '5', '6'])
    expect(src.items().map((i) => !!i.unread)).toEqual([true, false, true, true, true])
    expect(src.items({ group: 'unread' }).map((i) => i.key)).toEqual(['1', '3', '5', '6'])
    expect(src.items({ group: 's:agent:muse' }).map((i) => i.key)).toEqual(['1', '2'])
    expect(src.items({ query: 'alpha' }).map((i) => i.key)).toEqual(['3'])
  })

  it('已归档 = 独立的那份;items / groups 渲染期零副作用(不拉取、不切任何全局档)', () => {
    expect(src.items({ group: 'archived' }).map((i) => i.key)).toEqual(['4'])
    src.groups!()
    expect(spies.refreshList).not.toHaveBeenCalled()
    expect(spies.refreshArchived).not.toHaveBeenCalled()
  })

  it('分组:未读(服务端未读数)→ 发信人按条数降序(系统消息不分插件并成一个)→ 已归档(条数)', () => {
    const g = src.groups!()
    expect(g.map((x) => x.key)).toEqual(['unread', 's:agent:muse', 's:system:', 's:server:', 'archived'])
    expect(g.map((x) => x.count)).toEqual([4, 2, 2, 1, 1])
  })

  it('subscribe 一次拉三样(未归档 / 未读数 / 已归档),退订后不再通知', () => {
    const cb = vi.fn()
    const off = src.subscribe(cb)
    expect([spies.refreshList, spies.refreshUnread, spies.refreshArchived].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
    useInbox.setState({ unreadCount: 9 })
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    useInbox.setState({ unreadCount: 8 })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
