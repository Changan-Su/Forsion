/** 真实引擎装配:注册视图(会话/对话)+ ribbon + 命令 + 默认布局。替代 demoBootstrap。 */
import { MessageCircle, Folder, Plus, Command as CommandIcon, Moon, Languages, MessageSquare, FolderOpen, BookOpen, Bot, Store, Settings, FileText, FileImage, ListTree, Link2, Search, Hash, Waypoints, Inbox, Mail, PanelLeft, CalendarDays, ListTodo, Code2, Database, PenTool, Trophy, Activity, Workflow, Network, Rocket, LayoutDashboard } from 'lucide-react'
import { registerView, addCommand, addRibbonIcon, openCommandPalette, useWorkspace, useSpaceStore, getActiveSpace, setActiveSpaceCold, clearLayout, getView, label, recordNav, useNav, activeMainPanel, setEngineI18n, setRibbonActions, UI_MODE } from '@lcl/engine'
import { windowKind } from './windowKind'
import { askString } from '@amadeus/components/askString'
import { useQuickFind } from './quickFind'
import { useRecentViews } from './recentViews'
import { registerSpaces, DEFAULT_SPACE_KEY, LAST_EXIT_SPACE } from './spaces'
import { loadUserSpaces, saveCurrentAsSpace, createBlankSpace } from './userSpaces'
import { installAmadeusPlugins } from './amadeusPlugins'
import { installBuiltins } from './builtins'
import { AccountCard } from './components/AccountCard'
import { useApp } from './stores/appStore'
import { PRODUCT } from './product'
import { useTheme } from './stores/themeStore'
import { cycleLocale, useI18n } from './i18n'
import { ChatView } from './views/ChatView'
import { MemoryPanelView, SubchatsView, SessionFilesView } from './views/RightViews'
import { WorkspaceView, OutlineView } from './views/WorkspaceView'
import { NewTabView } from './views/NewTabView'
import { HomeEmptyView } from './views/HomeEmpty'
import { AgentsDetailSpecialView, WorkspaceDetailSpecialView } from './views/SpecialViews'
import { AmadeusEditorView, AmadeusBacklinksView } from './amadeusViews'
import { AmadeusDbView } from './views/AmadeusDbView'
import { AmadeusDrawingView } from './views/AmadeusDrawingView'
import { AmadeusDashboardView } from './views/AmadeusDashboardView'
import { AmadeusPluginFileView } from './views/AmadeusPluginFileView'
import { AmadeusPdfView } from './views/AmadeusPdfView'
import { AmadeusImageView } from './views/AmadeusImageView'
import { AmadeusSearchView, AmadeusTagsView, AmadeusLocalGraphView } from './amadeusPanels'
import { CalendarView } from './views/CalendarView'
import { CalendarConfigView } from './views/CalendarConfigView'
import { TodoListView } from './views/TodoListView'
import { InboxListView } from './views/inbox/InboxListView'
import { InboxReaderView } from './views/inbox/InboxReaderView'
import { WsFileView } from './views/WsFileView'
import { CodeStudioView } from './views/CodeStudioView'
import { PublicView } from './views/PublicView'
import { ChangelogView } from './views/ChangelogView'
import { setMobileUiCommand, MOBILE_UI_KEY } from './mobileUiCommand'
import { initUiZoom } from './uiZoom'
import { setActivityViewCommand, ACTIVITY_VIEW_KEY } from './activityViewCommand'
import { isSmoothCaretOn, setSmoothCaretEnabled } from './smoothCaret'
import { SMOOTH_CARET_KEY } from './types'
import { ActivityLogView } from './views/ActivityLogView'
import { AutomationListView } from './views/automation/AutomationListView'
import { AutomationDetailView } from './views/automation/AutomationDetailView'
import { AutomationRunsView } from './views/automation/AutomationRunsView'

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

  // 内置插件(浏览器 / 终端):默认开,可在 设置 → Forsion 插件 关掉。**放最前面**——它同时接管
  // 主进程回投的外链(app:open-url),排在几十个 registerView 之后的话,那些调用里任一处抛错
  // 都会让全应用的外链彻底失效(主进程已不再自己 openExternal)。也满足「早于布局恢复」的要求。
  installBuiltins()

  // 统一「工作区」视图(合并 原会话列表/工作区文件/笔记库):非 singleton —— 左右侧栏各放一个,
  // 各自独立的模式覆盖(存 leaf params);同侧防重复靠 openView 的「同侧同类型复用」。
  registerView({ type: 'workspace', displayName: () => app().tr('view.workspace'), icon: Folder, factory: (props) => <WorkspaceView {...props} /> })
  // 统一「大纲」视图(合并 原目录/Amadeus 大纲):随活动主视图切换采集器。
  registerView({ type: 'outline', displayName: () => app().tr('view.outline'), icon: ListTree, factory: () => <OutlineView />, singleton: true })
  // chat 可关闭(浏览器式):关掉主区最后一个 view → 显示「新建标签页」启动器(见 workspaceStore.closeLeaf)。
  if (PRODUCT.spaces.includes('tangu')) registerView({ type: 'chat', displayName: () => app().tr('workbench.chat'), icon: MessageCircle, factory: (props) => <ChatView {...props} />, singleton: true })
  // 右栏视图(可关,可重开)
  if (PRODUCT.spaces.includes('tangu')) registerView({ type: 'memory', displayName: () => app().tr('panel.tab.memory'), icon: BookOpen, factory: () => <MemoryPanelView />, singleton: true })
  if (PRODUCT.spaces.includes('tangu')) registerView({ type: 'subchats', displayName: () => app().tr('panel.tab.subchats'), icon: MessageCircle, factory: () => <SubchatsView />, singleton: true })
  if (PRODUCT.spaces.includes('tangu')) registerView({ type: 'session-files', displayName: () => app().tr('panel.tab.workspace'), icon: FolderOpen, factory: () => <SessionFilesView />, singleton: true })
  // 主区特殊视图(按需从侧栏打开,不进默认布局)。旧 'wechat' 视图已退役:恢复布局时未注册类型被引擎自动剔除。
  if (PRODUCT.spaces.includes('tangu')) registerView({ type: 'agents-detail', displayName: () => app().tr('special.agents.title'), icon: Bot, factory: () => <AgentsDetailSpecialView />, singleton: true })
  if (PRODUCT.spaces.includes('tangu')) registerView({ type: 'workspace-detail', displayName: () => app().tr('app.workspace'), icon: FolderOpen, factory: () => <WorkspaceDetailSpecialView />, singleton: true })
  // 新建标签页(空白启动器):列出所有视图按 主区/侧区 分类,选中即在对应区打开。
  registerView({ type: 'launcher', displayName: () => app().tr('newtab.title'), icon: Plus, factory: (props) => <NewTabView {...props} /> })
  // 工作区文件预览标签页(多实例,params.path 随布局持久化;打开一律走 views/wsFileNav.openWsFile,
  // 替代原 chatbox 上方的浮层预览 —— 浮层暂时停用,见 appStore.setFilePreview)。无条件注册:
  // Tangu Web 恢复含 wsfile 的布局不被整份丢弃,视图内对缺失的 host 能力自兜底占位。
  registerView({ type: 'wsfile', displayName: () => app().tr('view.wsfile'), icon: FileText, factory: (props) => <WsFileView {...props} /> })
  // Coding Space 主界面(Code | Preview 工作台);仅在产品档案点名 coding 时注册。
  if (PRODUCT.spaces.includes('coding')) registerView({ type: 'code-studio', displayName: () => app().tr('view.codeStudio'), icon: Code2, factory: (props) => <CodeStudioView {...props} />, singleton: true })
  // Public Space:管理已发布网站(Forsion Connect)+ 已公开发布/协作共享的笔记。档案点名 public 时注册。
  if (PRODUCT.spaces.includes('public')) registerView({ type: 'public-view', displayName: () => app().tr('view.publicHub'), icon: Rocket, factory: (props) => <PublicView {...props} />, singleton: true })
  // Automation Space 三件套(左=列表/主=详情+构建器/右=触发记录);仅档案点名 automation 时注册。
  if (PRODUCT.spaces.includes('automation')) {
    registerView({ type: 'automation-list', displayName: () => app().tr('view.automationList'), icon: Workflow, factory: () => <AutomationListView />, singleton: true })
    registerView({ type: 'automation-detail', displayName: () => app().tr('view.automationDetail'), icon: Workflow, factory: () => <AutomationDetailView />, singleton: true })
    registerView({ type: 'automation-runs', displayName: () => app().tr('view.automationRuns'), icon: ListTree, factory: () => <AutomationRunsView />, singleton: true })
  }
  // 「更新」标签页(更新日志 + 下载/安装):检测到新版自动弹出;任何产品变体都注册。
  registerView({ type: 'changelog', displayName: () => app().tr('view.changelog'), icon: FileText, factory: () => <ChangelogView />, singleton: true })
  // 活动日志实时视图(开发者工具):恒注册,⌘K 入口由开发者选项开关控制(activityViewCommand)。
  registerView({ type: 'activity-log', displayName: () => app().tr('view.activityLog'), icon: Activity, factory: () => <ActivityLogView />, singleton: true })
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
    // 独立 .db 数据库视图(多实例,params.dbPath 认领文件并随布局持久化;树上点 .db 打开,见 amadeusNav.openDb)。
    registerView({ type: 'amadeus-db', displayName: () => app().tr('view.db'), icon: Database, factory: (props) => <AmadeusDbView {...props} /> })
    // 独立白板视图(多实例,params.drawingPath 认领文件;树上点 .excalidraw.md / 笔记里点 [[X.excalidraw]] 打开,见 amadeusNav.openDrawing)。
    registerView({ type: 'amadeus-drawing', displayName: () => app().tr('view.drawing'), icon: PenTool, factory: (props) => <AmadeusDrawingView {...props} /> })
    // 独立仪表盘视图(多实例,params.dashPath 认领文件;树上点 .dashboard.md 打开,见 amadeusNav.openDashboard)。
    // 文件本身是一份合法笔记(布局记在外来 frontmatter 键),掉进笔记编辑器也不会坏 —— 见 shared/amadeus/dashboard.ts。
    registerView({ type: 'amadeus-dashboard', displayName: () => (document.documentElement.lang.startsWith('zh') ? '仪表盘' : 'Dashboard'), icon: LayoutDashboard, factory: (props) => <AmadeusDashboardView {...props} /> })
    // 独立 PDF 视图(多实例,params.pdfPath 认领文件;树上点 .pdf / 笔记里点 [[x.pdf#page=N]] 打开,见 amadeusNav.openPdf)。
    registerView({ type: 'amadeus-pdf', displayName: () => 'PDF', icon: FileText, factory: (props) => <AmadeusPdfView {...props} /> })
    // 独立图片视图(多实例,params.imagePath 认领文件;树上点 .png/.jpg 等打开,见 amadeusNav.openImage)。
    registerView({ type: 'amadeus-image', displayName: () => (document.documentElement.lang.startsWith('zh') ? '图片' : 'Image'), icon: FileImage, factory: (props) => <AmadeusImageView {...props} /> })
    // 通用「插件文件类型」视图(多实例,params.filePath 认领文件;树上点插件声明的文件类型 / 笔记里点
    // ![[x.ext]] 打开,见 amadeusNav.openFile + 插件的 ctx.registerFileType)。一个视图服务所有插件文件类型。
    registerView({ type: 'amadeus-plugin-file', displayName: () => (document.documentElement.lang.startsWith('zh') ? '插件文件' : 'Plugin File'), icon: FileText, factory: (props) => <AmadeusPluginFileView {...props} /> })
    registerView({ type: 'amadeus-backlinks', displayName: () => app().tr('amadeus.backlinks'), icon: Link2, factory: () => <AmadeusBacklinksView />, singleton: true })
    registerView({ type: 'amadeus-search', displayName: () => app().tr('amadeus.search'), icon: Search, factory: () => <AmadeusSearchView />, singleton: true })
    registerView({ type: 'amadeus-tags', displayName: () => app().tr('amadeus.tags'), icon: Hash, factory: () => <AmadeusTagsView />, singleton: true })
    registerView({ type: 'amadeus-graph', displayName: () => app().tr('amadeus.graph'), icon: Waypoints, factory: () => <AmadeusLocalGraphView />, singleton: true })
    // Calendar Space:待办清单(汇总全库 todo 属性)+ 日历(汇总全库 calendarDate 属性)。数据经 dbAggregateStore。
    registerView({ type: 'todo-list', displayName: () => app().tr('view.todo'), icon: ListTodo, factory: () => <TodoListView />, singleton: true })
    registerView({ type: 'calendar', displayName: () => app().tr('view.calendar'), icon: CalendarDays, factory: () => <CalendarView />, singleton: true })
    registerView({ type: 'calendar-config', displayName: () => app().tr('view.calendarConfig'), icon: Settings, factory: () => <CalendarConfigView />, singleton: true })
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
  // 启动策略(仅主窗、非移动端):默认或用户在「设置 → Spaces」指定的固定 Space,冷启动进其干净默认布局 ——
  // 不再被上次退出的布局强行覆盖(bug 修复)。选「上次退出的 Space」(LAST_EXIT_SPACE)则保留旧的
  // tryRestoreLayout 行为。卫星窗(detached/mini)有各自隔离的布局键 → 跳过,各恢复自身布局;
  // 移动端是另一套 SingleColumnHost(无 dockview onReady 恢复链)→ 不介入,保持其原生启动行为。
  if (windowKind() === 'main' && UI_MODE !== 'mobile') {
    let pref = PRODUCT.defaultSpace
    try { pref = localStorage.getItem(DEFAULT_SPACE_KEY) || PRODUCT.defaultSpace } catch { /* private mode */ }
    if (pref !== LAST_EXIT_SPACE) {
      const target = useSpaceStore.getState().spaces.some((s) => s.id === pref) ? pref : PRODUCT.defaultSpace
      setActiveSpaceCold(target) // 用户 L0 Space 作默认:此刻尚未异步装载 → 先回退 defaultSpace,下面 loadUserSpaces 完再补定位
      clearLayout()              // 清本窗布局键 → onReady 的 tryRestoreLayout 落空 → buildDefault 重建 target 的干净默认布局
    }
  }
  const activeSpace = getActiveSpace()
  if (activeSpace) {
    ws().setSidebarDefaults(activeSpace.sidebarDefaults)
    ws().setSideProfile(activeSpace.id, activeSpace.resizableSides ?? {}, activeSpace.sideDefaultScale) // 首启 Space 的可拖宽侧栏画像(须先于 onReady 的 pinSides)
  }
  // Forsion 插件在启动期就装(此前只在 Amadeus/Calendar/聊天输入框挂载时懒引导 → 从 Inbox 之类的 Space
  // 冷启动时插件根本没装):插件视图要尽早进注册表,内嵌 Space 才通得过「视图已注册」闸、旧布局引用
  // 插件视图也才恢复得回来。装完由 installAmadeusPlugins 自己补跑 loadUserSpaces。vault 恢复仍然懒。
  if (window.amadeus) installAmadeusPlugins()
  // 用户自定义 Space(L0 数据 Space):~/.tangu/spaces 异步装载(注册完成后 ribbon 自动出现);仅桌面。
  // 若「启动 Space」设置指向某用户 Space,它在上面的同步策略里尚未注册(回退了 defaultSpace)→ 装载完成后
  // 补一次冷定位 + resetLayout 重建(仅此情形有一瞬 Tangu→目标;默认是内置 Space 时下面整段早退不闪)。
  if (window.tangu?.spacesList) void loadUserSpaces().then(() => {
    if (windowKind() !== 'main' || UI_MODE === 'mobile') return
    let pref = ''
    try { pref = localStorage.getItem(DEFAULT_SPACE_KEY) || '' } catch { /* private mode */ }
    if (!pref || pref === LAST_EXIT_SPACE) return
    const sp = useSpaceStore.getState()
    if (sp.activeSpaceId === pref || !sp.spaces.some((s) => s.id === pref)) return // 已是它 / 仍未注册 → 不动
    setActiveSpaceCold(pref)
    ws().resetLayout() // 装载晚于 onReady 首建 → 补重建该用户 Space 的干净默认布局
  })

  // 对话会话切换 → 喂 per-tab 导航历史 + 启动器「最近使用」。
  // 时序:点会话列表是 setActiveId → openView,订阅同步 fire 时目标 chat leaf 可能尚未就位/激活,
  // 推迟一拍(microtask)再读 focusedChatLeafId。back/forward 复原:restore() 同步触发本订阅时
  // go() 的 navigating 闸仍未放开(其 finally 注册晚于订阅排队),microtask 里 record 仍被闸 ✓。
  useApp.subscribe((s, p) => {
    const id = s.activeId
    if (!id || id === p.activeId) return
    queueMicrotask(() => {
      const leafId = ws().focusedChatLeafId
      // 固定会话 leaf(followActive:false,新标签/分屏各自独立会话)不被「跟随」引擎回拽成主聊天。
      const leaf = leafId ? ws().api?.getPanel(leafId) : null
      const pinned = !!leaf && ((leaf.params ?? {}) as { followActive?: boolean }).followActive === false
      recordNav(leafId, `chat:${id}`, () => {
        app().setActiveId(id)
        if (leafId && !pinned) ws().navigateLeaf(leafId, 'chat', { followActive: true, reuseKey: 'primary' })
      })
    })
    const title = s.sessions.find((x) => x.id === id)?.title
    useRecentViews.getState().record({ key: `chat:${id}`, kind: 'chat', id, title: title || app().tr('workbench.chat') })
  })

  // 「最近使用」扩展到所有主区文件 + 功能视图(chat/note 已在上面 / amadeusViews 记账,此处只补其余):
  // 订阅主区标签变化 → 看活动主 leaf 的 __type + 身份参数记账。无身份的辅助视图(工作区/大纲/启动器等)不记。
  // ponytail: 只认 mainTabs 引用变化 → 活动文件「就地改名」(params 原地改、mainTabs 引用不变)不会即时补记,
  //   旧路径条目滞留到下次切标签才自愈;无损(点了顶多开个空视图),不值为它给活动面板打身份指纹。
  const RECENT_FILE_PARAM: Record<string, string> = {
    'amadeus-db': 'dbPath', 'amadeus-pdf': 'pdfPath', 'amadeus-drawing': 'drawingPath', 'amadeus-dashboard': 'dashPath', 'amadeus-image': 'imagePath', 'amadeus-plugin-file': 'filePath',
    'wsfile': 'path', // 工作区文件预览:只记有 path 的(tkey 瞬态目标无 path → 天然排除,重开不了)
  }
  const RECENT_VIEW_TYPES = new Set(['calendar', 'todo-list', 'inbox-reader', 'agents-detail', 'code-studio', 'automation-detail'])
  let lastRecentKey = ''
  useWorkspace.subscribe((st, prev) => {
    if (st.mainTabs === prev.mainTabs) return // 主区标签(含激活)变化才看
    const api = ws().api
    const p = api ? activeMainPanel(api) : null
    const params = (p?.params ?? {}) as Record<string, unknown>
    const type = typeof params.__type === 'string' ? params.__type : ''
    const fileParam = RECENT_FILE_PARAM[type]
    if (fileParam && typeof params[fileParam] === 'string') {
      const path = params[fileParam] as string
      const key = `file:${type}:${path}`
      if (key === lastRecentKey) return
      lastRecentKey = key
      useRecentViews.getState().record({ key, kind: 'file', id: path, viewType: type, title: path.split(/[\\/]/).pop() || path })
    } else if (RECENT_VIEW_TYPES.has(type) || type.startsWith('plugin:')) {
      const key = `view:${type}`
      if (key === lastRecentKey) return
      lastRecentKey = key
      const def = getView(type)
      useRecentViews.getState().record({ key, kind: 'view', id: type, viewType: type, title: def ? label(def.displayName) : type })
    }
  })

  // ribbon = 左侧功能条:顶部 = Space 图标组(可拖动改序);商店/明暗/语言/反馈/命令/设置/账号常驻底部。
  // 左右栏折叠钮在各自面板右缘(见 WorkspaceHost);ribbon 展开/折叠钮由 Ribbon 引擎自渲染在顶部。
  // 商店(装到 ~/.tangu)与反馈(submitFeedback)是 host 能力:Tangu Web 下 window.tangu 无对应方法 → 不注册。
  // 商店置于底部首位:注册序即上下序,故在 rb-mode 之前注册 → 落在底部组最上方。
  addRibbonIcon({ id: 'rb-search', side: 'bottom', icon: Search, tooltip: () => '快速查找', onClick: () => useQuickFind.getState().openPalette() })
  if (window.tangu?.marketList) addRibbonIcon({ id: 'rb-market', side: 'bottom', icon: Store, tooltip: () => app().tr('market.title'), onClick: () => app().openMarket() })
  addRibbonIcon({ id: 'rb-achievements', side: 'bottom', icon: Trophy, tooltip: () => app().tr('achievements.title'), onClick: () => app().openAchievements() })
  // 主题锁定明暗时 toggleMode 静默无效 → tooltip 改说明「由主题决定」,悬停即知为何点不动(codex Low-2)。
  addRibbonIcon({ id: 'rb-mode', side: 'bottom', icon: Moon, tooltip: () => useTheme.getState().modeLocked ? app().tr('settings.theme.modeLocked') : app().tr('theme.changeMode'), onClick: () => useTheme.getState().toggleMode() })
  addRibbonIcon({ id: 'rb-locale', side: 'bottom', icon: Languages, tooltip: () => app().tr('locale.toggleTitle'), onClick: () => cycleLocale() })
  if (window.tangu?.submitFeedback) addRibbonIcon({ id: 'rb-feedback', side: 'bottom', icon: MessageSquare, tooltip: () => app().tr('feedback.title'), onClick: () => app().openFeedback() })
  addRibbonIcon({ id: 'rb-cmd', side: 'bottom', icon: CommandIcon, tooltip: () => app().tr('command.palette'), onClick: openCommandPalette })
  // 底部常驻(side:'bottom',不参与拖动排序),注册序即上下序:明暗/语言/反馈/命令 → 设置 → 账号(账号最底)。
  // 账号卡复用 AccountCard,随 ribbon 展开切换「完整卡 / 紧凑头像」;原聊天列表底部那份已移除,避免重复。
  addRibbonIcon({ id: 'rb-settings', side: 'bottom', icon: Settings, tooltip: () => app().tr('settings.title'), onClick: () => app().openSettings() })
  if (PRODUCT.agentBackend) addRibbonIcon({
    id: 'rb-account',
    side: 'bottom',
    pinned: true, // 账号卡钉死最底:不参与拖拽/收纳/溢出
    component: ({ expanded }) => (
      <AccountCard
        compact={!expanded}
        onToast={app().toast}
        onAuthChange={() => setTimeout(() => void app().connect(app().cfg), 1500)}
      />
    ),
  })

  // ribbon 空白/＋ 号菜单的 feature 动作(引擎不 import feature 代码):新建空白 Space + 文本输入用 askString
  // (Electron 无 window.prompt)。newSpace 仅桌面(需 spacesSave 落盘);无则菜单不显示该项。
  setRibbonActions({
    newSpace: window.tangu?.spacesSave ? () => { void askString(app().tr('spaces.namePrompt')).then((v) => { const name = v?.trim(); if (name) void createBlankSpace(name) }) } : undefined,
    prompt: (title, initial) => askString(title, initial),
  })

  // commands
  if (PRODUCT.spaces.includes('tangu')) addCommand({ id: 'new-chat', title: () => app().tr('sidebar.newChat'), keywords: 'new chat 新对话', hotkey: 'mod+n', run: blankNewChat })
  // hotkey 从 mod+b 改到 mod+/:mod+b 与 Amadeus 编辑器的加粗(commonmark Mod-b)冲突,编辑时会同时切侧栏。
  // 换 mod+/ 是因为 mod+shift+b 也被编辑器占(blockquote),mod+\ 被 split-right 占;mod+/ app 命令表与编辑器 keymap 皆空闲。
  addCommand({ id: 'toggle-left', icon: PanelLeft, title: () => app().tr('command.toggleLeft'), keywords: 'sidebar 左栏', hotkey: 'mod+/', run: () => ws().toggleSidebar('left') })
  addCommand({ id: 'quick-find', icon: Search, title: () => '快速查找', keywords: 'search find quick 搜索 查找 快速', hotkey: 'mod+p', run: () => useQuickFind.getState().openPalette() })
  addCommand({ id: 'toggle-right', icon: PanelLeft, title: () => app().tr('command.toggleRight'), keywords: 'sidebar 右栏', run: () => ws().toggleSidebar('right') })
  addCommand({ id: 'theme-mode', icon: Moon, title: () => app().tr('theme.changeMode'), keywords: 'theme dark 明暗', run: () => useTheme.getState().toggleMode() })
  addCommand({ id: 'theme-skin', title: () => app().tr('theme.changeSkin'), keywords: 'theme skin 配色', run: () => useTheme.getState().cycleSkin() })
  addCommand({ id: 'theme-lang', title: () => app().tr('theme.changeLanguage'), keywords: 'theme language genesis lovable soft', run: () => useTheme.getState().cycleLang() })
  addCommand({ id: 'toggle-smooth-caret', title: () => app().tr('command.toggleSmoothCaret'), keywords: 'smooth caret cursor 光标 丝滑 word', run: () => {
    const on = !isSmoothCaretOn()
    try { localStorage.setItem(SMOOTH_CARET_KEY, on ? '1' : '0') } catch { /* ignore */ }
    setSmoothCaretEnabled(on)
  } })
  if (PRODUCT.spaces.includes('tangu')) addCommand({ id: 'split-right', title: () => app().tr('command.splitRight'), keywords: 'split 分屏', hotkey: 'mod+\\', run: splitChat })
  // per-tab 前进/后退(Ctrl/⌘+{ 与 }):只走当前活动主 leaf 的历史栈;与主区左上角箭头同源。
  const navGo = (dir: 'back' | 'forward'): void => {
    const api = ws().api
    const id = api ? activeMainPanel(api)?.id : null
    if (id) useNav.getState()[dir](id)
  }
  addCommand({ id: 'nav-back', title: () => app().tr('command.navBack'), keywords: 'back history 后退 历史', hotkey: 'mod+shift+[', run: () => navGo('back') })
  addCommand({ id: 'nav-forward', title: () => app().tr('command.navForward'), keywords: 'forward history 前进 历史', hotkey: 'mod+shift+]', run: () => navGo('forward') })
  addCommand({ id: 'reset-layout', title: () => app().tr('command.resetLayout'), keywords: 'layout reset default 布局 默认 黄金分割', run: () => ws().resetLayout() })
  // Mini 悬浮卡片(全局快捷键 ⌘/Ctrl+⇧+M 亦可):仅桌面(openMini 存在)。
  if (window.tangu?.openMini) addCommand({ id: 'open-mini', title: () => (document.documentElement.lang.startsWith('zh') ? '打开 Mini 卡片' : 'Open mini card'), keywords: 'mini card floating 悬浮 卡片 迷你 mini', run: () => window.tangu?.openMini?.() })
  // 另存为 Space:当前布局序列化成 ~/.tangu/spaces/<slug>/space.json 并注册(仅桌面)。
  if (window.tangu?.spacesSave) addCommand({ id: 'save-as-space', title: () => app().tr('command.saveAsSpace'), keywords: 'space 空间 另存 保存 custom', run: () => {
    void askString(app().tr('spaces.namePrompt')).then((v) => { const name = v?.trim(); if (name) void saveCurrentAsSpace(name) })
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
  if (PRODUCT.spaces.includes('tangu')) addCommand({ id: 'stop-run', title: () => app().tr('command.stop'), keywords: 'stop 停止', run: () => app().stop() })
  if (PRODUCT.spaces.includes('tangu')) addCommand({ id: 'compact', title: () => app().tr('command.compact'), keywords: 'compact 压缩', run: () => void app().compact() })
  if (PRODUCT.spaces.includes('tangu')) addCommand({ id: 'branch', title: () => app().tr('command.branch'), keywords: 'branch 分支', run: () => void app().branchFromMessage() })
  addCommand({ id: 'open-settings', icon: Settings, title: () => app().tr('settings.title'), keywords: 'settings 设置 preferences', hotkey: 'mod+,', run: () => app().openSettings() })
  // UI 缩放:应用持久值 + 注册放大/缩小/重置命令。端默认:桌面 Electron 1 / 触屏窄屏 1.15(同
  // singleColumn.css 移动 zoom 段) / 桌面浏览器(网页端) 1.1 / 移动端平板 1。
  {
    const w = window as { tangu?: { mobile?: boolean } }
    const coarse = ((): boolean => { try { return window.matchMedia('(pointer: coarse) and (max-width: 820px)').matches } catch { return false } })()
    initUiZoom(w.tangu && !w.tangu.mobile ? 1 : coarse ? 1.15 : w.tangu?.mobile ? 1 : 1.1)
  }
  // 开发者选项:移动端 UI 预览命令(开关持久化在 MOBILE_UI_KEY;已在移动模式则强制保留切回入口)。
  try { setMobileUiCommand(localStorage.getItem(MOBILE_UI_KEY) === '1') } catch { /* ignore */ }
  // 开发者选项:活动日志实时视图命令(同款模式)。
  try { setActivityViewCommand(localStorage.getItem(ACTIVITY_VIEW_KEY) === '1') } catch { /* ignore */ }
}

/** 默认布局 = 当前活动 Space 的 build()(WorkspaceHost 无保存布局时调用,经 buildDefault prop)。 */
export function buildDefaultLayout(): void {
  getActiveSpace()?.build()
}
