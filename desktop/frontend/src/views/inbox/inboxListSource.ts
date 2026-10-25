/**
 * 收件箱 → 统一「工作区」左栏的列表源(2026-09-11,用户:「收件箱左边的 Panel 要接入工作区」)。
 *
 * 与青鸟收藏夹同一条契约(ListSourceContribution,View 基座 P2):数据与动作在这里,UI 全归工作区视图 ——
 * 行 = 会话 / 笔记同一个 SidebarRow,搜索框 / 分组(文件夹)/ 顶部动作 / 右键菜单都是宿主那一套。
 * 收件箱因此不再有自己的左栏组件(旧 Gmail 式 InboxListView 已删),Inbox Space 左栏就是 workspace 视图,
 * 自动档由 Space 默认档 + 阅读面板的 workspaceSource 指到这里;别的 Space 的工作区选择器里也能手动切到它。
 *
 * 按发信人归组(2026-10-14,用户:「折叠起来,类似于工作区的样式」「按发件人」「谁发件了谁就上来」):
 *   每个发信人一个组头(ListItem.folderStyle: 'group' —— Agent 是头像 / 首字,Forsion / 自动化 / 系统各一枚图标),
 *   组头行尾是这一组的未读数;组按最新一封信排,谁刚来信谁在最上面;有未读的组自己开着(defaultOpen),其余收着。
 *   每个 Agent 各一组;`automation:<ruleId>` 只是引擎路由标识,全部并进「自动化」一组,否则每条规则都会
 *   造出一个组并泄漏内部 id。只有一个发信人时(手机的本地收件箱只有 Forsion)那一组直接开着。
 * 组里的行(两行):标题 + 时间 / 正文第一句。发信人已经在组头上,行里不再重复名字和图标。
 *   搜索时宿主不画层级,所以搜索结果是平铺的行:行首 = 谁发的,第二行「发信人 · 正文第一句」(10-13 的那种行)。
 * 筛选(「全部」由宿主给):未读 / 已归档。发信人已经是组,不再当筛选条件。
 * 未归档与已归档是 store 里**两份独立数据**,subscribe 时都拉:未读 / 按来源在未归档那份上客户端筛。
 * ⚠️ items() / groups() 只读不写,渲染期零副作用 —— 旧写法在 items() 里切全局服务端档,左右栏各选一个分组
 *    就会互相切档无限拉取(2026-09-11 自查)。
 * 文案一律现取:title / label 是字符串字段,赋值即定格,切语言不变(CLAUDE.md 双语纪律)→ 用 getter。
 */
import { useWorkspace } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import type { ListGroup, ListItem, ListSourceContribution } from '@amadeus/plugins/types'
import { translate } from '../../i18n'
import { formatListTime } from '../../format/time'
import { useApp } from '../../stores/appStore'
import { homeAgentAvatars, subscribeHomeAgents } from '../../stores/homeCatalog'
import { useInbox, inboxDeleteConfirm, isAutomationSender, senderOf, parseUtc, type InboxMessage } from '../../stores/inboxStore'
import { INBOX_WORKSPACE_MODE } from '../workspaceMode'
import { setHostListEmpty } from '../hostListEmpty'
import './inboxEmptyMessages'
import { Inbox } from 'lucide-react'

// 源身份单源:从工作区模式串 `plugin:<pid>:<srcId>` 拆出来 —— Space 默认档 / workspaceSource / 注册三处永远一致。
const [, SOURCE_OWNER, SOURCE_ID] = INBOX_WORKSPACE_MODE.split(':')
const UNREAD = 'unread'
const ARCHIVED = 'archived'

type SourceKind = 'forsion' | 'automation' | 'agents' | 'system'
// 图标按来源一处定:组头、搜索结果的行首用的是同一枚(阅读面板头部的 SenderGlyph 画的也是这几个字形)。
const SOURCE_ICON: Record<SourceKind, string> = { forsion: 'cloud', automation: 'workflow', agents: 'agent', system: 'info' }

/** 列表行尾时间:7 天内相对时间,更早显示日期(单源 format/time,跟界面语言不跟系统区域)。 */
const timeAgo = (iso: string | null): string => formatListTime(parseUtc(iso))

const sourceKind = (m: InboxMessage): SourceKind => {
  if (m.sender_kind === 'server') return 'forsion'
  if (m.sender_kind === 'system') return 'system'
  return isAutomationSender(m) ? 'automation' : 'agents'
}
/** 组的 key:每个 Agent 各一组,其余按来源各一组。带前缀,不会和信的 id 撞。 */
const senderKey = (m: InboxMessage): string => {
  const kind = sourceKind(m)
  return kind === 'agents' ? `sender:agent:${m.sender_id ?? ''}` : `sender:${kind}`
}
const agentAvatar = (m: InboxMessage): string | undefined =>
  m.sender_kind === 'agent' && m.sender_id ? homeAgentAvatars()[m.sender_id] : undefined

/** 第二行里的「正文第一句」。信是 markdown,直接截会截出围栏、表格线和标记符号:
 *  跳过围栏里的行(任务卡 / 审批卡 / 代码;反引号与波浪线都算,收尾须同字符且不短于开头,没收口的吃到结尾)、
 *  表格行、分隔线和只有图片的行,剥掉行首的引用 / 标题 / 列表记号和行内的强调、链接语法,取第一行有字的。
 *  与标题相同的那一行跳过(Muse 待办信的正文开头就是标题)。只截到 80 个字,再长由行的省略号管;按码点截,不留半个 emoji。
 *  每次列表刷新每封信都算一遍,所以只看正文开头 4000 字、每行 300 字 —— 再长的信也是这个开销。 */
export function inboxSnippet(body: string | null | undefined, title = ''): string {
  let fence = ''
  for (const full of (body || '').slice(0, 4000).split('\n')) {
    const raw = full.slice(0, 300)
    const mark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1]
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && /^\s*[`~]+\s*$/.test(raw)) fence = ''
      continue
    }
    if (mark) { fence = mark; continue }
    if (/^\s*\|/.test(raw) || /^\s*(?:[-*_]\s*){3,}$/.test(raw)) continue
    // 反斜杠转义(引擎给审批信转义过 `run\_bash`、`C:\\Users`)先换成私用区占位,剥完语法再还原成字面字符 ——
    // 不然被转义的 * _ 会被下面当成强调剥掉,反斜杠原样露在列表里。行内代码里的反斜杠不是转义(CommonMark),原样留;
    // 这一行本来就有占位区的字符就整行不还原,免得把它们也「还原」掉(Codex 10-19)。
    const pua = /[\ue021-\ue07e]/.test(raw)
    const line = (pua ? raw : raw.replace(/(`+)[^`]*?\1|\\([!-/:-@[-`{-~])/g, (m, _t, c?: string) => (c ? String.fromCharCode(0xe000 + c.charCodeAt(0)) : m)))
      .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]/g, '')
      .replace(/^\s*(?:>\s*)*(?:\[![^\]]*\][+-]?\s*)?/, '')
      .replace(/^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, a: string, b?: string) => b || a)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*+|`+|~~/g, '')
      .replace(/\s+/g, ' ').trim()
    const text = pua ? line : line.replace(/[\ue021-\ue07e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000))
    if (text && text !== title.trim()) return Array.from(text).slice(0, 80).join('')
  }
  return ''
}

/** 第二行:「发信人 · 正文第一句」;正文取不出字就只有发信人。列表行与仪表盘收件箱卡共用。 */
export function inboxSubtitle(m: InboxMessage): string {
  const snippet = inboxSnippet(m.body, m.title)
  return snippet ? `${senderOf(m)} · ${snippet}` : senderOf(m)
}

/** parent 在场 = 组里的行:第二行只有正文第一句(发信人在组头上);不在场 = 平铺的行,第二行带发信人。 */
function toItem(m: InboxMessage, parent?: string): ListItem {
  const avatar = agentAvatar(m)
  const subtitle = parent ? inboxSnippet(m.body, m.title) : inboxSubtitle(m)
  return {
    key: m.id,
    title: m.title,
    ...(subtitle ? { subtitle } : {}),
    hint: timeAgo(m.created_at),
    // 行首 = 谁发的:Agent 有头像用头像(iconUrl),没有就是 agent 那枚;其余按来源。组里的行宿主不画它。
    icon: SOURCE_ICON[sourceKind(m)],
    ...(avatar ? { iconUrl: avatar } : {}),
    ...(m.read_at ? {} : { unread: true }),
    ...(parent ? { parent } : {}),
  }
}

/** 发件时间从新到旧;时间一样的保持原来的先后。后端给的是 'YYYY-MM-DD HH:MM:SS',按字符串比就是按时间比。 */
const newestFirst = (a: InboxMessage, b: InboxMessage): number => (b.created_at ?? '').localeCompare(a.created_at ?? '')

/** 按发信人归组:组头 + 组里的信。组按各自最新的一封排 —— 谁刚来信谁在最上面。 */
function grouped(list: InboxMessage[]): ListItem[] {
  const bySender = new Map<string, InboxMessage[]>()
  for (const m of [...list].sort(newestFirst)) {
    const key = senderKey(m)
    if (!bySender.has(key)) bySender.set(key, [])
    bySender.get(key)!.push(m)
  }
  const out: ListItem[] = []
  for (const [key, mails] of bySender) {
    const unread = mails.filter((m) => !m.read_at).length
    const avatar = agentAvatar(mails[0])
    const kind = sourceKind(mails[0])
    out.push({
      key, title: senderOf(mails[0]), kind: 'folder', folderStyle: 'group',
      // Agent:头像,没有头像时宿主画名字的首字(和工作区的 Agent 行一样);其余来源各一枚图标
      ...(kind === 'agents' ? {} : { icon: SOURCE_ICON[kind] }),
      ...(avatar ? { iconUrl: avatar } : {}),
      ...(unread ? { hint: String(unread) } : {}),
      ...(unread || bySender.size === 1 ? { defaultOpen: true } : {}),
    })
    for (const m of mails) out.push(toItem(m, key))
  }
  return out
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
    const q = f?.query?.trim().toLowerCase()
    // 搜索结果是平铺的(宿主搜索时不画层级):每行自己带上发信人
    if (q) return list.filter((m) => m.title.toLowerCase().includes(q) || (m.body || '').toLowerCase().includes(q) || senderOf(m).toLowerCase().includes(q)).map((m) => toItem(m))
    return grouped(list)
  },
  groups(): ListGroup[] {
    const st = useInbox.getState()
    return [
      { key: UNREAD, title: translate('inbox.filter.unread'), count: st.unreadCount },
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
    // 发信人名字 / 头像来自本端的 Agent 目录(stores/homeCatalog):只在这两样变了才通知(appStore 流式时变得很勤,别跟着整表重渲)。
    const offApp = subscribeHomeAgents(cb)
    return () => { offInbox(); offApp() }
  },
  actions: [
    { id: 'read-all', get label() { return translate('inbox.action.readAll') }, run: () => { void useInbox.getState().readAll() } },
    { id: 'pull', primary: true, icon: 'refresh', get label() { return translate('inbox.action.refresh') }, run: () => { void useInbox.getState().pull() } },
  ],
  itemMenu(item) {
    const st = useInbox.getState()
    const m = [...st.messages, ...st.archived].find((x) => x.id === item.key)
    if (!m) return []
    return [
      // 图标给手机上左滑出来的圆钮用(只有图标,不带字):成对的动作各用各的
      { id: 'read', icon: m.read_at ? 'mail' : 'mail-open', label: translate(m.read_at ? 'inbox.action.markUnread' : 'inbox.action.markRead'), run: () => st.markRead(m.id, !m.read_at) },
      { id: 'archive', icon: m.archived_at ? 'unarchive' : 'archive', label: translate(m.archived_at ? 'inbox.action.unarchive' : 'inbox.action.archive'), run: () => st.markArchived(m.id, !m.archived_at) },
      { id: 'delete', icon: 'trash', label: translate('inbox.action.delete'), danger: true, run: () => { if (window.confirm(inboxDeleteConfirm(m))) st.remove(m.id) } },
    ]
  },
}

// 一封都没有时,主区阅读面板说「收件箱是空的」(InboxReaderView);列表这边就不再重复「暂无内容」。文案同一份。
setHostListEmpty(inboxListSource, {
  space: 'inbox', icon: Inbox,
  title: () => translate('inbox.reader.emptyTitle'), line: () => translate('inbox.reader.emptyLine'),
})

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
