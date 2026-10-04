import { AUTOMATION_WORKSPACE_MODE } from './views/automation/automationListSource'
import { hasNativeFeature, amadeusAvailable, inboxAvailable } from './features/runtime'
/** 具体的 Space 定义 + 注册入口。Space = 取代「App」的功能组合(见 engine/types.SpaceDefinition)。
 *  每个 Space 贡献一个 ribbon 顶部图标(可拖动改序,默认排在折叠钮之下、商店之上),点击切换。
 *  Tangu Space = 会话/对话/主体详情/文件/目录;Agents Space = 智能体配置。Amadeus Space 见 Milestone 2。 */
import { Bot, Inbox, NotebookText, Code2, Workflow, Rocket, Users } from 'lucide-react'
import { INBOX_WORKSPACE_MODE } from './views/workspaceMode'
import { registerSpace, addRibbonIcon, useSpaceStore, useWorkspace, deleteNamedLayout, clearLayout, resetSpaceLayouts } from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel, SidebarDefaults } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { PRODUCT } from './product'
import { installAmadeusCommands } from './amadeusCommands'
import { migrateTanguDetailsLayouts } from './tanguDetailsLayout'
import './views/agentProfileMessages'
import { SpaceButton } from './components/SpaceButton'
import { builtinEnabled } from './builtins'
import { calendarAvailable, calendarSpace } from './builtins/calendar'
import { museAvailable, museSpace } from './builtins/muse'

import { homepageAvailable, homepageSpace } from './builtins/homepage'
import { imageStudioAvailable, imageStudioSpace } from './builtins/imageStudio'
import { artificialAvailable, artificialSpace } from './builtins/artificial'
import { homeSlotSpaceId, installHomeSlot } from './homeSlot'
import { windowKind } from './windowKind'

const ws = () => useWorkspace.getState()
const app = () => useApp.getState()

/** 「启动时进入的 Space」设置(设置 → Spaces)。值 = HOME_SLOT_SPACE | LAST_EXIT_SPACE | Space id。
 *  **缺省(未设)= HOME_SLOT_SPACE**(2026-08-28 用户要求):启动进 ribbon 主位槽指着的那个 Space
 *  (默认即主页)。⚠️这条**改过两次**:最早是固定 PRODUCT.defaultSpace,2026-08-13 改成
 *  LAST_EXIT_SPACE,2026-08-28 再改成主位槽。从没动过这项设置的老用户,升级后启动落点会跟着变。
 *  · LAST_EXIT_SPACE:id 不动,布局键原样交给 tryRestoreLayout → 连同上次开着的标签页一起回来。
 *  · 固定某个 Space / 主位槽:冷启动进**那个 Space 自己上次的布局**。
 *  实际启动决策见 bootstrapEngine.installEngine(仅主窗读取),解析一律走下面的 resolveStartupTarget。 */
export const DEFAULT_SPACE_KEY = 'forsion_default_space'
export const LAST_EXIT_SPACE = '__last__'
/** 「跟随 ribbon 主位槽」这一档。`__` 前缀与 LAST_EXIT_SPACE 同款,永不与真实 Space id 相撞。 */
export const HOME_SLOT_SPACE = '__home__'
/** 读「启动时进入」设置的唯一入口 —— 缺省值只在这里写一次(bootstrapEngine 与设置面板都读它)。 */
export function startupSpacePref(): string {
  try { return localStorage.getItem(DEFAULT_SPACE_KEY) || HOME_SLOT_SPACE } catch { return HOME_SLOT_SPACE } // private mode
}

/** 「启动时进入」→ 具体 Space id。**bootstrapEngine 的两个消费点都必须走它**:
 *  第二处(用户 Space 异步装载完的补定位)漏了的话,主位/指定档指向一个 L0 用户 Space 时,
 *  冷启动回落产品默认、补定位又认不出 → 永远进不去那个 Space,而且不报错。 */
export function resolveStartupTarget(lastExit: string): string {
  const pref = startupSpacePref()
  if (pref === HOME_SLOT_SPACE) return homeSlotSpaceId() ?? PRODUCT.defaultSpace
  if (pref === LAST_EXIT_SPACE) return lastExit
  return useSpaceStore.getState().spaces.some((s) => s.id === pref) ? pref : PRODUCT.defaultSpace
}

/** 工作区视图的档位由 Space 写死在条目上(2026-10-03 锁档):不再跟着主区活动标签换档,也没有切档菜单。
 *  没带 mode 的条目(老的插件配方)才回落 workspaceMode.autoWorkspaceMode 的旧规则。 */
const WS_FILES: PersistedPanel = { type: 'workspace', params: { mode: 'files' } }
const TANGU_MAIN: PersistedPanel = { type: 'chat', params: { followActive: true, reuseKey: 'primary' } }
const TANGU_LEFT: PersistedPanel = { type: 'workspace', params: { mode: 'orbits' } }

/** Tangu Space 的侧栏默认:左=工作区(会话);右=Tangu 详情/工作区(文件)/大纲 同组 tab。 */
const TANGU_SIDE_VIEWS: SidebarDefaults = {
  left: [TANGU_LEFT],
  right: [
    { type: 'tangu-details', params: {} },
    WS_FILES,
    { type: 'outline', params: {} },
  ],
  // 底部面板预置终端(默认折叠,见 build())。终端被禁用 / 非桌面宿主时 getView('terminal') 为空,
  // toggleSidebar 展开路径的 known 过滤会自动跳过 → 退回空停靠区,不会开出一个死面板。
  bottom: [{ type: 'terminal', params: {} }],
}

const tanguSpace: SpaceDefinition = {
  id: 'tangu',
  mini: { name: 'Tangu', view: { type: 'mini-tangu', params: { followActive: true } }, mainView: { type: 'chat' } },
  name: () => app().tr('space.tangu'),
  icon: Bot,
  // 主区没有硬规则(启动器 / Agents 详情…)时左栏落新版会话侧栏;chat 主区由 registerView 的
  // workspaceSource 声明位管(features/tangu.tsx)。
  autoWorkspaceMode: 'orbits',
  sidebarDefaults: TANGU_SIDE_VIEWS,
  // 固定:主区聊天、左栏会话、右栏 Tangu 详情(右栏的文件 / 大纲是辅助,不固定)。
  pinned: { main: [TANGU_MAIN], left: [TANGU_LEFT], right: [{ type: 'tangu-details', params: {} }] },
  /** 对话(主)→ 工作区(左,会话)→ 右栏(主体详情 + 文件/大纲,默认折叠)。 */
  build() {
    ws().setSidebarDefaults(TANGU_SIDE_VIEWS)
    ws().openView(TANGU_MAIN.type, TANGU_MAIN.params, 'main')
    ws().openView(TANGU_LEFT.type, TANGU_LEFT.params, 'left')
    // 右栏默认折叠 —— 内容入 stash,toggle 可展(仅作用于全新布局;已存布局尊重用户,见 spaceRegistry.applyNamed 路径)。
    ws().initializeSidebar('right', false)
    // 底部面板同样默认折叠,但 stash 里已放好终端 → 用户点开就是终端,而不是空停靠区。
    ws().initializeSidebar('bottom', false)
  },
}

const agentsSpace: SpaceDefinition = {
  id: 'agents', name: () => app().tr('agentProfile.space'), icon: Users,
  sidebarDefaults: { left: [{ type: 'agents-roster', params: {} }], right: [], bottom: [] },
  pinned: { main: [{ type: 'agent-profile', params: {} }], left: [{ type: 'agents-roster', params: {} }] },
  build() {
    ws().setSidebarDefaults({ left: [{ type: 'agents-roster', params: {} }], right: [], bottom: [] })
    ws().openView('agent-profile', {}, 'main')
    ws().openView('agents-roster', {}, 'left')
    ws().initializeSidebar('bottom', false)
    ws().initializeSidebar('right', false)
  },
}

/** Inbox Space:左=统一「工作区」(自动档 = 收件箱列表源,2026-09-11 起;独立的 inbox-list 左栏已退役,
 *  老布局由 lcl 的 RETIRED_VIEW_MAP 迁成 workspace);右=工作区(文件,默认收起,toggle 可展)。主区 = 阅读面板。
 *  不定义 newPage(曾指向 singleton 的 inbox-reader,使 ＋ 键永远只是重激活已有面板 = 死键):
 *  ＋ 与「关掉最后一个主区 view」统一落 launcher,与 Tangu/Amadeus 一致 —— 主区是启动器时左栏靠 autoWorkspaceMode 仍是收件箱。 */
const INBOX_LEFT: PersistedPanel = { type: 'workspace', params: { mode: INBOX_WORKSPACE_MODE } }
const INBOX_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [INBOX_LEFT],
  right: [WS_FILES],
}

const inboxSpace: SpaceDefinition = {
  id: 'inbox',
  name: () => app().tr('space.inbox'),
  icon: Inbox,
  sidebarDefaults: INBOX_SIDE_VIEWS,
  pinned: { main: [{ type: 'inbox-reader', params: {} }], left: [INBOX_LEFT] },
  autoWorkspaceMode: INBOX_WORKSPACE_MODE,
  // 消息列表住在左栏:可拖宽 + 起手比黄金分割宽 30%(标题不再截到 8 个字),主区照样留足阅读宽度(U-10)。
  resizableSides: { left: true },
  sideDefaultScale: { left: 1.3 },
  build() {
    ws().setSidebarDefaults(INBOX_SIDE_VIEWS)
    ws().openView('inbox-reader', {}, 'main')
    ws().openView(INBOX_LEFT.type, INBOX_LEFT.params, 'left')
    ws().initializeSidebar('right', false)
  },
}

/** Amadeus Space 的侧栏默认:左=工作区(自动→笔记)/搜索/标签 同组 tab;右=对话/大纲/反链/关系图 同组 tab。
 *  右栏首位 = 对话(2026-08-14 用户要求的默认视图):展开右栏即在笔记旁边聊天,且会自动引用主区当前这篇
 *  (见 Composer2 的「已选择」引用条)。**排第一位就是默认选中**——展开时无记忆则取 stash 首项(dockviewStore.toggleSidebar)。
 *  `chat-panel` 视图只在含 tangu 的产品档案里注册(bootstrapEngine),Amadeus 单品档案没有它 → 那儿不排进来,
 *  否则侧栏会多出一个渲染不出内容的空 tab。 */
const AMADEUS_HAS_CHAT = hasNativeFeature('tangu')
const AMADEUS_LEFT: PersistedPanel = { type: 'workspace', params: { mode: 'notes' } }
const AMADEUS_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [
    AMADEUS_LEFT,
    { type: 'amadeus-search', params: {} },
    { type: 'amadeus-tags', params: {} },
  ],
  right: [
    ...(AMADEUS_HAS_CHAT ? [{ type: 'chat-panel', params: { followActive: true } }] : []),
    { type: 'outline', params: {} },
    { type: 'amadeus-backlinks', params: {} },
    { type: 'amadeus-graph', params: {} },
  ],
}

const amadeusSpace: SpaceDefinition = {
  id: 'amadeus',
  mini: { name: 'Amadeus', view: { type: 'mini-amadeus' }, mainView: { type: 'amadeus-editor' } },
  name: () => app().tr('space.amadeus'),
  icon: NotebookText,
  sidebarDefaults: AMADEUS_SIDE_VIEWS,
  // 固定:只固定左栏笔记树。主区编辑器**刻意不固定** —— 笔记 / PDF / 多维表 / 白板是不同的视图类型,
  // 固定编辑器之后点一个 PDF 就会另开标签,「点文件就地换」的手感没了;而笔记树在,点任何一篇都回得到编辑器。
  pinned: { left: [AMADEUS_LEFT] },
  // 左栏(笔记/搜索/标签)= 可自由拖宽 + 记住宽度(否则每次钉回黄金分割默认,折叠再开也丢用户调节的宽度)。
  resizableSides: { left: true },
  // 主区没有硬规则时(启动器/搜索/图谱/日历…)左栏回笔记树,而不是全局默认的会话。
  autoWorkspaceMode: 'notes',
  // 不定义 newPage:＋ 与「关掉最后一个主区 view」统一落到 launcher 启动器(与 Tangu Space 一致),
  // 启动器按当前 Space 列出可用视图 + 最近使用;「新建笔记」成为启动器里的一项。
  /** 编辑器(主)→ 左栏(笔记 + 搜索/标签 同组 tab)→ 右栏(大纲/反链/关系图,默认折叠)。
   *  openView 会把新面板设为活动 tab,故最后把左栏「笔记」拉回活动态。 */
  build() {
    ws().setSidebarDefaults(AMADEUS_SIDE_VIEWS)
    ws().openView('amadeus-editor', {}, 'main')
    const pagesLeaf = ws().openView(AMADEUS_LEFT.type, AMADEUS_LEFT.params, 'left')
    ws().openView('amadeus-search', {}, 'left')
    ws().openView('amadeus-tags', {}, 'left')
    // 右栏默认折叠 —— 内容入 stash,toggle 可展(仅作用于全新布局;已存布局尊重用户,见 spaceRegistry.applyNamed 路径)。
    ws().initializeSidebar('right', false)
    if (pagesLeaf) ws().activateLeaf(pagesLeaf.id)
  },
}

/** Coding Space:未选项目时左=项目导航,进入项目后左=对话;主=项目索引或 Code|Preview;右=文件树。
 *  左栏使用原生 View 槽位,CodeStudioView 随项目状态切换导航与 Chat View。
 *  新会话默认落 Coding Agent(不改全局 defaultSlug,只设新会话草稿)。 */
const CODING_SIDE_VIEWS: SidebarDefaults = {
  left: [{ type: 'coding-navigation', params: {} }],
  right: [WS_FILES],
  bottom: [{ type: 'terminal', params: {} }],
}

const codingSpace: SpaceDefinition = {
  id: 'coding',
  name: () => app().tr('space.coding'),
  icon: Code2,
  sidebarDefaults: CODING_SIDE_VIEWS,
  // 固定:主区工作台 + 左栏项目导航。进项目时对话作为左栏的第二个标签开出来(CodeStudioView),导航一直在。
  pinned: { main: [{ type: 'code-studio', params: {} }], left: [{ type: 'coding-navigation', params: {} }] },
  // 左栏 = 项目导航 + 对话:可自由拖宽 + 记住宽度。
  resizableSides: { left: true },
  // 导航比旧对话更精简,起手用标准侧栏宽度;手动调整仍照常记住。
  sideDefaultScale: { left: 1 },
  build() {
    ws().setSidebarDefaults(CODING_SIDE_VIEWS)
    app().selectNewChatAgent?.('coding') // 新会话默认 Coding agent
    ws().openView('code-studio', {}, 'main')
    ws().openView('coding-navigation', {}, 'left')
    ws().initializeSidebar('right', false)
    ws().initializeSidebar('bottom', false)
  },
}

/** Automation Space:统一工作区列表 + 主区流程；配置与运行记录由主 View 按需打开 Extend View。 */
const AUTOMATION_LEFT: PersistedPanel = { type: 'workspace', params: { mode: AUTOMATION_WORKSPACE_MODE } }
const AUTOMATION_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [AUTOMATION_LEFT],
  right: [],
}

const automationSpace: SpaceDefinition = {
  id: 'automation',
  autoWorkspaceMode: AUTOMATION_WORKSPACE_MODE,
  name: () => app().tr('space.automation'),
  icon: Workflow,
  sidebarDefaults: AUTOMATION_SIDE_VIEWS,
  pinned: { main: [{ type: 'automation-detail', params: {} }], left: [AUTOMATION_LEFT] },
  resizableSides: { left: true, right: true },
  build() {
    ws().setSidebarDefaults(AUTOMATION_SIDE_VIEWS)
    ws().openView('automation-detail', {}, 'main')
    ws().openView(AUTOMATION_LEFT.type, AUTOMATION_LEFT.params, 'left')
  },
}

/** Public Space:管理已发布网站(Forsion Connect)+ 已公开发布/协作共享的笔记。单视图铺满主区。 */
const PUBLIC_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = { left: [], right: [] }
const publicSpace: SpaceDefinition = {
  id: 'public',
  name: () => app().tr('space.public'),
  icon: Rocket,
  sidebarDefaults: PUBLIC_SIDE_VIEWS,
  pinned: { main: [{ type: 'public-view', params: {} }] },
  build() {
    ws().setSidebarDefaults(PUBLIC_SIDE_VIEWS)
    ws().openView('public-view', {}, 'main')
  },
}

/** 注册序 = ribbon 顶部默认序。在 installEngine 内、商店图标注册之前调用。
 * Amadeus 需要可用的文件桥；Unit 还必须由安装包显式声明该功能。
 * 没有安装清单的旧桌面/Web 档案保留原有能力判断。 */
export const AMADEUS_ENABLED = PRODUCT.nativeFeatures === undefined || hasNativeFeature('amadeus')
// 产品档案过滤 × 运行时能力门控 叠加:档案没点名的 Space 直接不注册(单品变体);点名的仍受能力闸约束。
const SPACES: SpaceDefinition[] = [
  // 主页也是**内置插件**(builtins/homepage:Space + homepage 视图随插件启停)。排第一 = ribbon 顶格,
  // 与旧 Forsion Desktop 的「先看到桌面首页」一致;插件页关掉后下次启动即整条不出现。
  ...(homepageAvailable() && builtinEnabled('home') ? [homepageSpace] : []),
  ...(hasNativeFeature('tangu') ? [tanguSpace, agentsSpace] : []),
  // Inbox 与视图注册同门控(inboxAvailable:旧档案 spaces 点名 + backendStatus/mobile;Unit 宿主 = tangu 包 + 本地引擎)。
  ...(inboxAvailable() ? [inboxSpace] : []),
  ...(hasNativeFeature('amadeus') && amadeusAvailable() && AMADEUS_ENABLED ? [amadeusSpace] : []),
  // Calendar 已是**内置插件**(builtins/calendar:Space + 三个视图随插件启停)。这里仍按槽位声明式带上,
  // 保住 ribbon 默认序与「上次退出停在日历」的启动恢复;插件页关掉后下次启动即整条不出现。
  ...(calendarAvailable() && builtinEnabled('calendar') ? [calendarSpace] : []),
  // Coding 依赖 host 文件桥 + 本地静态预览服务器(仅桌面 electron;Tangu Web 无 codePreviewServe → 不注册)。
  ...(PRODUCT.nativeFeatures === undefined && PRODUCT.spaces.includes('coding') && window.tangu?.codePreviewServe ? [codingSpace] : []),
  // 造物也是**内置插件**(builtins/artificial:Space + artificial/product 两个视图随插件启停)。
  // 紧跟编码之后 —— 它管的正是编码工作室的产出;插件页关掉后下次启动即整条不出现。
  ...(artificialAvailable() && builtinEnabled('artificial') ? [artificialSpace] : []),
  ...(imageStudioAvailable() && builtinEnabled('image-studio') ? [imageStudioSpace] : []),
  // Automation 依赖本地 tangu 后端(triggers/automation 端点都是本地特性;Tangu Web 无 backendStatus → 不注册)。
  ...(hasNativeFeature('automation') && window.tangu?.backendStatus ? [automationSpace] : []),
  // Muse 也是**内置插件**(builtins/muse:Space + 两个视图随插件启停;本地后端特性)。同 Calendar 的槽位纪律。
  ...(museAvailable() && builtinEnabled('muse') ? [museSpace] : []),

  // Public:管理已发布网站/笔记。需 Connect 发布桥或 Amadeus 协作桥其一(Tangu Web 两者皆无 → 不注册)。
  ...(hasNativeFeature('public') && (window.tangu?.connectPublish || window.amadeusCollab) ? [publicSpace] : []),
]

export function registerSpaces(): void {
  if (hasNativeFeature('tangu')) migrateTanguDetailsLayouts()
  for (const sp of SPACES) {
    registerSpace(sp)
    addRibbonIcon({ id: `space:${sp.id}`, side: 'top', component: ({ expanded }) => <SpaceButton space={sp} expanded={expanded} /> })
  }
  // 主位槽:把它指着的那个 Space 的图标从上区搬到中间的 home 槽(改 side,不动持久顺序)。
  // 必须在上面那轮 addRibbonIcon 之后 —— 它靠 upsert 覆盖刚注册的那一份。
  installHomeSlot()
  // 活动 Space 不在本产品档案里 → 回落档案默认(单品变体首启:localStorage 可能存着全家桶的 'tangu')。
  // ⚠️ 只改内存,**不写 localStorage**:此刻不在表里的 id 多半是异步注册的用户 / 插件 Space,盘上那个值是「上次退出在哪」
  // 的唯一记录(下次启动的 BOOT_ACTIVE_SPACE_ID)。写回由真正定了位的人做 —— bootstrapEngine 的 setActiveSpaceCold、
  // settleAsyncStartupSpace、用户自己切 Space。这里落盘的话,只要写回没发生,盘上就成了「活动 = 回落 Space、布局键 =
  // 上次退出那个 Space 的现场」,下次启动那份现场被归档进回落 Space 的槽(10-03 实报:space:tangu 里是视频工作室的面板)。
  // 写回不发生根本不需要故障:卫星窗(设置 / 市场浮窗、分离窗)也跑到这里,而它们从不补定位。
  if (new URLSearchParams(location.search).get('window') === 'mini') return
  const activeId = useSpaceStore.getState().activeSpaceId
  if (SPACES.length && !SPACES.some((sp) => sp.id === activeId)) {
    const fallback = SPACES.some((sp) => sp.id === PRODUCT.defaultSpace) ? PRODUCT.defaultSpace : SPACES[0].id
    useSpaceStore.setState({ activeSpaceId: fallback })
  }
  // 固定 View + 工作区锁档(2026-10-03,用户拍板「升级后重置每个 Space 的默认布局」):此前存下的布局里,
  // 固定项可能早被关掉 / 顶掉 / 拖走,工作区条目也没带档位 → 一次性丢掉全部 Space 的已存布局,各自按新默认重建。
  // 只在主窗做:卫星窗的 clearLayout 清的是它自己那把键,却会把这面旗子先插上,主窗的当前布局就漏掉了。
  try {
    if (windowKind() === 'main' && localStorage.getItem('forsion_pinned_layout_v1') !== '1') {
      resetSpaceLayouts()
      localStorage.setItem('forsion_pinned_layout_v1', '1')
    }
  } catch { /* ignore */ }
  // 右栏默认折叠(2026-07-18):旧 Amadeus/Tangu 命名布局是「右栏展开」时存的,会经 applyNamed/tryRestoreLayout
  // 恢复、绕过新的 build()(其默认折叠右栏)→ 老用户永远看不到折叠。一次性清掉这两个空间的旧布局
  // (+ 若当前正停留其一则清当前布局),下次进入按新默认重建(右栏折叠)。代价=这两个空间的布局微调丢一次。
  // 不 gate 在 window.amadeus:Tangu 空间在无 amadeus 桥的端(Tangu Web)也存在、也要迁移。
  try {
    if (localStorage.getItem('forsion_rightpanel_collapse_v1') !== '1') {
      deleteNamedLayout('space:amadeus')
      deleteNamedLayout('space:tangu')
      const active = localStorage.getItem('forsion_tangu_active_space')
      if (active === 'amadeus' || active === 'tangu') clearLayout()
      localStorage.setItem('forsion_rightpanel_collapse_v1', '1')
    }
  } catch { /* ignore */ }
  if (amadeusAvailable() && AMADEUS_ENABLED) {
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
      // v3(2026-08-14):右栏加了「对话」并置于首位。老布局的右栏 stash 里没有它 → 同 v2 一次性重建。
      if (AMADEUS_HAS_CHAT && localStorage.getItem('amadeus_layout_v3') !== '1') {
        deleteNamedLayout('space:amadeus')
        if (localStorage.getItem('forsion_tangu_active_space') === 'amadeus') clearLayout()
        localStorage.setItem('amadeus_layout_v3', '1')
      }
    } catch { /* ignore */ }
  }
}
