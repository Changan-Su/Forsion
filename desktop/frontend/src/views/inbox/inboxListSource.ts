/**
 * 收件箱 → 统一「工作区」左栏的列表源(2026-09-11,用户:「收件箱左边的 Panel 要接入工作区」)。
 *
 * 与青鸟收藏夹同一条契约(ListSourceContribution,View 基座 P2):数据与动作在这里,UI 全归工作区视图 ——
 * 行 = 会话 / 笔记同一个 SidebarRow,搜索框 / 分组(文件夹)/ 顶部动作 / 右键菜单都是宿主那一套。
 * 收件箱因此不再有自己的左栏组件(旧 Gmail 式 InboxListView 已删),Inbox Space 左栏就是 workspace 视图,
 * 自动档由 Space 默认档 + 阅读面板的 workspaceSource 指到这里;别的 Space 的工作区选择器里也能手动切到它。
 *
 * 分组(可选中的文件夹,「全部」由宿主给):未读 / 每个发信人 / 已归档。agent 按 slug 各一个;系统消息不管
 * 来自哪个插件并成一个「系统」,服务端广播一个「Forsion」(同名文件夹重复出现分不清)。
 * 未归档与已归档是 store 里**两份独立数据**,subscribe 时都拉:未读 / 按发信人在未归档那份上客户端筛。
 * ⚠️ items() / groups() 只读不写,渲染期零副作用 —— 旧写法在 items() 里切全局服务端档,左右栏各选一个分组
 *    就会互相切档无限拉取(2026-09-11 自查)。
 * 文案一律现取:title / label 是字符串字段,赋值即定格,切语言不变(CLAUDE.md 双语纪律)→ 用 getter。
 */
import { useWorkspace } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ListGroup, ListItem, ListSourceContribution } from '@amadeus/plugins/types'
import { translate } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useInbox, senderOf, parseUtc, type InboxMessage } from '../../stores/inboxStore'
import { INBOX_WORKSPACE_MODE } from '../workspaceMode'

// 源身份单源:从工作区模式串 `plugin:<pid>:<srcId>` 拆出来 —— Space 默认档 / workspaceSource / 注册三处永远一致。
const [, SOURCE_OWNER, SOURCE_ID] = INBOX_WORKSPACE_MODE.split(':')
const UNREAD = 'unread'
const ARCHIVED = 'archived'
const SENDER = 's:'

/** 相对时间;>7 天转日期。 */
function timeAgo(iso: string | null): string {
  const d = parseUtc(iso)
  if (!d) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return translate('inbox.time.now')
  if (diff < 3600_000) return translate('inbox.time.minutes', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return translate('inbox.time.hours', { n: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return translate('inbox.time.days', { n: Math.floor(diff / 86400_000) })
  return d.toLocaleDateString()
}

const senderKey = (m: InboxMessage): string =>
  m.sender_kind === 'agent' ? `${SENDER}agent:${m.sender_id ?? ''}` : `${SENDER}${m.sender_kind}:`

function toItem(m: InboxMessage): ListItem {
  const avatar = m.sender_kind === 'agent' && m.sender_id ? useApp.getState().agentAvatars[m.sender_id] : undefined
  return {
    key: m.id,
    title: m.title,
    hint: timeAgo(m.created_at),
    // 词表里没有邮件 / 机器人图标:agent 用头像,系统消息 info,带物品的 attachment,其余 page。
    icon: m.sender_kind === 'system' ? 'info' : m.attachments?.items?.length ? 'attachment' : 'page',
    ...(avatar ? { iconUrl: avatar } : {}),
    ...(m.read_at ? {} : { unread: true }),
  }
}

export const inboxListSource: ListSourceContribution = {
  id: SOURCE_ID,
  get title() { return translate('space.inbox') },
  search: true,
  items(f) {
    const st = useInbox.getState()
    const group = f?.group
    // 未归档那份里可能有刚点了「归档」、PATCH 还没回来的行 —— 按字段立即挪走。
    let list = group === ARCHIVED ? st.archived : st.messages.filter((m) => !m.archived_at)
    if (group === UNREAD) list = list.filter((m) => !m.read_at)
    else if (group?.startsWith(SENDER)) list = list.filter((m) => senderKey(m) === group)
    const q = f?.query?.trim().toLowerCase()
    if (q) list = list.filter((m) => m.title.toLowerCase().includes(q) || (m.body || '').toLowerCase().includes(q) || senderOf(m).toLowerCase().includes(q))
    return list.map(toItem)
  },
  groups() {
    const st = useInbox.getState()
    const senders = new Map<string, ListGroup>()
    for (const m of st.messages) {
      if (m.archived_at) continue
      const k = senderKey(m)
      const g = senders.get(k)
      if (g) g.count = (g.count ?? 0) + 1
      else senders.set(k, { key: k, title: senderOf(m), count: 1, ...(m.sender_kind === 'system' ? { icon: 'info' } : {}) })
    }
    return [
      { key: UNREAD, title: translate('inbox.filter.unread'), count: st.unreadCount },
      ...[...senders.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
      { key: ARCHIVED, title: translate('inbox.filter.archived'), ...(st.archivedLoaded ? { count: st.archived.length } : {}) },
    ]
  },
  activeKey: () => useInbox.getState().selectedId,
  open(item) {
    useInbox.getState().select(item.key)
    useWorkspace.getState().openView('inbox-reader', {}, 'main')
  },
  subscribe(cb) {
    // 契约纪律:subscribe 顺手重读一次(见 SKILL.md 列表源节)。已归档也在这里拉 —— 渲染期不许触发拉取。
    const st = useInbox.getState()
    void st.refreshList()
    void st.refreshUnread()
    void st.refreshArchived()
    const offInbox = useInbox.subscribe(cb)
    // 发信人名字 / 头像来自 appStore:只在这两样变了才通知(appStore 流式时变得很勤,别跟着整表重渲)。
    const offApp = useApp.subscribe((s, p) => { if (s.agentDefs !== p.agentDefs || s.agentAvatars !== p.agentAvatars) cb() })
    return () => { offInbox(); offApp() }
  },
  actions: [
    { id: 'read-all', get label() { return translate('inbox.action.readAll') }, run: () => { void useInbox.getState().readAll() } },
    { id: 'pull', get label() { return translate('inbox.action.refresh') }, run: () => { void useInbox.getState().pull() } },
  ],
  itemMenu(item) {
    const st = useInbox.getState()
    const m = st.messages.find((x) => x.id === item.key)
    if (!m) return []
    return [
      { id: 'read', label: translate(m.read_at ? 'inbox.action.markUnread' : 'inbox.action.markRead'), run: () => st.markRead(m.id, !m.read_at) },
      { id: 'archive', label: translate(m.archived_at ? 'inbox.action.unarchive' : 'inbox.action.archive'), run: () => st.markArchived(m.id, !m.archived_at) },
      { id: 'delete', label: translate('inbox.action.delete'), run: () => { if (window.confirm(translate('inbox.deleteConfirm', { title: m.title }))) st.remove(m.id) } },
    ]
  },
}

/** 宿主内置源直接进插件仓的 listSources(工作区视图只认那一处);幂等 —— HMR / 重复装配不叠第二份。
 *  ponytail: 源主人名 'inbox' 若与某个外置插件同名,那个插件卸载会顺手摘掉本源;真撞上再给宿主源单开一格。 */
export function registerInboxListSource(): void {
  usePluginStore.setState((s) => ({
    listSources: [
      ...s.listSources.filter((o) => !(o.pluginId === SOURCE_OWNER && o.item.id === SOURCE_ID)),
      { pluginId: SOURCE_OWNER, item: inboxListSource },
    ],
  }))
}
