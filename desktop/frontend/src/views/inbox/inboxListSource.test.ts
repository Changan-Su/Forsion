import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useInbox, senderOf, type InboxMessage } from '../../stores/inboxStore'
import { inboxListSource as src, inboxSnippet } from './inboxListSource'
import { PLUGIN_ICONS } from '@amadeus/components/icons'

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
      msg('8', { sender_id: 'automation:w-da28d2' }),
      msg('9', { sender_id: 'automation:w-d06155' }),
      msg('10', { sender_id: 'ariosto' }),
    ],
    archived: [msg('4', { archived_at: '2026-09-10 08:00:00', read_at: '2026-09-10 08:00:00' })],
    archivedLoaded: true, unreadCount: 4, ...spies,
  })
})

describe('收件箱列表源(统一工作区)', () => {
  it('全部 = 未归档那份(刚归档的立即挪走);未读点只挂未读行;未读 / 按来源客户端筛;搜索叠加正文', () => {
    expect(src.items().map((i) => i.key)).toEqual(['1', '2', '3', '5', '6', '8', '9', '10'])
    expect(src.items().map((i) => !!i.unread)).toEqual([true, false, true, true, true, true, true, true])
    expect(src.items({ group: 'unread' }).map((i) => i.key)).toEqual(['1', '3', '5', '6', '8', '9', '10'])
    expect(src.items({ group: 'source:agents' }).map((i) => i.key)).toEqual(['1', '2', '10'])
    expect(src.items({ group: 'source:automation' }).map((i) => i.key)).toEqual(['8', '9'])
    expect(src.items({ query: 'alpha' }).map((i) => i.key)).toEqual(['3'])
  })

  it('已归档 = 独立的那份;items / groups 渲染期零副作用(不拉取、不切任何全局档)', () => {
    expect(src.items({ group: 'archived' }).map((i) => i.key)).toEqual(['4'])
    src.groups!()
    expect(spies.refreshList).not.toHaveBeenCalled()
    expect(spies.refreshArchived).not.toHaveBeenCalled()
  })

  it('分组:未读 → 固定来源顺序 → 已归档;多个自动化规则并成一组且不泄漏规则 id', () => {
    const g = src.groups!()
    expect(g.map((x) => x.key)).toEqual(['unread', 'source:forsion', 'source:automation', 'source:agents', 'source:system', 'archived'])
    expect(g.map((x) => x.count)).toEqual([4, 1, 2, 3, 2, 1])
    expect(g.map((x) => x.title)).not.toContain('automation:w-da28d2')
    expect(senderOf(useInbox.getState().messages.find((m) => m.id === '8')!)).toBe('自动化')
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
  it('行首按来源、第二行 = 发信人 · 正文第一句', () => {
    const items = src.items()
    expect(items.map((i) => i.icon)).toEqual(['agent', 'agent', 'cloud', 'info', 'info', 'workflow', 'workflow', 'agent'])
    expect(items.find((i) => i.key === '3')!.subtitle).toBe('Forsion · 服务端公告 alpha')
    expect(items.find((i) => i.key === '1')!.subtitle).toBe(senderOf(useInbox.getState().messages[0])) // 空正文:只有发信人,不留孤零零的分隔点
    expect(items.find((i) => i.key === '8')!.subtitle).not.toContain('w-da28d2') // 规则 id 不进第二行
  })

  it('正文第一句:围栏 / 图片 / 表格 / 记号都不进摘要,与标题相同的行跳过', () => {
    const F = '```'
    expect(inboxSnippet(`${F}forsion-task\ntitle: x\n${F}\n\n| a | b |\n|---|---|\n\n## **今日**整理\n正文`)).toBe('今日整理')
    expect(inboxSnippet('补 README\n\n> [!note] 提示\n> 细节', '补 README')).toBe('提示')
    expect(inboxSnippet('![](https://x/y.png)\n\n- [ ] 看 [文档](https://x) 和 [[周报|本周周报]],跑 `write_file`')).toBe('看 文档 和 本周周报,跑 write_file')
    expect(inboxSnippet(`只有卡\n${F}forsion-approval\n{"id":"a"}`)).toBe('只有卡') // 没收口的围栏吃到结尾
    expect(inboxSnippet(`${F}js\ncode\n${F}`)).toBe('')
    expect(inboxSnippet('😀'.repeat(100))).toBe('😀'.repeat(80)) // 按码点截,不留半个 emoji
    // 波浪线围栏、四个反引号套三个反引号(审批信里的任务书就是这么套的):里面的行一律不出来
    expect(inboxSnippet('~~~js\nsecret\n~~~\n看得见')).toBe('看得见')
    expect(inboxSnippet(`${F}\`forsion-task\ntitle: x\n${F}js\nsecret\n${F}\n${F}\`\n看得见`)).toBe('看得见')
    expect(inboxSnippet(`前 ${F} 行内 ${F} 后`)).toBe('前 行内 后') // 不在行首的三个反引号是行内代码,不是围栏
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) inboxSnippet('['.repeat(100_000))
    expect(performance.now() - t0).toBeLessThan(500) // 只看开头:恶意长行不拖慢列表
  })

  it('条目菜单与源动作带图标(手机上左滑是只有图标的圆钮):成对的动作各用各的,词表里都有', () => {
    const icons = (key: string, group?: string): string => src.itemMenu!(src.items(group ? { group } : undefined).find((i) => i.key === key)!).map((a) => `${a.id}:${a.icon}`).join(' ')
    expect(icons('1')).toBe('read:mail-open archive:archive delete:trash') // 未读 → 标为已读
    expect(icons('2')).toBe('read:mail archive:archive delete:trash') // 已读 → 标为未读
    expect(icons('4', 'archived')).toBe('read:mail archive:unarchive delete:trash')
    expect(src.actions!.find((a) => a.primary)!.icon).toBe('refresh')
    for (const name of ['mail', 'mail-open', 'archive', 'unarchive', 'trash', 'refresh']) expect(PLUGIN_ICONS[name], name).toBeTruthy()
  })

  it('已归档列表的条目菜单保留取消归档入口', () => {
    const original = useInbox.getState().markArchived
    const markArchived = vi.fn()
    useInbox.setState({ markArchived })
    try {
      src.itemMenu!(src.items({ group: 'archived' })[0]).find((action) => action.id === 'archive')!.run()
      expect(markArchived).toHaveBeenCalledWith('4', false)
    } finally { useInbox.setState({ markArchived: original }) }
  })
})
