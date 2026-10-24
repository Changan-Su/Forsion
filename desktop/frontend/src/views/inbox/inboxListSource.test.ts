import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useInbox, senderOf, type InboxMessage } from '../../stores/inboxStore'
import { inboxListSource as src, inboxSnippet } from './inboxListSource'
import { PLUGIN_ICONS } from '@amadeus/components/icons'
import { hiddenByFilter } from '@amadeus/plugins/listTree'

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
  // 组头不是信:下面凡是数信的地方都先把组头滤掉
  const mails = (f?: Parameters<typeof src.items>[0]) => src.items(f).filter((i) => i.kind !== 'folder')
  const heads = (f?: Parameters<typeof src.items>[0]) => src.items(f).filter((i) => i.kind === 'folder')

  it('全部 = 未归档那份(刚归档的立即挪走);未读点只挂未读行;未读客户端筛;搜索叠加正文、结果平铺', () => {
    expect(mails().map((i) => i.key).sort((a, b) => Number(a) - Number(b))).toEqual(['1', '2', '3', '5', '6', '8', '9', '10'])
    expect(mails().filter((i) => !i.unread).map((i) => i.key)).toEqual(['2'])
    expect(mails({ group: 'unread' }).map((i) => i.key).sort((a, b) => Number(a) - Number(b))).toEqual(['1', '3', '5', '6', '8', '9', '10'])
    // 搜索:没有组头、行不挂在谁下面,第二行自己带发信人
    const hits = src.items({ query: 'alpha' })
    expect(hits.map((i) => `${i.key}|${i.kind ?? ''}|${i.parent ?? ''}|${i.subtitle}`)).toEqual(['3|||Forsion · 服务端公告 alpha'])
  })

  it('按发信人归组:每个 Agent 各一组,自动化的各条规则并成一组且不泄漏规则 id;组里的行挂在组头下面', () => {
    const g = heads()
    expect(g.map((x) => x.key).sort()).toEqual(['sender:agent:ariosto', 'sender:agent:muse', 'sender:automation', 'sender:forsion', 'sender:system'])
    expect(g.every((x) => x.folderStyle === 'group')).toBe(true)
    expect(g.map((x) => x.title)).not.toContain('automation:w-da28d2')
    const under = (key: string) => src.items().filter((i) => i.parent === key).map((i) => i.key)
    expect(under('sender:agent:muse')).toEqual(['1', '2'])
    expect(under('sender:automation')).toEqual(['8', '9'])
    expect(under('sender:system')).toEqual(['5', '6'])
    // 组头:行尾 = 这一组的未读数;Agent 不给图标(宿主画头像 / 首字),其余来源各一枚
    expect(Object.fromEntries(g.map((x) => [x.key, `${x.hint ?? '-'}|${x.icon ?? '-'}`]))).toEqual({
      'sender:agent:muse': '1|-', 'sender:agent:ariosto': '1|-', 'sender:automation': '2|workflow', 'sender:forsion': '1|cloud', 'sender:system': '2|info',
    })
    expect(senderOf(useInbox.getState().messages.find((m) => m.id === '8')!)).toBe('自动化')
  })

  it('谁刚来信谁在最上面:组按各自最新的一封排,组里也是新的在前;有未读的组缺省开着,其余收着', () => {
    useInbox.setState({ messages: [
      msg('a', { read_at: '2026-09-11 10:00:00', created_at: '2026-09-11 09:00:00' }),                          // muse,旧
      msg('b', { sender_kind: 'server', sender_id: null, read_at: '2026-09-12 08:00:00', created_at: '2026-09-12 08:00:00' }), // Forsion
      msg('c', { sender_id: 'ariosto', read_at: '2026-09-10 08:00:00', created_at: '2026-09-10 08:00:00' }),      // ariosto,最旧
      msg('d', { created_at: '2026-09-13 08:00:00' }),                                                            // muse 又来一封 → muse 排到最上
    ] })
    expect(src.items().map((i) => i.key)).toEqual(['sender:agent:muse', 'd', 'a', 'sender:forsion', 'b', 'sender:agent:ariosto', 'c'])
    expect(heads().map((x) => !!x.defaultOpen)).toEqual([true, false, false])
    // 只有一个发信人(手机的本地收件箱只有 Forsion):没有未读也开着,免得进来只看到一行收起的组头
    useInbox.setState({ messages: [msg('b', { sender_kind: 'server', sender_id: null, read_at: '2026-09-12 08:00:00' })] })
    expect(heads().map((x) => !!x.defaultOpen)).toEqual([true])
  })

  it('已归档 = 独立的那份;items / groups 渲染期零副作用(不拉取、不切任何全局档)', () => {
    expect(mails({ group: 'archived' }).map((i) => i.key)).toEqual(['4'])
    src.groups!()
    expect(spies.refreshList).not.toHaveBeenCalled()
    expect(spies.refreshArchived).not.toHaveBeenCalled()
  })

  it('筛选只剩未读 / 已归档(发信人已经是组,不再当筛选条件)', () => {
    const g = src.groups!()
    expect(g.map((x) => x.key)).toEqual(['unread', 'archived'])
    expect(g.map((x) => x.count)).toEqual([4, 1])
  })

  it('开着筛选时底下写「筛掉了几条」= 清掉筛选会多出来的信:未读筛掉已读的;已归档是另一份数据,未归档的全算;跟着搜索词数', () => {
    const hidden = (group: string, query?: string) => hiddenByFilter(src.items({ query }), src.items({ query, group }))
    expect(hidden('unread')).toBe(1) // 未归档里只有 2 是已读
    expect(hidden('archived')).toBe(8) // 已归档不是「全部」的子集:两个行数相减会得 7
    expect(hidden('unread', 'alpha')).toBe(0) // 搜出来的那封(3)本来就未读
    expect(hidden('archived', 'alpha')).toBe(1)
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
  it('组里的行:第二行只有正文第一句(发信人在组头上),正文取不出字就没有第二行;搜索结果的行带发信人', () => {
    const items = mails()
    expect(items.find((i) => i.key === '3')!.subtitle).toBe('服务端公告 alpha')
    expect(items.find((i) => i.key === '1')!.subtitle).toBeUndefined()
    // 搜索(平铺):行首按来源,第二行 = 发信人 · 正文第一句;空正文只有发信人,不留孤零零的分隔点;规则 id 不进第二行
    const flat = src.items({ query: '标题' })
    expect(flat.map((i) => i.icon).sort()).toEqual(['agent', 'agent', 'agent', 'cloud', 'info', 'info', 'workflow', 'workflow'])
    expect(flat.find((i) => i.key === '1')!.subtitle).toBe(senderOf(useInbox.getState().messages[0]))
    expect(flat.find((i) => i.key === '8')!.subtitle).not.toContain('w-da28d2')
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
    // 10-19:审批信正文是引擎 escapeMd 过的,列表里要还原成字面字符(从前露出 run\_bash、C:\\Users)
    expect(inboxSnippet('run\\_bash · $ dir /b "C:\\\\Users\\\\Dream\\\\.forsion\\\\tangu"')).toBe('run_bash · $ dir /b "C:\\Users\\Dream\\.forsion\\tangu"')
    expect(inboxSnippet('a\\*b\\*c \\[x\\](y)')).toBe('a*b*c [x](y)') // 被转义的 * 不当强调剥掉,[x](y) 不当链接
    expect(inboxSnippet('\\> 不是引用 \\# 也不是标题')).toBe('> 不是引用 # 也不是标题')
    expect(inboxSnippet('路径 `C:\\Users\\A\\.forsion\\x` 和 a\\_b')).toBe('路径 C:\\Users\\A\\.forsion\\x 和 a_b') // 行内代码里不是转义
    expect(inboxSnippet('\ue041PPROVED a\\_b')).toBe('\ue041PPROVED a\\_b') // 正文自带占位区字符:整行不还原
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
      src.itemMenu!(mails({ group: 'archived' })[0]).find((action) => action.id === 'archive')!.run()
      expect(markArchived).toHaveBeenCalledWith('4', false)
    } finally { useInbox.setState({ markArchived: original }) }
  })
})
