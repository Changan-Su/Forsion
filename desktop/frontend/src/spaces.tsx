/** 具体的 Space 定义 + 注册入口。Space = 取代「App」的功能组合(见 engine/types.SpaceDefinition)。
 *  每个 Space 贡献一个 ribbon 顶部图标(可拖动改序,默认排在折叠钮之下、商店之上),点击切换。
 *  Tangu Space = 现有助手界面(会话/对话/文件/目录/记忆/子聊天)。Amadeus Space 见 Milestone 2。 */
import { Bot, Inbox, NotebookText, CalendarDays, Code2 } from 'lucide-react'
import { registerSpace, addRibbonIcon, useSpaceStore, setActiveSpace, useWorkspace, deleteNamedLayout, clearLayout, label } from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { PRODUCT } from './product'
import { useInbox } from './stores/inboxStore'
import { installAmadeusCommands } from './amadeusCommands'

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()

/** Space 的 ribbon 顶部图标:复用 .rb-btn,当前空间加 .on 高亮(订阅 activeSpaceId 自动刷新)。
 *  导出供用户自定义 Space(userSpaces.tsx)复用同一观感。 */
export function SpaceButton({ space, expanded }: { space: SpaceDefinition; expanded: boolean }) {
  const active = useSpaceStore((s) => s.activeSpaceId === space.id)
  // hook 无条件调用(React 规则),选择器按 space.id 归零:只有收件箱图标显示未读角标。
  const unread = useInbox((s) => (space.id === 'inbox' ? s.unreadCount : 0))
  const Icon = space.icon
  const name = label(space.name)
  return (
    <button
      className={`rb-btn rb-space${active ? ' on' : ''}`}
      title={expanded ? undefined : name}
      onClick={() => setActiveSpace(space.id)}
    >
      {Icon && <Icon size={18} />}
      {expanded && <span className="rb-label">{name}</span>}
      {unread > 0 && <span className="rb-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  )
}

/** Tangu Space 的侧栏默认:左=工作区(自动→会话);右=工作区(自动→文件)/大纲/记忆/子聊天 同组 tab。 */
const TANGU_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [{ type: 'workspace', params: {} }],
  right: [
    { type: 'workspace', params: {} },
    { type: 'outline', params: {} },
    { type: 'memory', params: {} },
    { type: 'subchats', params: {} },
  ],
}

const tanguSpace: SpaceDefinition = {
  id: 'tangu',
  name: () => app().tr('space.tangu'),
  icon: Bot,
  sidebarDefaults: TANGU_SIDE_VIEWS,
  /** 对话(主)→ 工作区(左,自动=会话)→ 右栏(工作区[自动=文件] + 大纲/记忆/子聊天 同组 tab)。窄屏右栏默认收起。 */
  build() {
    ws().setSidebarDefaults(TANGU_SIDE_VIEWS)
    ws().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
    ws().openView('workspace', {}, 'left')
    if (typeof window === 'undefined' || window.innerWidth >= 1100) {
      ws().openView('workspace', {}, 'right')
      ws().openView('outline', {}, 'right')
      ws().openView('memory', {}, 'right')
      ws().openView('subchats', {}, 'right')
    } else {
      ws().initializeSidebar('right', false)
    }
  },
}

/** Inbox Space:左=邮件列表;右=工作区(默认收起,toggle 可展)。主区 = 阅读面板。
 *  不定义 newPage(曾指向 singleton 的 inbox-reader,使 ＋ 键永远只是重激活已有面板 = 死键):
 *  ＋ 与「关掉最后一个主区 view」统一落 launcher,与 Tangu/Amadeus 一致。 */
const INBOX_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [{ type: 'inbox-list', params: {} }],
  right: [{ type: 'workspace', params: {} }],
}

const inboxSpace: SpaceDefinition = {
  id: 'inbox',
  name: () => app().tr('space.inbox'),
  icon: Inbox,
  sidebarDefaults: INBOX_SIDE_VIEWS,
  build() {
    ws().setSidebarDefaults(INBOX_SIDE_VIEWS)
    ws().openView('inbox-reader', {}, 'main')
    ws().openView('inbox-list', {}, 'left')
    ws().initializeSidebar('right', false)
  },
}

/** Amadeus Space 的侧栏默认:左=工作区(自动→笔记)/搜索/标签 同组 tab;右=大纲/反链/关系图 同组 tab。 */
const AMADEUS_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [
    { type: 'workspace', params: {} },
    { type: 'amadeus-search', params: {} },
    { type: 'amadeus-tags', params: {} },
  ],
  right: [
    { type: 'outline', params: {} },
    { type: 'amadeus-backlinks', params: {} },
    { type: 'amadeus-graph', params: {} },
  ],
}

const amadeusSpace: SpaceDefinition = {
  id: 'amadeus',
  name: () => app().tr('space.amadeus'),
  icon: NotebookText,
  sidebarDefaults: AMADEUS_SIDE_VIEWS,
  // 不定义 newPage:＋ 与「关掉最后一个主区 view」统一落到 launcher 启动器(与 Tangu Space 一致),
  // 启动器按当前 Space 列出可用视图 + 最近使用;「新建笔记」成为启动器里的一项。
  /** 编辑器(主)→ 左栏(笔记 + 搜索/标签 同组 tab)→ 右栏(大纲 + 反链 同组 tab)。
   *  openView 会把新面板设为活动 tab,故最后把「笔记」「大纲」拉回活动态。 */
  build() {
    ws().setSidebarDefaults(AMADEUS_SIDE_VIEWS)
    ws().openView('amadeus-editor', {}, 'main')
    const pagesLeaf = ws().openView('workspace', {}, 'left')
    ws().openView('amadeus-search', {}, 'left')
    ws().openView('amadeus-tags', {}, 'left')
    const outlineLeaf = ws().openView('outline', {}, 'right')
    ws().openView('amadeus-backlinks', {}, 'right')
    ws().openView('amadeus-graph', {}, 'right')
    if (outlineLeaf) ws().activateLeaf(outlineLeaf.id)
    if (pagesLeaf) ws().activateLeaf(pagesLeaf.id)
  },
}

/** Calendar Space:左=待办清单;主=日历;右=日历配置(颜色/显隐/默认库)。
 *  数据来自全库多维表的 todo / calendarDate 属性(dbAggregateStore)。 */
const CALENDAR_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [{ type: 'todo-list', params: {} }],
  right: [{ type: 'calendar-config', params: {} }],
}

const calendarSpace: SpaceDefinition = {
  id: 'calendar',
  name: () => app().tr('space.calendar'),
  icon: CalendarDays,
  sidebarDefaults: CALENDAR_SIDE_VIEWS,
  build() {
    ws().setSidebarDefaults(CALENDAR_SIDE_VIEWS)
    ws().openView('calendar', {}, 'main')
    ws().openView('todo-list', {}, 'left')
    ws().openView('calendar-config', {}, 'right')
  },
}

/** Coding Space:左=Tangu 对话(Prompt,复用 ChatView);主=Code|Preview 工作台;右=工作区文件树。
 *  模仿 Google AI Studio:左侧描述需求 → Coding Agent 生成 web app → 主区实时预览/改代码。
 *  新会话默认落 Coding Agent(不改全局 defaultSlug,只设新会话草稿)。 */
const CODING_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [{ type: 'chat', params: { followActive: true, reuseKey: 'primary' } }],
  right: [{ type: 'workspace', params: {} }],
}

const codingSpace: SpaceDefinition = {
  id: 'coding',
  name: () => app().tr('space.coding'),
  icon: Code2,
  sidebarDefaults: CODING_SIDE_VIEWS,
  // 左栏 = 对话(Prompt),当宽 IDE 侧栏用:可自由拖宽 + 记住宽度(默认比常规宽 20%)。
  resizableSides: { left: true },
  build() {
    ws().setSidebarDefaults(CODING_SIDE_VIEWS)
    app().selectNewChatAgent?.('coding') // 新会话默认 Coding agent
    ws().openView('code-studio', {}, 'main')
    ws().openView('chat', { followActive: true, reuseKey: 'primary' }, 'left')
    ws().openView('workspace', {}, 'right')
  },
}

/** 注册序 = ribbon 顶部默认序(在商店之上)。在 installEngine 内、商店图标注册之前调用。
 *  Amadeus 需 electron 的 window.amadeus 文件系统桥;Tangu Web(无 host)下不注册该 Space。
 *  2026-07-04 起对所有桌面用户开放(此前仅开发者模式 localStorage forsion_tangu_dev_mode='1');
 *  唯一闸改为 window.amadeus(host 文件系统桥)—— 消费处仍写 `window.amadeus && AMADEUS_ENABLED`,故 Web 端照常不注册。 */
export const AMADEUS_ENABLED = true // ponytail: 曾按 dev-mode 门控,现全量开放;闸只剩 window.amadeus(见各消费处的 && 前置)
// 产品档案过滤 × 运行时能力门控 叠加:档案没点名的 Space 直接不注册(单品变体);点名的仍受能力闸约束。
const SPACES: SpaceDefinition[] = [
  ...(PRODUCT.spaces.includes('tangu') ? [tanguSpace] : []),
  // Inbox 与视图注册同门控(桌面壳 backendStatus 或 移动端本地 inbox mobile;Tangu Web 两者皆无 → 不注册)。
  ...(PRODUCT.spaces.includes('inbox') && (window.tangu?.backendStatus || window.tangu?.mobile) ? [inboxSpace] : []),
  ...(PRODUCT.spaces.includes('amadeus') && window.amadeus && AMADEUS_ENABLED ? [amadeusSpace] : []),
  // Calendar 依赖 window.amadeus(跨库聚合走 vault 文件系统桥),与 Amadeus 同门控。
  ...(PRODUCT.spaces.includes('calendar') && window.amadeus && AMADEUS_ENABLED ? [calendarSpace] : []),
  // Coding 依赖 host 文件桥 + 本地静态预览服务器(仅桌面 electron;Tangu Web 无 codePreviewServe → 不注册)。
  ...(PRODUCT.spaces.includes('coding') && window.tangu?.codePreviewServe ? [codingSpace] : []),
]

export function registerSpaces(): void {
  for (const sp of SPACES) {
    registerSpace(sp)
    addRibbonIcon({ id: `space:${sp.id}`, side: 'top', component: ({ expanded }) => <SpaceButton space={sp} expanded={expanded} /> })
  }
  // 活动 Space 不在本产品档案里 → 回落档案默认(单品变体首启:localStorage 可能存着全家桶的 'tangu')。
  const activeId = useSpaceStore.getState().activeSpaceId
  if (SPACES.length && !SPACES.some((sp) => sp.id === activeId)) {
    const fallback = SPACES.some((sp) => sp.id === PRODUCT.defaultSpace) ? PRODUCT.defaultSpace : SPACES[0].id
    useSpaceStore.setState({ activeSpaceId: fallback })
    try { localStorage.setItem('forsion_tangu_active_space', fallback) } catch { /* ignore */ }
  }
  if (window.amadeus && AMADEUS_ENABLED) {
    installAmadeusCommands()
    // 旧 space:amadeus 命名布局没有新加的 搜索/标签/关系图 侧栏 tab → 一次性删除,下次进入按新默认重建。
    try {
      if (localStorage.getItem('amadeus_layout_v2') !== '1') {
        deleteNamedLayout('space:amadeus')
        // 上次退出停留在 Amadeus → 当前布局(LAYOUT_KEY)就是旧 Amadeus 布局,启动恢复会绕过命名布局迁移;
        // 一并清掉,onReady 落空走 buildDefault 按新默认重建(代价=丢一次该空间的布局微调,与命名布局同权衡)。
        if (localStorage.getItem('forsion_tangu_active_space') === 'amadeus') clearLayout()
        localStorage.setItem('amadeus_layout_v2', '1')
      }
    } catch { /* ignore */ }
  }
}
