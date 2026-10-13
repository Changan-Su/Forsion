/**
 * 收件箱 → 统一「工作区」左栏的列表源(2026-09-11,用户:「收件箱左边的 Panel 要接入工作区」)。
 *
 * 与青鸟收藏夹同一条契约(ListSourceContribution,View 基座 P2):数据与动作在这里,UI 全归工作区视图 ——
 * 行 = 会话 / 笔记同一个 SidebarRow,搜索框 / 分组(文件夹)/ 顶部动作 / 右键菜单都是宿主那一套。
 * 收件箱因此不再有自己的左栏组件(旧 Gmail 式 InboxListView 已删),Inbox Space 左栏就是 workspace 视图,
 * 自动档由 Space 默认档 + 阅读面板的 workspaceSource 指到这里;别的 Space 的工作区选择器里也能手动切到它。
 *
 * 行(2026-10-13 起两行):行首 = 谁发的(Agent 的头像,或 Forsion / 自动化 / 系统各一枚图标),标题 + 时间,
 *   下面一行「发信人 · 正文第一句」(ListItem.subtitle)。此前只有文档图标 + 标题 + 日期,像一排文件。
 * 分组(可选中的来源筛选,「全部」由宿主给):未读 / Forsion / 自动化 / 智能体 / 系统 / 已归档。
 * 来源顺序固定,只显示当前有消息的类别。不再按 agent slug 平铺,尤其 `automation:<ruleId>` 只是引擎路由标识,
 * 必须全部并入「自动化」,否则每条规则都会制造一个永久文件夹并泄漏内部 id。
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
import { useInbox, isAutomationSender, senderOf, parseUtc, type InboxMessage } from '../../stores/inboxStore'
import { INBOX_WORKSPACE_MODE } from '../workspaceMode'

// 源身份单源:从工作区模式串 `plugin:<pid>:<srcId>` 拆出来 —— Space 默认档 / workspaceSource / 注册三处永远一致。
const [, SOURCE_OWNER, SOURCE_ID] = INBOX_WORKSPACE_MODE.split(':')
const UNREAD = 'unread'
const ARCHIVED = 'archived'
const SOURCE = 'source:'

type SourceKind = 'forsion' | 'automation' | 'agents' | 'system'
// 图标按来源一处定:分组菜单、列表行首用的是同一枚(阅读面板头部的 SenderGlyph 画的也是这几个字形)。
const SOURCE_GROUPS: Array<{ kind: SourceKind; titleKey: string; icon: string }> = [
  { kind: 'forsion', titleKey: 'inbox.source.forsion', icon: 'cloud' },
  { kind: 'automation', titleKey: 'inbox.source.automation', icon: 'workflow' },
  { kind: 'agents', titleKey: 'inbox.source.agents', icon: 'agent' },
  { kind: 'system', titleKey: 'inbox.sender.system', icon: 'info' },
]
const SOURCE_ICON = Object.fromEntries(SOURCE_GROUPS.map((g) => [g.kind, g.icon])) as Record<SourceKind, string>

/** 列表行尾时间:7 天内相对时间,更早显示日期(单源 format/time,跟界面语言不跟系统区域)。 */
const timeAgo = (iso: string | null): string => formatListTime(parseUtc(iso))

const sourceKind = (m: InboxMessage): SourceKind => {
  if (m.sender_kind === 'server') return 'forsion'
  if (m.sender_kind === 'system') return 'system'
  return isAutomationSender(m) ? 'automation' : 'agents'
}
const sourceKey = (m: InboxMessage): string => `${SOURCE}${sourceKind(m)}`

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
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]/g, '')
      .replace(/^\s*(?:>\s*)*(?:\[![^\]]*\][+-]?\s*)?/, '')
      .replace(/^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, a: string, b?: string) => b || a)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*+|`+|~~/g, '')
      .replace(/\s+/g, ' ').trim()
    if (line && line !== title.trim()) return Array.from(line).slice(0, 80).join('')
  }
  return ''
}

/** 第二行:「发信人 · 正文第一句」;正文取不出字就只有发信人。列表行与仪表盘收件箱卡共用。 */
export function inboxSubtitle(m: InboxMessage): string {
  const snippet = inboxSnippet(m.body, m.title)
  return snippet ? `${senderOf(m)} · ${snippet}` : senderOf(m)
}

function toItem(m: InboxMessage): ListItem {
  const avatar = m.sender_kind === 'agent' && m.sender_id ? homeAgentAvatars()[m.sender_id] : undefined
  return {
    key: m.id,
    title: m.title,
    subtitle: inboxSubtitle(m),
    hint: timeAgo(m.created_at),
    // 行首 = 谁发的:Agent 有头像用头像(iconUrl),没有就是 agent 那枚;其余按来源。
    icon: SOURCE_ICON[sourceKind(m)],
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
    else if (group?.startsWith(SOURCE)) list = list.filter((m) => sourceKey(m) === group)
    const q = f?.query?.trim().toLowerCase()
    if (q) list = list.filter((m) => m.title.toLowerCase().includes(q) || (m.body || '').toLowerCase().includes(q) || senderOf(m).toLowerCase().includes(q))
    return list.map(toItem)
  },
  groups() {
    const st = useInbox.getState()
    const counts = new Map<SourceKind, number>()
    for (const m of st.messages) {
      if (m.archived_at) continue
      const kind = sourceKind(m)
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    const sources: ListGroup[] = SOURCE_GROUPS.flatMap(({ kind, titleKey, icon }) => {
      const count = counts.get(kind)
      return count ? [{ key: `${SOURCE}${kind}`, title: translate(titleKey), count, icon }] : []
    })
    return [
      { key: UNREAD, title: translate('inbox.filter.unread'), count: st.unreadCount },
      ...sources,
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
      { id: 'delete', icon: 'trash', label: translate('inbox.action.delete'), danger: true, run: () => { if (window.confirm(translate('inbox.deleteConfirm', { title: m.title }))) st.remove(m.id) } },
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
