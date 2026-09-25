import { registerAmadeusViews } from './features/amadeus'
import { inboxAvailable } from './features/runtime'
import { registerTanguViews } from './features/tangu'
import { registerOperationsViews } from './features/operations'
import { hasNativeFeature, amadeusAvailable } from './features/runtime'
import { registerMiniViews } from './mini/miniViews'
/** 真实引擎装配:注册视图(会话/对话)+ ribbon + 命令 + 默认布局。替代 demoBootstrap。 */
import { MessageCircle, Folder, Plus, Command as CommandIcon, Moon, Languages, MessageSquare, Store, Settings, FileText, ListTree, Search, Inbox, Mail, PanelLeft, PanelBottom, Code2, Trophy, Activity, AppWindow, Sun, TextCursorInput } from 'lucide-react'
import type { LucideIcon, LucideProps } from 'lucide-react'
import { registerView, addCommand, addRibbonIcon, useRibbonStore, moveTo, openCommandPalette, useWorkspace, useSpaceStore, getActiveSpace, setActiveSpaceCold, setActiveSpace, adoptSpaceLayoutCold, BOOT_ACTIVE_SPACE_ID, getView, label, recordNav, useNav, activeMainPanel, setEngineI18n, setRibbonActions, UI_MODE, supportsMiniPanel, LCL_MESSAGES } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { useEffect } from 'react'
import { windowKind } from './windowKind'
import { askString } from '@amadeus/components/askString'
import { useQuickFind } from './quickFind'
import { findSupported, openFindBar } from './findInPage'
import { useRecentViews } from './recentViews'
import { planChatRestore, planSpaceSwitch } from './sessionOpenPlan'
import { registerSpaces, LAST_EXIT_SPACE, startupSpacePref, resolveStartupTarget } from './spaces'
import { loadUserSpaces, settleAsyncStartupSpace, saveCurrentAsSpace, createBlankSpace } from './userSpaces'
import { installAmadeusPlugins } from './amadeusPlugins'
import { installTanguProbe } from './tanguProbe'
import { installBuiltins } from './builtins'
import { AccountCard } from './components/AccountCard'
import { UnitSwitcher } from './components/UnitSwitcher'
import { useApp, activeChatModelId } from './stores/appStore'
import { openBtw } from './views/chat2/btwStore'
import { PRODUCT } from './product'
import { useTheme } from './stores/themeStore'
import { notifyApp } from './stores/notificationStore'
import { cycleLocale, registerMessages, translate, useI18n } from './i18n'
import { WorkspaceView, OutlineView } from './views/WorkspaceView'
import { NewTabView } from './views/NewTabView'
import { HomeEmptyView } from './views/HomeEmpty'
import { InboxReaderView } from './views/inbox/InboxReaderView'
import { registerInboxListSource } from './views/inbox/inboxListSource'
import { INBOX_WORKSPACE_MODE } from './views/workspaceMode'
import { WsFileView } from './views/WsFileView'
import { CodeStudioView } from './views/CodeStudioView'
import { ChangelogView } from './views/ChangelogView'
import { initUiZoom } from './uiZoom'
import { syncDevCommands } from './devCommands'
import { isSmoothCaretOn, setSmoothCaret } from './smoothCaret'
import { matchFileType, fileTypeBaseName } from './amadeus/plugins/pluginStore'
import { ActivityLogView } from './views/ActivityLogView'
import { ActiveWindowView } from './views/ActiveWindowView'
import { ActivityDashboardCard, InboxDashboardCard } from './views/DashboardCompactViews'
import { installDeepLinks } from './deepLinkInstall'
import { FILE_VIEW_PARAM } from './viewFileMatch'

// 本文件自有的词条(命名空间 `bootengine.*`,勿与别处撞键)。视图 displayName / 命令 title 都是
// **惰性**求值的函数,所以一律在函数体里调 translate(),语言切换后重取即新文案(勿提到模块常量里)。
registerMessages({
  'bootengine.view.chatPanel': { zh: '对话面板', en: 'Chat panel' },
  'bootengine.view.dashboard': { zh: '仪表盘', en: 'Dashboard' },
  'bootengine.view.image': { zh: '图片', en: 'Image' },
  'bootengine.view.media': { zh: '媒体', en: 'Media' },
  'bootengine.view.pluginFile': { zh: '插件文件', en: 'Plugin file' },
  'bootengine.cmd.quickFind': { zh: '快速查找', en: 'Quick find' },
  'bootengine.cmd.openNote': { zh: '打开笔记', en: 'Open note' },
  'bootengine.cmd.setActiveSpace': { zh: '切换 Space', en: 'Switch Space' },
  'bootengine.cmd.findInPage': { zh: '页内查找', en: 'Find in page' },
  'bootengine.cmd.showChatPanel': { zh: '显示对话面板', en: 'Show chat panel' },
  'bootengine.cmd.openMini': { zh: '打开 Mini 卡片', en: 'Open mini card' },
})

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
/** 空占位内容(订阅 i18n,语言切换即时生效)。同一个视图服务左右侧栏与**底部面板**,
 *  故文案按所在区取:底部说「面板」不说「侧栏」。tab 标题在 displayName 里拿不到 leaf,
 *  只能在这儿按区改写(WbTab 订阅了 onDidTitleChange,改完即刷)。 */
function SidebarEmptyView({ leaf }: ViewProps) {
  const { t } = useI18n()
  const bottom = leaf.loc === 'bottom'
  useEffect(() => { if (bottom) leaf.setTitle(t('panel.emptyTitle')) }, [bottom, leaf, t])
  return <div className="wb-sidebar-empty">{t(bottom ? 'panel.empty' : 'sidebar.empty')}</div>
}
const splitChat = (): void => {
  const active = ws().getActiveLeaf()
  if (active?.type !== 'chat') { ws().splitActive('right'); return }
  const pinned = typeof active.params.sessionId === 'string' ? active.params.sessionId : app().activeId
  ws().splitActive('right', { followActive: false, sessionId: pinned, reuseKey: `session:${pinned || 'new'}` })
}
/** Ribbon 明暗钮的图标跟随当前明暗:暗色显示 Sun(点了变亮),亮色显示 Moon(点了变暗)。
 *  做成读 store 的组件而不是换注册:RibbonItem.icon 是静态字段,主页坞 / 移动单列壳也直接拿它渲染。 */
const ThemeModeIcon = ((props: LucideProps) => {
  const dark = useTheme((s) => s.mode === 'dark')
  return dark ? <Sun {...props} /> : <Moon {...props} />
}) as unknown as LucideIcon

let installed = false

export function installEngine(): void {
  if (installed) return
  installed = true

  // LCL 引擎的 i18n 接缝:注入宿主 hook + 非 hook 的 translate(引擎自身不依赖 desktop 的 i18n 实现);
  // 引擎自带的 lcl.* 文案先并进宿主字典,切语言走宿主 context 当场生效。
  registerMessages(LCL_MESSAGES)
  setEngineI18n(useI18n, translate)

  // 内置插件(浏览器 / 终端):默认开,可在 设置 → Forsion 插件 关掉。**放最前面**——它同时接管
  // 主进程回投的外链(app:open-url),排在几十个 registerView 之后的话,那些调用里任一处抛错
  // 都会让全应用的外链彻底失效(主进程已不再自己 openExternal)。也满足「早于布局恢复」的要求。
  installBuiltins()

  // 统一「工作区」视图(合并 原会话列表/工作区文件/笔记库):非 singleton —— 左右侧栏各放一个,
  // 各自独立的模式覆盖(存 leaf params);同侧防重复靠 openView 的「同侧同类型复用」。
  registerView({ type: 'workspace', kind: 'collection', displayName: () => app().tr('view.workspace'), icon: Folder, factory: (props) => <WorkspaceView {...props} /> })
  // 统一「大纲」视图(合并 原目录/Amadeus 大纲):随活动主视图切换采集器。
  registerView({ type: 'outline', kind: 'aux', embeddable: true, displayName: () => app().tr('view.outline'), icon: ListTree, factory: (props) => <OutlineView {...props} />, singleton: true })
  registerTanguViews()
  // 新建标签页(空白启动器):列出所有视图按 主区/侧区 分类,选中即在对应区打开。
  registerView({ type: 'launcher', kind: 'page', displayName: () => app().tr('newtab.title'), icon: Plus, factory: (props) => <NewTabView {...props} /> })
  // 工作区文件预览标签页(多实例,params.path 随布局持久化;打开一律走 views/wsFileNav.openWsFile,
  // 替代原 chatbox 上方的浮层预览 —— 浮层暂时停用,见 appStore.setFilePreview)。无条件注册:
  // Tangu Web 恢复含 wsfile 的布局不被整份丢弃,视图内对缺失的 host 能力自兜底占位。
  registerView({ type: 'wsfile', kind: 'entity', idParam: 'path', displayName: () => app().tr('view.wsfile'), icon: FileText, factory: (props) => <WsFileView {...props} /> })
  // Coding Space 主界面(Code | Preview 工作台);仅在产品档案点名 coding 时注册。
  if (PRODUCT.nativeFeatures === undefined && PRODUCT.spaces.includes('coding')) registerView({ type: 'code-studio', kind: 'page', displayName: () => app().tr('view.codeStudio'), icon: Code2, factory: (props) => <CodeStudioView {...props} />, singleton: true })
  registerOperationsViews()
  // 「更新」标签页(更新日志 + 下载/安装):检测到新版自动弹出;任何产品变体都注册。
  registerView({ type: 'changelog', kind: 'page', embeddable: true, displayName: () => app().tr('view.changelog'), icon: FileText, factory: () => <ChangelogView />, singleton: true })
  // 活动日志实时视图(开发者工具):恒注册,⌘K 入口由开发者选项开关控制(activityViewCommand)。
  registerView({
    type: 'activity-log', kind: 'page', embeddable: true,
    displayName: () => app().tr('view.activityLog'), icon: Activity,
    factory: () => <ActivityLogView />, singleton: true,
    dashboard: { sizes: ['wide', 'lg', 'full'], defaultSize: 'wide', surface: 'summary', factory: (_props, ctx) => <ActivityDashboardCard size={ctx.size} /> },
  })
  // 前台窗口采样调试面板(开发者工具):同款纪律 —— 视图恒注册,⌘K 入口跟着采样开关走。
  registerView({ type: 'active-window', kind: 'page', embeddable: true, displayName: () => app().tr('view.activeWindow'), icon: AppWindow, factory: () => <ActiveWindowView />, singleton: true })
  // 空侧栏占位:侧栏关空/拖空后由 closeLeaf/dropView 自动补上,保住 group 作拖放靶(整组只剩它时 tab 条隐藏,见 engine.css)。
  registerView({ type: 'sidebar-empty', kind: 'page', displayName: () => app().tr('sidebar.emptyTitle'), icon: PanelLeft, factory: (props) => <SidebarEmptyView {...props} />, closable: false })
  // 主区空态占位:关掉最后一个主区 tab 后 closeLeaf 就地把该 leaf 变成它(Forsion 品牌图 + 新建;tab 条隐藏机关同 sidebar-empty)。
  registerView({ type: 'home', kind: 'page', displayName: () => app().tr('newtab.title'), icon: Plus, factory: () => <HomeEmptyView />, closable: false })

  registerAmadeusViews()

  // Inbox Space:收件箱(左 统一工作区·收件箱列表源 / 主 阅读面板)。数据来自本地后端 /agent/inbox。
  // gate = inboxAvailable():旧档案 spaces 点名 + 桌面壳 backendStatus(含 external 模式)或移动端 mobile;
  // Unit 宿主 = tangu 包 + 本地引擎。webShim / 云端 Unit 无 backendStatus → 不注册,
  // 旧布局引用未注册视图由 workspaceStore.layoutViewsAllRegistered 整份回退,不崩。
  if (inboxAvailable()) {
    // 收件箱列表 = 统一「工作区」视图的一个列表源(2026-09-11,与青鸟收藏夹同一条契约);阅读面板声明 workspaceSource,
    // 它做活动主视图时左栏自动切到收件箱。inbox-list 类型保留给仪表盘卡片;整页渲染也换成 WorkspaceView ——
    // 移动端单列壳的持久化布局不跑 lcl 的退役迁移,留着的 inbox-list 叶子照样落到新 UI。
    registerInboxListSource()
    registerView({
      type: 'inbox-list', kind: 'collection', embeddable: true,
      displayName: () => app().tr('inbox.list'), icon: Inbox, factory: (props) => <WorkspaceView {...props} defaultMode={INBOX_WORKSPACE_MODE} />, singleton: true,
      dashboard: { sizes: ['wide', 'lg', 'full'], defaultSize: 'lg', surface: 'summary', factory: (_props, ctx) => <InboxDashboardCard size={ctx.size} /> },
    })
    registerView({ type: 'inbox-reader', kind: 'page', displayName: () => app().tr('inbox.reader'), icon: Mail, factory: () => <InboxReaderView />, singleton: true, workspaceSource: INBOX_WORKSPACE_MODE })
  }

  // Space:注册(注册序 = ribbon 顶部默认序,排在商店等功能图标之上;每个 Space 贡献一个可拖动的 ribbon 顶部图标)。
  // 同时按当前活动 Space 设侧栏默认,使恢复的非 Tangu Space 在首次 toggle 前即正确。
  registerMiniViews()
  registerSpaces()
  // 启动策略(仅主窗、非移动端)。「设置 → Spaces → 启动时进入」:
  //  · 缺省 = 上次退出的那个 Space(LAST_EXIT_SPACE):id 不动,布局键原样交给 tryRestoreLayout
  //    → 连同上次开着的标签页一起回来。仍走一次归档(from===to 只写命名槽、不碰布局键),
  //    好让此后切到别的 Space 再切回来时槽里是新的。
  //  · 固定某 Space:冷启动进**那个 Space 自己上次的布局**(不是上次退出那个 Space 的布局 ——
  //    那是原来的 bug;也不是每次都推倒重建 —— 那是修那个 bug 时的过头做法,表现为
  //    「每次重启都丢上次打开的文件」)。
  // 卫星窗(detached/mini)有各自隔离的布局键 → 跳过,各恢复自身布局;
  // 移动端是另一套 SingleColumnHost(自带 restoreSingleColumnLayout,本就恢复上次)→ 不介入。
  if (windowKind() === 'main' && UI_MODE !== 'mobile') {
    // 上次退出在哪:用模块装载时的快照,**不是**此刻的 activeSpaceId —— 上面的 registerSpaces()
    // 已经把「尚未注册」的用户 Space id 归一成了产品默认(见 BOOT_ACTIVE_SPACE_ID 的注释)。
    const lastExit = BOOT_ACTIVE_SPACE_ID
    const target = resolveStartupTarget(lastExit)
    // 用户 L0 Space 作目标:此刻尚未异步装载 → setActiveSpaceCold 认不出会自己放过,下面 loadUserSpaces 完再补定位
    setActiveSpaceCold(target)
    adoptSpaceLayoutCold(lastExit, target)
  }
  const activeSpace = getActiveSpace()
  if (activeSpace) {
    ws().setSidebarDefaults(activeSpace.sidebarDefaults)
    ws().setSideProfile(activeSpace.id, activeSpace.resizableSides ?? {}, activeSpace.sideDefaultScale) // 首启 Space 的可拖宽侧栏画像(须先于 onReady 的 pinSides)
  }
  // Forsion 插件在启动期就装(此前只在 Amadeus/Calendar/聊天输入框挂载时懒引导 → 从 Inbox 之类的 Space
  // 冷启动时插件根本没装):插件视图要尽早进注册表,内嵌 Space 才通得过「视图已注册」闸、旧布局引用
  // 插件视图也才恢复得回来。装完由 installAmadeusPlugins 自己补跑 loadUserSpaces。vault 恢复仍然懒。
  // unit 设备页(B 端渲染)没有 vault 桥(window.amadeus 缺席,本地 vault 面=v2.1)但**必须装宿主**:
  // 对方设备的插件清单经 unit/plugins 分发,视图/命令类插件不依赖 vault 即可工作(方案 §11.4)。
  // 插件的 Tangu 只读探针(ctx.tangu:当前模型 / 当前 Space)。**必须早于 installAmadeusPlugins**:
  // ctx.tangu 的有无是在建 plugin context 那一刻定的。见 amadeus/plugins/tanguSeam.ts。
  if (PRODUCT.nativeFeatures === undefined || hasNativeFeature('tangu') || hasNativeFeature('automation')) installTanguProbe()
  if (window.amadeus || window.tangu?.unitPage) installAmadeusPlugins()
  // 用户自定义 Space(L0 数据 Space):~/.tangu/spaces 异步装载(注册完成后 ribbon 自动出现);仅桌面。
  // 上面的同步策略跑在装载之前,若目标是某个用户 Space,那时它还没注册 → 装载完成后补定位。两种补法:
  //  · 固定启动 Space:走正常切换(此时已晚于 onReady,api 就绪),它会存出回退 Space 的布局并还原目标
  //    Space 上次的(没有才重建默认)。仅此情形有一瞬 Tangu→目标;目标是内置 Space 时整段早退不闪。
  //  · 上次退出的 Space:布局键里本来就是它的现场(tryRestoreLayout 已吃下),只是 registerSpaces() 把
  //    活动 id 归一成了产品默认 → **冷**定位回去(setActiveSpace 会把这份现场 saveNamed 进产品默认的槽
  //    = 归档到别人名下),顺手补该 Space 的侧栏默认/可拖宽画像。
  if (window.tangu?.spacesList) void loadUserSpaces().then(settleAsyncStartupSpace)

  // 「当前会话」按 Space 分账(2026-08-23):切 Space 时把老 Space 那条存进账本、还原新 Space 上次那条。
  // 不分账的话所有跟随档 chat leaf 共用一个 activeId —— Tangu 主 tab 开的会话会原样出现在 Amadeus 侧栏
  // 那份陪伴聊天里,且双向互拖(用户实报)。判定见 planSpaceSwitch;Space **内部**的跟随语义原样不动。
  // 只留内存:多窗口按 URL 参数隔离(勿写 localStorage),重启后照旧走 appStore 的启动兜底。
  const spaceSessions = new Map<string, string | null>()
  useSpaceStore.subscribe((s, p) => {
    if (s.activeSpaceId === p.activeSpaceId) return
    const a = app()
    const alive = (id: string): boolean => a.sessions.some((x) => x.id === id) || a.archivedSessions.some((x) => x.id === id)
    // Space 账本只是恢复该 Space 上次的聊天焦点,不是一次用户「进入 Project」动作。
    // 若走 setActiveId 的默认副作用,切回 Tangu 会把该会话所属项目(常见即默认工作区)强制展开。
    a.setActiveId(planSpaceSwitch(spaceSessions, p.activeSpaceId, s.activeSpaceId, a.activeId, alive), { revealWorkspace: false })
  })

  // 对话会话切换 → 喂 per-tab 导航历史 + 启动器「最近使用」。
  // 时序:点会话列表是 setActiveId → openView,订阅同步 fire 时目标 chat leaf 可能尚未就位/激活,
  // 推迟一拍(microtask)再问当前活动主 leaf。back/forward 复原:restore() 同步触发本订阅时
  // go() 的 navDepth 仍未回零(其 finally 注册晚于订阅排队),microtask 里 record 仍被闸 ✓。
  // ⚠️ 归属必须是**主区活动 leaf**,不能用 focusedChatLeafId:它跟着「最后被激活的聊天」跑,而侧栏那份
  //    常驻陪伴聊天一被点就把它抢走 —— 历史记进侧栏的栈,箭头只读主区活动 tab 的栈 → 箭头恒灰(实报的
  //    「有时候失效」)。侧栏聊天自身不记历史(用户 2026-08-17 拍板:谁都不记)。
  useApp.subscribe((s, p) => {
    const id = s.activeId
    if (!id || id === p.activeId) return
    queueMicrotask(() => {
      // ⚠️ 移动单列壳 `api` 恒 null(同 amadeusViews 那条 leafById 告警)→ 必须退回 focusedChatLeafId,
      //    否则安卓返回键再也走不动会话(手机没有侧栏聊天,抢不走它,上面那个坑在单列壳里不存在)。
      //    check:parity 抓不到这种「不是类型错、也不崩,只是静默少功能」。
      const api = ws().api
      const am = api ? activeMainPanel(api) : null
      const leafId = api
        ? (am && ((am.params ?? {}) as { __type?: string }).__type === 'chat' ? am.id : null)
        : ws().focusedChatLeafId
      recordNav(leafId, `chat:${id}`, () => {
        // 状态在**复原当时**现读:主聊天可能已被冻成钉住档(见 sessionNav.freezeMainPrimary)。
        const w = ws()
        const cur = leafId ? w.leafById(leafId) : null
        switch (planChatRestore(cur)) {
          case 'follow': app().setActiveId(id); break
          case 'pin': cur!.setParams({ sessionId: id }); break
          case 'navigate': w.navigateLeaf(leafId!, 'chat', { sessionId: id, followActive: false }); break
        }
      })
    })
    const title = s.sessions.find((x) => x.id === id)?.title
    useRecentViews.getState().record({ key: `chat:${id}`, kind: 'chat', id, title: title || app().tr('workbench.chat') })
  })

  // 「最近使用」扩展到所有主区文件 + 功能视图(chat/note 已在上面 / amadeusViews 记账,此处只补其余):
  // 订阅主区标签变化 → 看活动主 leaf 的 __type + 身份参数记账。无身份的辅助视图(工作区/大纲/启动器等)不记。
  // 只认 mainTabs 引用变化 —— 2026-08-20 起 refreshTabs 把「身份参数指纹」(identitySig)算进比对、
  //   setParams 也发 refreshTabs,所以「同一个 tab 里换一个文件」这类**就地跳转**同样会到达这里
  //   (此前一律看不见 → 用户实报「同一个 View 里页面跳转,前进后退无法识别」)。
  const RECENT_FILE_PARAM: Record<string, string> = {
    ...FILE_VIEW_PARAM, // 与树行高亮共用一张(曾各抄一份,仪表盘改名后两份都漏)
    'wsfile': 'path', // 工作区文件预览:只记有 path 的(tkey 瞬态目标无 path → 天然排除,重开不了)
  }
  const RECENT_VIEW_TYPES = new Set(['calendar', 'todo-list', 'inbox-reader', 'agents-detail', 'code-studio', 'automation-detail'])
  let lastRecentKey = ''
  useWorkspace.subscribe((st, prev) => {
    if (st.mainTabs === prev.mainTabs) return // 主区标签(含激活)变化才看
    const api = ws().api
    // ⚠️ 移动单列壳 `api` 恒 null → 退回激活的主 tab + leafById(两壳都有);类型取 tab.type,
    //    单列壳 navigateLeaf 存的是裸参数、不带 __type。不退:手机上文件/功能视图一条历史、一条最近使用都不记,
    //    安卓返回键从 PDF 直接关标签(笔记丢了),check:parity 抓不到。桌面 api 为空时 mainTabs 恒 [],行为不变。
    //    迷你面板也是单列 store,但不退:它的主 leaf 是紧凑视图(插件的 plugin:*:mini 适配器),记进与主窗共享的
    //    最近使用 = 主窗把紧凑适配器开进主区(Codex 评审);同理 amadeusViews 的仪表盘跳过在迷你面板里不生效。
    const tab = api || windowKind() === 'mini' ? undefined : st.mainTabs.find((t) => t.active)
    const p = api ? activeMainPanel(api) : tab ? ws().leafById(tab.id) : null
    const params = (p?.params ?? {}) as Record<string, unknown>
    const type = tab ? tab.type : typeof params.__type === 'string' ? params.__type : ''
    const fileParam = RECENT_FILE_PARAM[type]
    // per-tab 导航历史(2026-08-17):PDF/白板/多维表/图片/仪表盘/插件文件/工作区预览此前一条都不记,
    // 于是这类标签的箭头恒灰,同一标签里「笔记→PDF→笔记」中间那步也会被跳过。restore 只碰本 leaf。
    // ⚠️ 记在 lastRecentKey 去重**之前**:那是「最近使用」用的全局单值,拿它挡会漏掉「同一个文件在
    //    第二个标签里打开」——那个新标签的栈会一条都没有(=箭头恒灰,又一种「失效」)。
    const navKey = fileParam && typeof params[fileParam] === 'string' ? `file:${type}:${params[fileParam] as string}`
      : (RECENT_VIEW_TYPES.has(type) || type.startsWith('plugin:')) ? `view:${type}` : null
    if (p && navKey) {
      const restoreParams = fileParam ? { [fileParam]: params[fileParam] } : {}
      recordNav(p.id, navKey, () => useWorkspace.getState().navigateLeaf(p.id, type, restoreParams))
    }
    if (fileParam && typeof params[fileParam] === 'string') {
      const path = params[fileParam] as string
      const key = `file:${type}:${path}`
      if (key === lastRecentKey) return
      lastRecentKey = key
      // 插件复合后缀文件与树上/tab 同口径剥全后缀(Foo.canvas.md → Foo),别的文件保持原样文件名。
      const ft = type === 'amadeus-plugin-file' ? matchFileType(path) : undefined
      const title = ft ? fileTypeBaseName(path, ft.extensions) : path.split(/[\\/]/).pop() || path
      useRecentViews.getState().record({ key, kind: 'file', id: path, viewType: type, title })
    } else if (RECENT_VIEW_TYPES.has(type) || type.startsWith('plugin:')) {
      const key = `view:${type}`
      if (key === lastRecentKey) return
      lastRecentKey = key
      const def = getView(type)
      useRecentViews.getState().record({ key, kind: 'view', id: type, viewType: type, title: def ? label(def.displayName) : type })
    }
  })

  // ribbon = 左侧功能条:顶部 = Space 图标组(可拖动改序);反馈/商店/成就/明暗/命令/设置/账号常驻底部。
  // 左右栏折叠钮在各自面板右缘(见 WorkspaceHost);ribbon 展开/折叠钮由 Ribbon 引擎自渲染在顶部。
  // 商店(装到 ~/.tangu)与反馈(submitFeedback)是 host 能力:Tangu Web 下 window.tangu 无对应方法 → 不注册
  // (两者都是 ribbon 图标 + 命令面板两条路)。
  // 反馈、商店置于底部最上方:无持久顺序时注册序即上下序,故在 rb-mode 之前、反馈又在商店之前注册。
  // Unit 切换器(head 常驻,折叠钮旁):吸收原「本地|云端」胶囊,列表式切换 本地/云端/其他设备。
  // 仅真桌面(unitsList 是 agent 后端形态的 preload 能力;web/mobile 垫片无此方法 → 不注册,
  // 它们的 vault 切换仍走 VaultSideSwitch 的 mobile 分支/云端固定形态)。
  if (window.tangu?.unitsList) addRibbonIcon({ id: 'rb-unit', side: 'head', component: UnitSwitcher })
  if (window.tangu?.submitFeedback) {
    addRibbonIcon({ id: 'rb-feedback', side: 'bottom', icon: MessageSquare, tooltip: () => app().tr('feedback.title'), onClick: () => { app().openFeedback() } })
    // 老存档(用户动过底部区)的 bottomOrder 里,rb-feedback 要么还停在 08-31 前的旧位(明暗与命令之间),要么缺席
    // (rankIds 排到区末尾)→ 只挪一次到商店之前,打标记后用户再拖到哪算哪。
    // ponytail: 只认「商店在持久顺序里、反馈不在收纳夹里」的形状,其余形状不动(注册序或用户自己的摆法)。
    const MOVED_KEY = 'forsion_ribbon_feedback_above_market'
    if (!localStorage.getItem(MOVED_KEY)) {
      const rb = useRibbonStore.getState()
      const at = rb.bottomOrder.filter((id) => id !== 'rb-feedback').indexOf('rb-market')
      if (at >= 0 && !rb.folders.some((f) => f.items.includes('rb-feedback'))) rb.setZoneOrder('bottom', moveTo(rb.bottomOrder, 'rb-feedback', at))
      try { localStorage.setItem(MOVED_KEY, '1') } catch { /* ignore */ }
    }
  }
  if (window.tangu?.marketList) addRibbonIcon({ id: 'rb-market', side: 'bottom', icon: Store, tooltip: () => app().tr('market.title'), onClick: () => app().openMarket() })
  addRibbonIcon({ id: 'rb-achievements', side: 'bottom', icon: Trophy, tooltip: () => app().tr('achievements.title'), onClick: () => app().openAchievements() })
  // 主题锁定明暗时 toggleMode 静默无效 → tooltip 改说明「由主题决定」,悬停即知为何点不动(codex Low-2)。
  addRibbonIcon({ id: 'rb-mode', side: 'bottom', icon: ThemeModeIcon, tooltip: () => useTheme.getState().modeLocked ? app().tr('settings.theme.modeLocked') : app().tr('theme.changeMode'), onClick: () => useTheme.getState().toggleMode() })
  addRibbonIcon({ id: 'rb-cmd', side: 'bottom', icon: CommandIcon, tooltip: () => app().tr('command.palette'), onClick: openCommandPalette })
  // 底部常驻(side:'bottom'),无持久顺序时注册序即上下序:明暗/命令 → 设置 → 账号(账号最底)。
  // 用户拖过底部区后 bottomOrder 非空,新注册项按 rankIds 排到区末尾(反馈那条由注册处的一次性迁移兜住)。
  // ⚠️快速查找/语言**刻意不在条上**(2026-08-31):下区是杂物抽屉,八个同色图标一列谁也认不出,
  //   商店与成就被埋没。两者都是低频动作 → 只留命令面板(想要的人可从 ⌘K 钉回命令区)。
  //   反馈当时一并撤下,2026-09-17 按用户要求放回,排在商店之上。
  // 账号卡复用 AccountCard,随 ribbon 展开切换「完整卡 / 紧凑头像」;原聊天列表底部那份已移除,避免重复。
  addRibbonIcon({ id: 'rb-settings', side: 'bottom', icon: Settings, tooltip: () => app().tr('settings.title'), onClick: () => app().openSettings() })
  if (PRODUCT.agentBackend || window.tangu?.account) addRibbonIcon({
    id: 'rb-account',
    side: 'bottom',
    pinned: true, // 账号卡钉死最底:不参与拖拽/收纳/溢出
    component: ({ expanded }) => (
      <AccountCard
        compact={!expanded}
        onToast={app().toast}
        onAuthChange={PRODUCT.agentBackend ? () => setTimeout(() => void app().connect(app().cfg), 1500) : undefined}
      />
    ),
  })

  // ribbon 空白/＋ 号菜单的 feature 动作(引擎不 import feature 代码):新建空白 Space + 文本输入用 askString
  // (Electron 无 window.prompt)。newSpace 仅桌面(需 spacesSave 落盘);无则菜单不显示该项。
  setRibbonActions({
    newSpace: window.tangu?.spacesSave ? () => { void askString(app().tr('spaces.namePrompt')).then((v) => { const name = v?.trim(); if (name) void createBlankSpace(name) }) } : undefined,
    prompt: (title, initial) => askString(title, initial),
    // 引擎的一次性提示(如「已恢复默认布局 · 撤销」)→ 宿主通知。独立事件 id:不挂在 system.generic 上,
    // 用户关掉通用系统通知也不会连撤销入口一起丢。带撤销钮时停留约 8 秒(U-06);仅应用内 —— 从设置浮窗
    // 触发时主窗恰好没焦点,不该为用户眼前的操作再弹一条系统横幅。
    notify: (text, action) => { notifyApp({ text, level: 'info', event: 'workspace.layout', dedupeKey: 'workspace.layout', action, durationMs: action ? 8000 : undefined, inAppOnly: true }) },
  })

  // commands
  if (hasNativeFeature('tangu')) addCommand({ id: 'new-chat', title: () => app().tr('sidebar.newChat'), keywords: 'new chat 新对话', hotkey: 'mod+n', run: blankNewChat , invoke: {
    description: 'Start a new, empty chat in the window the user is talking to you from. Use it when the user asks to start over or open a fresh conversation.',
  } })
  // 旁聊(/btw;⌘; 同 Claude Desktop):带当前会话上下文问一句题外话,开在会话级 Floating Panel 里。
  // 新对话草稿(activeId=null)没有上下文可带 → 不开。不给 invoke:这是用户自己的旁路,不是 agent 能替用户点的动作。
  if (hasNativeFeature('tangu')) addCommand({ id: 'chat-btw', title: () => translate('btw.cmd'), keywords: 'btw by the way side question aside 顺便问 旁聊', hotkey: 'mod+;', run: () => {
    const s = app()
    if (!s.activeId) return
    const activeSession = s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null
    openBtw({ sessionId: s.activeId, title: activeSession?.title, modelId: activeChatModelId({ ...s, activeSession }) || undefined })
  } })
  // hotkey 从 mod+b 改到 mod+/:mod+b 与 Amadeus 编辑器的加粗(commonmark Mod-b)冲突,编辑时会同时切侧栏。
  // 换 mod+/ 是因为 mod+shift+b 也被编辑器占(blockquote),mod+\ 被 split-right 占;mod+/ app 命令表与编辑器 keymap 皆空闲。
  addCommand({ id: 'toggle-left', icon: PanelLeft, checked: () => ws().leftVisible, title: () => app().tr('command.toggleLeft'), keywords: 'sidebar 左栏', hotkey: 'mod+/', run: () => ws().toggleSidebar('left') })
  addCommand({ id: 'quick-find', icon: Search, title: () => translate('bootengine.cmd.quickFind'), keywords: 'search find quick 搜索 查找 快速', hotkey: 'mod+p', run: () => useQuickFind.getState().openPalette() })
  // 页内查找(Cmd/Ctrl+F):壳级浮条 + 活动 View 的 DOM 扫描,见 findInPage.tsx。
  //  · 注册成命令而不是某个组件上的 onKeyDown —— 这样它自动进命令面板、进设置里的快捷键表、
  //    可改键,而且**所有 View 都够得着**(老实现只绑在 Amadeus 编辑器宿主 div 上,三十多个
  //    View 一个都没有)。
  //  · hotkey 按能力挂:浏览器不支持 CSS 自定义高亮时不注册 mod+f,让浏览器原生查找接管
  //    (命令本身仍在面板里)。这是 CSS 特性探测,不是 window.tangu 门控,不进 KNOWN_GATES。
  //  · run() 里让开自带查找的面:CodeMirror(searchKeymap)与 <webview> 客体各有自己的 Cmd+F。
  addCommand({
    id: 'find-in-page',
    icon: Search,
    title: () => translate('bootengine.cmd.findInPage'),
    keywords: 'find search page 页内 查找 搜索 本页',
    hotkey: findSupported ? 'mod+f' : undefined,
    run: () => {
      const el = document.activeElement
      if (el instanceof Element && el.closest('.cm-editor, webview')) return
      openFindBar()
    },
  })
  addCommand({ id: 'toggle-right', icon: PanelLeft, checked: () => ws().rightVisible, title: () => app().tr('command.toggleRight'), keywords: 'sidebar 右栏', run: () => ws().toggleSidebar('right') })
  // mod+j 与 VS Code 的面板热键对齐;app 命令表与编辑器 keymap 皆空闲(mod+/ 已被左栏占,见上)。
  // ⚠️仅桌面壳:移动单列壳没有底部面板,而 singleColumnStore.toggleSidebar 是
  // `side === 'left' ? 左 : 右` 的二元三目 —— 传 'bottom' 会**去开右抽屉**(命令面板在移动端也在,
  // 不 gate 就真能点到)。同理它的 bucketOf/sidebarDefaults 也没有 bottom 桶。
  if (UI_MODE !== 'mobile') addCommand({ id: 'toggle-bottom', icon: PanelBottom, checked: () => ws().bottomVisible, title: () => app().tr('command.toggleBottom'), keywords: 'panel bottom terminal 底部 面板 终端', hotkey: 'mod+j', run: () => ws().toggleSidebar('bottom') })
  addCommand({ id: 'theme-mode', icon: Moon, title: () => app().tr('theme.changeMode'), keywords: 'theme dark 明暗', run: () => useTheme.getState().toggleMode() })
  addCommand({ id: 'theme-skin', title: () => app().tr('theme.changeSkin'), keywords: 'theme skin 配色', run: () => useTheme.getState().cycleSkin() })
  addCommand({ id: 'theme-lang', title: () => app().tr('theme.changeLanguage'), keywords: 'theme language genesis lovable soft', run: () => useTheme.getState().cycleLang() })
  // ⚠️别与上一条混:theme-lang = 主题的「语言层」(genesis/lovable/soft),这条才是界面中英文。
  addCommand({ id: 'toggle-locale', icon: Languages, title: () => app().tr('locale.toggleTitle'), keywords: 'locale language i18n 语言 中英文 chinese english', run: () => cycleLocale() })
  addCommand({ id: 'toggle-smooth-caret', icon: TextCursorInput, checked: isSmoothCaretOn, title: () => app().tr('command.toggleSmoothCaret'), keywords: 'smooth caret cursor 光标 丝滑 word', run: () => {
    setSmoothCaret(!isSmoothCaretOn())
  } })
  if (hasNativeFeature('tangu')) addCommand({ id: 'split-right', title: () => app().tr('command.splitRight'), keywords: 'split 分屏', hotkey: 'mod+\\', run: splitChat })
  // per-tab 前进/后退(Ctrl/⌘+{ 与 }):只走当前活动主 leaf 的历史栈;与主区左上角箭头同源。
  const navGo = (dir: 'back' | 'forward'): void => {
    const api = ws().api
    const id = api ? activeMainPanel(api)?.id : null
    if (id) useNav.getState()[dir](id)
  }
  addCommand({ id: 'nav-back', title: () => app().tr('command.navBack'), keywords: 'back history 后退 历史', hotkey: 'mod+shift+[', run: () => navGo('back') })
  addCommand({ id: 'nav-forward', title: () => app().tr('command.navForward'), keywords: 'forward history 前进 历史', hotkey: 'mod+shift+]', run: () => navGo('forward') })
  addCommand({ id: 'reset-layout', title: () => app().tr('command.resetLayout'), keywords: 'layout reset default 布局 默认 黄金分割', run: () => ws().resetLayout({ undoable: true }) })
  if (hasNativeFeature('tangu')) addCommand({
    id: 'show-chat-panel',
    icon: MessageCircle,
    title: () => translate('bootengine.cmd.showChatPanel'),
    keywords: 'chat panel side conversation 侧栏 对话 面板',
    run: () => ws().showSideView('right', 'chat-panel'),
  })
  // Mini 悬浮卡片(全局快捷键 ⌘/Ctrl+⇧+M 亦可):仅桌面(openMini 存在)。
  if (window.tangu?.openMini) addCommand({ id: 'open-mini', title: () => translate('bootengine.cmd.openMini'), keywords: 'mini card floating 悬浮 卡片 迷你 mini', run: () => {
    const space = getActiveSpace(), leaf = ws().getActiveLeaf()
    window.tangu?.openMini?.(space && supportsMiniPanel(space)
      ? { spaceId: space.id, params: leaf?.type === space.mini!.mainView.type ? leaf.params : undefined }
      : { sessionId: app().activeId || undefined })
  } })
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
  if (hasNativeFeature('tangu')) addCommand({ id: 'stop-run', title: () => app().tr('command.stop'), keywords: 'stop 停止', run: async () => { await app().stop() } })
  if (hasNativeFeature('tangu')) addCommand({ id: 'compact', title: () => app().tr('command.compact'), keywords: 'compact 压缩', run: () => void app().compact() })
  if (hasNativeFeature('tangu')) addCommand({ id: 'branch', title: () => app().tr('command.branch'), keywords: 'branch 分支', run: () => void app().branchFromMessage() })
  // 商店/成就此前**只有 ribbon 图标一个入口**,⌘K 搜不到 —— 这是「用户发现不了」的一半根因。
  if (window.tangu?.marketList) addCommand({ id: 'open-market', icon: Store, title: () => app().tr('market.title'), keywords: 'market store plugin theme skill agent 市场 商店 插件 主题 技能 扩展', run: () => app().openMarket() })
  addCommand({ id: 'open-achievements', icon: Trophy, title: () => app().tr('achievements.title'), keywords: 'achievement trophy badge medal 成就 勋章 徽章', run: () => app().openAchievements() })
  if (window.tangu?.submitFeedback) addCommand({ id: 'open-feedback', icon: MessageSquare, title: () => app().tr('feedback.title'), keywords: 'feedback bug report 反馈 问题 建议 报错', run: () => { app().openFeedback() } })
  addCommand({ id: 'open-settings', icon: Settings, title: () => app().tr('settings.title'), keywords: 'settings 设置 preferences', hotkey: 'mod+,', run: () => app().openSettings() , invoke: {
    description: "Open the Forsion settings window, optionally straight to one page. Use it to show the user where a control lives when you cannot change it yourself.",
    params: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Settings page to open, e.g. theme, model, shortcuts, notifications, about. Omit for the default page.' } },
    },
    run: (a) => app().openSettings(typeof a.tab === 'string' && a.tab ? (a.tab as never) : undefined),
  } })
  // ── agent 面专属命令(不进命令面板的人类语汇,而是补上模型独缺的两个原语)──────────────
  // 为什么这两条是新增而不是给现有命令加 invoke:命令表里 22 条「开面板」对模型价值极低,
  // 真正缺的是「把我刚写的东西摆到用户眼前」和「切到那个 Space」。二者都有现成函数,只是从来
  // 没被声明成命令(因为 run(): void 收不了参数)。
  if (amadeusAvailable()) addCommand({
    id: 'open-note',
    title: () => translate('bootengine.cmd.openNote'),
    keywords: 'note open 打开 笔记',
    run: () => { /* 人类走侧栏点开,命令面板里这条只作 agent 面载体 */ },
    invoke: {
      description:
        'Open a note (or drawing, dashboard, PDF, database — it routes by file type) in front of the user, '
        + 'in the window they are talking to you from. Call this right after you create or edit a note so they '
        + 'can see it, instead of only telling them the path. Optionally land on a heading or a block anchor.',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path, e.g. "Projects/plan.md" — the same path amadeus_write_note takes.' },
          heading: { type: 'string', description: 'Scroll to this heading text.' },
          block_id: { type: 'string', description: 'Scroll to this block anchor id.' },
          new_tab: { type: 'boolean', description: 'Open in a new tab instead of the active one. Ignored when heading or block_id is given.' },
        },
        required: ['path'],
      },
      run: async (a) => {
        const path = String(a.path || '').trim()
        if (!path) throw new Error('path is required')
        // ⚠️ 开之前先验存在:openNote / openFile 都把「打不开」吞掉(waitForActive 超时也算 resolve),
        //    不验的话拿一个拼错的路径过来会静静地什么都不发生,然后回报「已打开」(Codex 评审 P2-10)。
        const { usePageStore } = await import('./amadeus/store/pageStore')
        const norm = path.replace(/\\/g, '/').replace(/^\/+/, '')
        const files = usePageStore.getState().files
        if (files.length && !files.some((f) => f.replace(/\\/g, '/') === norm)) {
          throw new Error(`no such file in the vault: ${norm}`)
        }
        const nav = await import('./amadeusNav')
        const newTab = a.new_tab === true ? { newTab: true } : undefined
        if (typeof a.heading === 'string' && a.heading) await nav.openNoteAtHeading(norm, a.heading)
        else if (typeof a.block_id === 'string' && a.block_id) await nav.openNoteAtBlock(norm, String(a.block_id))
        // ⚠️ 非 .md 一律交 openFile 路由:PDF / .db / 图片 / 媒体的分派都在那儿,openNote 接不住。
        //    描述里承诺了按类型路由,就得真的路由(同上条评审)。
        else if (/\.md$/i.test(norm)) await nav.openNote(norm, newTab)
        else nav.openFile(norm, newTab)
      },
    },
  })
  addCommand({
    id: 'set-active-space',
    title: () => translate('bootengine.cmd.setActiveSpace'),
    keywords: 'space switch 空间 切换',
    run: () => { /* 人类走 ribbon / 底部条,这条只作 agent 面载体 */ },
    invoke: {
      description:
        'Switch the window the user is talking to you from to another Space (workspace layout). '
        + 'Only ids listed in `state` exist on this device — Spaces differ per device and per install.',
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Space id, one of the ids listed in this entry\'s state.' } },
        required: ['id'],
      },
      // ⚠️ 必须自校验:setActiveSpace 对未知 id 会走 resetLayout→build(),把用户的布局清成空白。
      run: (a) => {
        const id = String(a.id || '').trim()
        const known = useSpaceStore.getState().spaces.map((sp) => sp.id)
        if (!known.includes(id)) throw new Error(`no such Space "${id}" here. Available: ${known.join(', ')}`)
        setActiveSpace(id)
      },
      state: () => {
        const st = useSpaceStore.getState()
        return `active=${st.activeSpaceId}; available=${st.spaces.map((sp) => sp.id).join(',')}`
      },
    },
  })

  // UI 缩放:应用持久值 + 注册放大/缩小/重置命令。端默认:桌面 Electron 1 / 触屏窄屏 1.15(同
  // singleColumn.css 移动 zoom 段) / 桌面浏览器(网页端) 1.1 / 移动端平板 1。
  {
    const w = window as { tangu?: { mobile?: boolean } }
    const coarse = ((): boolean => { try { return window.matchMedia('(pointer: coarse) and (max-width: 820px)').matches } catch { return false } })()
    initUiZoom(w.tangu && !w.tangu.mobile ? 1 : coarse ? 1.15 : w.tangu?.mobile ? 1 : 1.1)
  }
  // 开发者选项那三个 ⌘K 入口:真源在 localStorage × 主进程 config,单源重算见 devCommands.ts
  // (设置浮窗里拨开关时会请主窗再跑一次这个函数 —— 命令注册表每个渲染进程各一份)。
  syncDevCommands()

  // forsion:// deep link(仅桌面主窗;内部自门控 window.tangu?.onDeepLink,web/mobile 各有通道)。
  installDeepLinks()
}

/** 默认布局 = 当前活动 Space 的 build()(WorkspaceHost 无保存布局时调用,经 buildDefault prop)。 */
export function buildDefaultLayout(): void {
  getActiveSpace()?.build()
}
