/** 具体的 Space 定义 + 注册入口。Space = 取代「App」的功能组合(见 engine/types.SpaceDefinition)。
 *  每个 Space 贡献一个 ribbon 顶部图标(可拖动改序,默认排在折叠钮之下、商店之上),点击切换。
 *  Tangu Space = 现有助手界面(会话/对话/文件/目录/记忆/子聊天)。Amadeus Space 见 Milestone 2。 */
import { Bot, Inbox, NotebookText, Code2, Workflow, Rocket } from 'lucide-react'
import { registerSpace, addRibbonIcon, useSpaceStore, useWorkspace, deleteNamedLayout, clearLayout } from '@lcl/engine'
import type { SpaceDefinition, PersistedPanel, SidebarDefaults } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { PRODUCT } from './product'
import { installAmadeusCommands } from './amadeusCommands'
import { SpaceButton } from './components/SpaceButton'
import { builtinEnabled } from './builtins'
import { calendarAvailable, calendarSpace } from './builtins/calendar'
import { homepageAvailable, homepageSpace } from './builtins/homepage'
import { homeSlotSpaceId, installHomeSlot } from './homeSlot'

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

/** Tangu Space 的侧栏默认:左=工作区(自动→会话);右=对话/工作区(自动→文件)/大纲/记忆/子聊天 同组 tab。 */
const TANGU_SIDE_VIEWS: SidebarDefaults = {
  left: [{ type: 'workspace', params: {} }],
  right: [
    { type: 'chat-panel', params: { followActive: true } },
    { type: 'workspace', params: {} },
    { type: 'outline', params: {} },
    { type: 'memory', params: {} },
    { type: 'subchats', params: {} },
  ],
  // 底部面板预置终端(默认折叠,见 build())。终端被禁用 / 非桌面宿主时 getView('terminal') 为空,
  // toggleSidebar 展开路径的 known 过滤会自动跳过 → 退回空停靠区,不会开出一个死面板。
  bottom: [{ type: 'terminal', params: {} }],
}

const tanguSpace: SpaceDefinition = {
  id: 'tangu',
  name: () => app().tr('space.tangu'),
  icon: Bot,
  sidebarDefaults: TANGU_SIDE_VIEWS,
  /** 对话(主)→ 工作区(左,自动=会话)→ 右栏(同会话 ChatView + 文件/大纲/记忆/子聊天,默认折叠)。 */
  build() {
    ws().setSidebarDefaults(TANGU_SIDE_VIEWS)
    ws().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
    ws().openView('workspace', {}, 'left')
    // 右栏默认折叠 —— 内容入 stash,toggle 可展(仅作用于全新布局;已存布局尊重用户,见 spaceRegistry.applyNamed 路径)。
    ws().initializeSidebar('right', false)
    // 底部面板同样默认折叠,但 stash 里已放好终端 → 用户点开就是终端,而不是空停靠区。
    ws().initializeSidebar('bottom', false)
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

/** Amadeus Space 的侧栏默认:左=工作区(自动→笔记)/搜索/标签 同组 tab;右=对话/大纲/反链/关系图 同组 tab。
 *  右栏首位 = 对话(2026-08-14 用户要求的默认视图):展开右栏即在笔记旁边聊天,且会自动引用主区当前这篇
 *  (见 Composer2 的「已选择」引用条)。**排第一位就是默认选中**——展开时无记忆则取 stash 首项(dockviewStore.toggleSidebar)。
 *  `chat-panel` 视图只在含 tangu 的产品档案里注册(bootstrapEngine),Amadeus 单品档案没有它 → 那儿不排进来,
 *  否则侧栏会多出一个渲染不出内容的空 tab。 */
const AMADEUS_HAS_CHAT = PRODUCT.spaces.includes('tangu')
const AMADEUS_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [
    { type: 'workspace', params: {} },
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
  name: () => app().tr('space.amadeus'),
  icon: NotebookText,
  sidebarDefaults: AMADEUS_SIDE_VIEWS,
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
    const pagesLeaf = ws().openView('workspace', {}, 'left')
    ws().openView('amadeus-search', {}, 'left')
    ws().openView('amadeus-tags', {}, 'left')
    // 右栏默认折叠 —— 内容入 stash,toggle 可展(仅作用于全新布局;已存布局尊重用户,见 spaceRegistry.applyNamed 路径)。
    ws().initializeSidebar('right', false)
    if (pagesLeaf) ws().activateLeaf(pagesLeaf.id)
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
  // 对话栏起手比黄金分割宽 20%(IDE 观感);其余 Space 不设 → 与钉宽档同宽。
  sideDefaultScale: { left: 1.2 },
  build() {
    ws().setSidebarDefaults(CODING_SIDE_VIEWS)
    app().selectNewChatAgent?.('coding') // 新会话默认 Coding agent
    ws().openView('code-studio', {}, 'main')
    ws().openView('chat', { followActive: true, reuseKey: 'primary' }, 'left')
    ws().openView('workspace', {}, 'right')
  },
}

/** Automation Space:左=自动化列表(Muse 巡检/Historian/盯任务规则);主=选中项详情/构建器;
 *  右=触发记录(历次运行)。跨栏通道=stores/automationStore(照 calendarNavStore 先例)。 */
const AUTOMATION_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = {
  left: [{ type: 'automation-list', params: {} }],
  right: [{ type: 'automation-runs', params: {} }],
}

const automationSpace: SpaceDefinition = {
  id: 'automation',
  name: () => app().tr('space.automation'),
  icon: Workflow,
  sidebarDefaults: AUTOMATION_SIDE_VIEWS,
  resizableSides: { left: true, right: true },
  build() {
    ws().setSidebarDefaults(AUTOMATION_SIDE_VIEWS)
    ws().openView('automation-detail', {}, 'main')
    ws().openView('automation-list', {}, 'left')
    ws().openView('automation-runs', {}, 'right')
  },
}

/** Public Space:管理已发布网站(Forsion Connect)+ 已公开发布/协作共享的笔记。单视图铺满主区。 */
const PUBLIC_SIDE_VIEWS: Record<'left' | 'right', PersistedPanel[]> = { left: [], right: [] }
const publicSpace: SpaceDefinition = {
  id: 'public',
  name: () => app().tr('space.public'),
  icon: Rocket,
  sidebarDefaults: PUBLIC_SIDE_VIEWS,
  build() {
    ws().setSidebarDefaults(PUBLIC_SIDE_VIEWS)
    ws().openView('public-view', {}, 'main')
  },
}

/** 注册序 = ribbon 顶部默认序(在商店之上)。在 installEngine 内、商店图标注册之前调用。
 *  Amadeus 需 electron 的 window.amadeus 文件系统桥;Tangu Web(无 host)下不注册该 Space。
 *  2026-07-04 起对所有桌面用户开放(此前仅开发者模式 localStorage forsion_tangu_dev_mode='1');
 *  唯一闸改为 window.amadeus(host 文件系统桥)—— 消费处仍写 `window.amadeus && AMADEUS_ENABLED`,故 Web 端照常不注册。 */
export const AMADEUS_ENABLED = true // ponytail: 曾按 dev-mode 门控,现全量开放;闸只剩 window.amadeus(见各消费处的 && 前置)
// 产品档案过滤 × 运行时能力门控 叠加:档案没点名的 Space 直接不注册(单品变体);点名的仍受能力闸约束。
const SPACES: SpaceDefinition[] = [
  // 主页也是**内置插件**(builtins/homepage:Space + homepage 视图随插件启停)。排第一 = ribbon 顶格,
  // 与旧 Forsion Desktop 的「先看到桌面首页」一致;插件页关掉后下次启动即整条不出现。
  ...(homepageAvailable() && builtinEnabled('home') ? [homepageSpace] : []),
  ...(PRODUCT.spaces.includes('tangu') ? [tanguSpace] : []),
  // Inbox 与视图注册同门控(桌面壳 backendStatus 或 移动端本地 inbox mobile;Tangu Web 两者皆无 → 不注册)。
  ...(PRODUCT.spaces.includes('inbox') && (window.tangu?.backendStatus || window.tangu?.mobile) ? [inboxSpace] : []),
  ...(PRODUCT.spaces.includes('amadeus') && window.amadeus && AMADEUS_ENABLED ? [amadeusSpace] : []),
  // Calendar 已是**内置插件**(builtins/calendar:Space + 三个视图随插件启停)。这里仍按槽位声明式带上,
  // 保住 ribbon 默认序与「上次退出停在日历」的启动恢复;插件页关掉后下次启动即整条不出现。
  ...(calendarAvailable() && builtinEnabled('calendar') ? [calendarSpace] : []),
  // Coding 依赖 host 文件桥 + 本地静态预览服务器(仅桌面 electron;Tangu Web 无 codePreviewServe → 不注册)。
  ...(PRODUCT.spaces.includes('coding') && window.tangu?.codePreviewServe ? [codingSpace] : []),
  // Automation 依赖本地 tangu 后端(triggers/automation 端点都是本地特性;Tangu Web 无 backendStatus → 不注册)。
  ...(PRODUCT.spaces.includes('automation') && window.tangu?.backendStatus ? [automationSpace] : []),
  // Public:管理已发布网站/笔记。需 Connect 发布桥或 Amadeus 协作桥其一(Tangu Web 两者皆无 → 不注册)。
  ...(PRODUCT.spaces.includes('public') && (window.tangu?.connectPublish || window.amadeusCollab) ? [publicSpace] : []),
]

export function registerSpaces(): void {
  for (const sp of SPACES) {
    registerSpace(sp)
    addRibbonIcon({ id: `space:${sp.id}`, side: 'top', component: ({ expanded }) => <SpaceButton space={sp} expanded={expanded} /> })
  }
  // 主位槽:把它指着的那个 Space 的图标从上区搬到中间的 home 槽(改 side,不动持久顺序)。
  // 必须在上面那轮 addRibbonIcon 之后 —— 它靠 upsert 覆盖刚注册的那一份。
  installHomeSlot()
  // 活动 Space 不在本产品档案里 → 回落档案默认(单品变体首启:localStorage 可能存着全家桶的 'tangu')。
  const activeId = useSpaceStore.getState().activeSpaceId
  if (SPACES.length && !SPACES.some((sp) => sp.id === activeId)) {
    const fallback = SPACES.some((sp) => sp.id === PRODUCT.defaultSpace) ? PRODUCT.defaultSpace : SPACES[0].id
    useSpaceStore.setState({ activeSpaceId: fallback })
    try { localStorage.setItem('forsion_tangu_active_space', fallback) } catch { /* ignore */ }
  }
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
      // v3(2026-08-14):右栏加了「对话」并置于首位。老布局的右栏 stash 里没有它 → 同 v2 一次性重建。
      if (AMADEUS_HAS_CHAT && localStorage.getItem('amadeus_layout_v3') !== '1') {
        deleteNamedLayout('space:amadeus')
        if (localStorage.getItem('forsion_tangu_active_space') === 'amadeus') clearLayout()
        localStorage.setItem('amadeus_layout_v3', '1')
      }
    } catch { /* ignore */ }
  }
}
