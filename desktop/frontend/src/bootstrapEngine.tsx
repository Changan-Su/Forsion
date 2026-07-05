/** 真实引擎装配:注册视图(会话/对话)+ ribbon + 命令 + 默认布局。替代 demoBootstrap。 */
import { MessageCircle, Folder, Plus, Command as CommandIcon, Moon, Languages, MessageSquare, FolderOpen, BookOpen, Bot, Smartphone, Store, Settings, FileText, ListTree, Link2, Search, Hash, Waypoints, Inbox, Mail, PanelLeft } from 'lucide-react'
import { registerView, addCommand, addRibbonIcon, openCommandPalette, useWorkspace, getActiveSpace, recordNav, useNav, activeMainPanel, setEngineI18n } from '@lcl/engine'
import { useRecentViews } from './recentViews'
import { registerSpaces } from './spaces'
import { loadUserSpaces, saveCurrentAsSpace } from './userSpaces'
import { AccountCard } from './components/AccountCard'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { cycleLocale, useI18n } from './i18n'
import { ChatView } from './views/ChatView'
import { MemoryPanelView, SubchatsView } from './views/RightViews'
import { WorkspaceView, OutlineView } from './views/WorkspaceView'
import { NewTabView } from './views/NewTabView'
import { HomeEmptyView } from './views/HomeEmpty'
import { WeChatSpecialView, AgentsDetailSpecialView, WorkspaceDetailSpecialView } from './views/SpecialViews'
import { AmadeusEditorView, AmadeusBacklinksView } from './amadeusViews'
import { AmadeusSearchView, AmadeusTagsView, AmadeusLocalGraphView } from './amadeusPanels'
import { InboxListView } from './views/inbox/InboxListView'
import { InboxReaderView } from './views/inbox/InboxReaderView'
import { WsFileView } from './views/WsFileView'

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()
export const blankNewChat = (): void => {
  const s = app()
  s.setActiveId(null)
  s.setNewChatWs(null)
  s.setNewChatCfg(() => ({}))
  s.setNewChatModel(null)
  ws().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
}
/** 空侧栏占位内容(订阅 i18n,语言切换即时生效)。 */
function SidebarEmptyView() {
  const { t } = useI18n()
  return <div className="wb-sidebar-empty">{t('sidebar.empty')}</div>
}
const splitChat = (): void => {
  const active = ws().getActiveLeaf()
  if (active?.type !== 'chat') { ws().splitActive('right'); return }
  const pinned = typeof active.params.sessionId === 'string' ? active.params.sessionId : app().activeId
  ws().splitActive('right', { followActive: false, sessionId: pinned, reuseKey: `session:${pinned || 'new'}` })
}
let installed = false

export function installEngine(): void {
  if (installed) return
  installed = true

  setEngineI18n(useI18n) // LCL 引擎的 i18n 接缝:注入宿主 hook(引擎自身不依赖 desktop 的 i18n 实现)

  // 统一「工作区」视图(合并 原会话列表/工作区文件/笔记库):非 singleton —— 左右侧栏各放一个,
  // 各自独立的模式覆盖(存 leaf params);同侧防重复靠 openView 的「同侧同类型复用」。
  registerView({ type: 'workspace', displayName: () => app().tr('view.workspace'), icon: Folder, factory: (props) => <WorkspaceView {...props} /> })
  // 统一「大纲」视图(合并 原目录/Amadeus 大纲):随活动主视图切换采集器。
  registerView({ type: 'outline', displayName: () => app().tr('view.outline'), icon: ListTree, factory: () => <OutlineView />, singleton: true })
  // chat 可关闭(浏览器式):关掉主区最后一个 view → 显示「新建标签页」启动器(见 workspaceStore.closeLeaf)。
  registerView({ type: 'chat', displayName: () => app().tr('workbench.chat'), icon: MessageCircle, factory: (props) => <ChatView {...props} />, singleton: true })
  // 右栏视图(可关,可重开)
  registerView({ type: 'memory', displayName: () => app().tr('panel.tab.memory'), icon: BookOpen, factory: () => <MemoryPanelView />, singleton: true })
  registerView({ type: 'subchats', displayName: () => app().tr('panel.tab.subchats'), icon: MessageCircle, factory: () => <SubchatsView />, singleton: true })
  // 主区特殊视图(按需从侧栏打开,不进默认布局)
  registerView({ type: 'wechat', displayName: () => app().tr('special.wechat.title'), icon: Smartphone, factory: () => <WeChatSpecialView />, singleton: true })
  registerView({ type: 'agents-detail', displayName: () => app().tr('special.agents.title'), icon: Bot, factory: () => <AgentsDetailSpecialView />, singleton: true })
  registerView({ type: 'workspace-detail', displayName: () => app().tr('app.workspace'), icon: FolderOpen, factory: () => <WorkspaceDetailSpecialView />, singleton: true })
  // 新建标签页(空白启动器):列出所有视图按 主区/侧区 分类,选中即在对应区打开。
  registerView({ type: 'launcher', displayName: () => app().tr('newtab.title'), icon: Plus, factory: (props) => <NewTabView {...props} /> })
  // 工作区文件预览标签页(多实例,params.path 随布局持久化;打开一律走 views/wsFileNav.openWsFile,
  // 替代原 chatbox 上方的浮层预览 —— 浮层暂时停用,见 appStore.setFilePreview)。无条件注册:
  // Tangu Web 恢复含 wsfile 的布局不被整份丢弃,视图内对缺失的 host 能力自兜底占位。
  registerView({ type: 'wsfile', displayName: () => app().tr('view.wsfile'), icon: FileText, factory: (props) => <WsFileView {...props} /> })
  // 空侧栏占位:侧栏关空/拖空后由 closeLeaf/dropView 自动补上,保住 group 作拖放靶(整组只剩它时 tab 条隐藏,见 engine.css)。
  registerView({ type: 'sidebar-empty', displayName: () => app().tr('sidebar.emptyTitle'), icon: PanelLeft, factory: () => <SidebarEmptyView />, closable: false })
  // 主区空态占位:关掉最后一个主区 tab 后 closeLeaf 就地把该 leaf 变成它(Forsion 品牌图 + 新建;tab 条隐藏机关同 sidebar-empty)。
  registerView({ type: 'home', displayName: () => app().tr('newtab.title'), icon: Plus, factory: () => <HomeEmptyView />, closable: false })

  // Amadeus Space:原生可停靠视图(左 笔记列表 / 主 编辑器 / 右 大纲+反链),共享 pageStore。
  // Amadeus 依赖 electron 预载的 window.amadeus 文件系统桥;Tangu Web(无 host)下缺省 → 整个 Space 不注册,
  // 与 market/feedback 的 window.tangu?.X 门控同纪律。否则视图挂载即 deref undefined amadeus 崩溃。
  if (window.amadeus) {
    // 笔记库/大纲已并入统一的 workspace/outline 视图(见上);Amadeus 专属侧视图保留。
    // 编辑器 = 非 singleton 多实例(类 Obsidian 每笔记一个 tab,params.notePath 认领笔记并随布局持久化);
    // 可关闭:关到主区最后一个 → 落 launcher 启动器(见 workspaceStore.closeLeaf)。
    registerView({ type: 'amadeus-editor', displayName: () => app().tr('amadeus.editor'), icon: FileText, factory: (props) => <AmadeusEditorView {...props} /> })
    registerView({ type: 'amadeus-backlinks', displayName: () => app().tr('amadeus.backlinks'), icon: Link2, factory: () => <AmadeusBacklinksView />, singleton: true })
    registerView({ type: 'amadeus-search', displayName: () => app().tr('amadeus.search'), icon: Search, factory: () => <AmadeusSearchView />, singleton: true })
    registerView({ type: 'amadeus-tags', displayName: () => app().tr('amadeus.tags'), icon: Hash, factory: () => <AmadeusTagsView />, singleton: true })
    registerView({ type: 'amadeus-graph', displayName: () => app().tr('amadeus.graph'), icon: Waypoints, factory: () => <AmadeusLocalGraphView />, singleton: true })
  }

  // Inbox Space:收件箱(左 邮件列表 / 主 阅读面板)。数据来自本地后端 /agent/inbox。
  // gate = window.tangu?.backendStatus(桌面壳语义,含 external 模式;webShim 无 → Tangu Web 不注册,
  // 旧布局引用未注册视图由 workspaceStore.layoutViewsAllRegistered 整份回退,不崩)。
  if (window.tangu?.backendStatus || window.tangu?.mobile) {
    registerView({ type: 'inbox-list', displayName: () => app().tr('inbox.list'), icon: Inbox, factory: () => <InboxListView />, singleton: true })
    registerView({ type: 'inbox-reader', displayName: () => app().tr('inbox.reader'), icon: Mail, factory: () => <InboxReaderView />, singleton: true })
  }

  // Space:注册(注册序 = ribbon 顶部默认序,排在商店等功能图标之上;每个 Space 贡献一个可拖动的 ribbon 顶部图标)。
  // 同时按当前活动 Space 设侧栏默认,使恢复的非 Tangu Space 在首次 toggle 前即正确。
  registerSpaces()
  const activeSpace = getActiveSpace()
  if (activeSpace) ws().setSidebarDefaults(activeSpace.sidebarDefaults)
  // 用户自定义 Space(L0 数据 Space):~/.tangu/spaces 异步装载(注册完成后 ribbon 自动出现);仅桌面。
  if (window.tangu?.spacesList) void loadUserSpaces()

  // 对话会话切换 → 喂 per-tab 导航历史 + 启动器「最近使用」。
  // 时序:点会话列表是 setActiveId → openView,订阅同步 fire 时目标 chat leaf 可能尚未就位/激活,
  // 推迟一拍(microtask)再读 focusedChatLeafId。back/forward 复原:restore() 同步触发本订阅时
  // go() 的 navigating 闸仍未放开(其 finally 注册晚于订阅排队),microtask 里 record 仍被闸 ✓。
  useApp.subscribe((s, p) => {
    const id = s.activeId
    if (!id || id === p.activeId) return
    queueMicrotask(() => {
      const leafId = ws().focusedChatLeafId
      recordNav(leafId, `chat:${id}`, () => {
        app().setActiveId(id)
        if (leafId) ws().navigateLeaf(leafId, 'chat', { followActive: true, reuseKey: 'primary' })
      })
    })
    const title = s.sessions.find((x) => x.id === id)?.title
    useRecentViews.getState().record({ key: `chat:${id}`, kind: 'chat', id, title: title || app().tr('workbench.chat') })
  })

  // ribbon = 左侧功能条:顶部 = Space 图标组 + 商店;明暗/语言/反馈/命令面板与设置/账号移到底部常驻(在设置之上)。
  // 左右栏折叠钮在各自面板右缘(见 WorkspaceHost);ribbon 展开/折叠钮由 Ribbon 引擎自渲染在顶部。
  // 商店(装到 ~/.tangu)与反馈(submitFeedback)是 host 能力:Tangu Web 下 window.tangu 无对应方法 → 不注册。
  if (window.tangu?.marketList) addRibbonIcon({ id: 'rb-market', icon: Store, tooltip: () => app().tr('market.title'), onClick: () => app().openMarket() })
  addRibbonIcon({ id: 'rb-mode', side: 'bottom', icon: Moon, tooltip: () => app().tr('theme.changeMode'), onClick: () => useTheme.getState().toggleMode() })
  addRibbonIcon({ id: 'rb-locale', side: 'bottom', icon: Languages, tooltip: () => app().tr('locale.toggleTitle'), onClick: () => cycleLocale() })
  if (window.tangu?.submitFeedback) addRibbonIcon({ id: 'rb-feedback', side: 'bottom', icon: MessageSquare, tooltip: () => app().tr('feedback.title'), onClick: () => app().openFeedback() })
  addRibbonIcon({ id: 'rb-cmd', side: 'bottom', icon: CommandIcon, tooltip: () => app().tr('command.palette'), onClick: openCommandPalette })
  // 底部常驻(side:'bottom',不参与拖动排序),注册序即上下序:明暗/语言/反馈/命令 → 设置 → 账号(账号最底)。
  // 账号卡复用 AccountCard,随 ribbon 展开切换「完整卡 / 紧凑头像」;原聊天列表底部那份已移除,避免重复。
  addRibbonIcon({ id: 'rb-settings', side: 'bottom', icon: Settings, tooltip: () => app().tr('settings.title'), onClick: () => app().openSettings() })
  addRibbonIcon({
    id: 'rb-account',
    side: 'bottom',
    component: ({ expanded }) => (
      <AccountCard
        compact={!expanded}
        onToast={app().toast}
        onAuthChange={() => setTimeout(() => void app().connect(app().cfg), 1500)}
      />
    ),
  })

  // commands
  addCommand({ id: 'new-chat', title: () => app().tr('sidebar.newChat'), keywords: 'new chat 新对话', hotkey: 'mod+n', run: blankNewChat })
  addCommand({ id: 'toggle-left', title: () => app().tr('command.toggleLeft'), keywords: 'sidebar 左栏', hotkey: 'mod+b', run: () => ws().toggleSidebar('left') })
  addCommand({ id: 'toggle-right', title: () => app().tr('command.toggleRight'), keywords: 'sidebar 右栏', run: () => ws().toggleSidebar('right') })
  addCommand({ id: 'theme-mode', title: () => app().tr('theme.changeMode'), keywords: 'theme dark 明暗', run: () => useTheme.getState().toggleMode() })
  addCommand({ id: 'theme-skin', title: () => app().tr('theme.changeSkin'), keywords: 'theme skin 配色', run: () => useTheme.getState().cycleSkin() })
  addCommand({ id: 'theme-lang', title: () => app().tr('theme.changeLanguage'), keywords: 'theme language lovable soft', run: () => useTheme.getState().cycleLang() })
  addCommand({ id: 'split-right', title: () => app().tr('command.splitRight'), keywords: 'split 分屏', hotkey: 'mod+\\', run: splitChat })
  // per-tab 前进/后退(Ctrl/⌘+{ 与 }):只走当前活动主 leaf 的历史栈;与主区左上角箭头同源。
  const navGo = (dir: 'back' | 'forward'): void => {
    const api = ws().api
    const id = api ? activeMainPanel(api)?.id : null
    if (id) useNav.getState()[dir](id)
  }
  addCommand({ id: 'nav-back', title: () => app().tr('command.navBack'), keywords: 'back history 后退 历史', hotkey: 'mod+shift+[', run: () => navGo('back') })
  addCommand({ id: 'nav-forward', title: () => app().tr('command.navForward'), keywords: 'forward history 前进 历史', hotkey: 'mod+shift+]', run: () => navGo('forward') })
  addCommand({ id: 'reset-layout', title: () => app().tr('command.resetLayout'), keywords: 'layout reset default 布局 默认 黄金分割', run: () => ws().resetLayout() })
  // 另存为 Space:当前布局序列化成 ~/.tangu/spaces/<slug>/space.json 并注册(仅桌面)。
  if (window.tangu?.spacesSave) addCommand({ id: 'save-as-space', title: () => app().tr('command.saveAsSpace'), keywords: 'space 空间 另存 保存 custom', run: () => {
    const name = window.prompt(app().tr('spaces.namePrompt'))?.trim()
    if (name) void saveCurrentAsSpace(name)
  } })
  addCommand({ id: 'save-layout', title: () => app().tr('command.saveLayout'), keywords: 'layout workspace save 命名布局', run: () => {
    const name = window.prompt(app().tr('layout.namePrompt'))?.trim()
    if (name) { ws().saveNamed(name); app().toast(app().tr('layout.saved', { name })) }
  } })
  addCommand({ id: 'apply-layout', title: () => app().tr('command.applyLayout'), keywords: 'layout workspace restore 命名布局', run: () => {
    const names = ws().namedLayouts().filter((n) => !n.startsWith('space:')) // 隐藏 Space 内部保留布局
    if (!names.length) { app().toast(app().tr('layout.none')); return }
    const name = window.prompt(app().tr('layout.applyPrompt', { names: names.join(', ') }), names[0])?.trim()
    if (name && names.includes(name)) ws().applyNamed(name)
  } })
  addCommand({ id: 'stop-run', title: () => app().tr('command.stop'), keywords: 'stop 停止', run: () => app().stop() })
  addCommand({ id: 'compact', title: () => app().tr('command.compact'), keywords: 'compact 压缩', run: () => void app().compact() })
  addCommand({ id: 'branch', title: () => app().tr('command.branch'), keywords: 'branch 分支', run: () => void app().branchFromMessage() })
  addCommand({ id: 'open-settings', title: () => app().tr('settings.title'), keywords: 'settings 设置 preferences', hotkey: 'mod+,', run: () => app().openSettings() })
}

/** 默认布局 = 当前活动 Space 的 build()(WorkspaceHost 无保存布局时调用,经 buildDefault prop)。 */
export function buildDefaultLayout(): void {
  getActiveSpace()?.build()
}
