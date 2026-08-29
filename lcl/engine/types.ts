/**
 * 引擎类型契约(Obsidian 形态)。引擎层只依赖 react + dockview + tokens,**绝不 import feature 代码**。
 * - ViewDefinition: 注册一种视图(≈ Obsidian ItemView),由 viewRegistry 持有。
 * - Leaf: 一个 Dockview panel 的句柄(≈ WorkspaceLeaf);视图从可序列化 params + store 重建,故支持 setParams。
 * - Command / RibbonItem / StatusItem: 命令面板 / ribbon / 状态栏的贡献项。
 * - PluginContext: Amadeus 插件宿主契约的超集(Phase 4 让其插件宿主直接落入)。
 */
import type { ComponentType, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { PersistedPanel } from './layoutPersist'

/** 视图可被开在主区 / 左侧栏 / 右侧栏 / 底部面板(VS Code 式,只在主区下方,不跨左右栏)。 */
export type ViewLocation = 'main' | 'left' | 'right' | 'bottom'

/** 可折叠区(= 除主区外的三个「有折叠钮 + stash + 尺寸记忆」的区)。左右按宽、bottom 按高。 */
export type DockSide = 'left' | 'right' | 'bottom'

/** 各区的默认内容。左右必填;bottom 可选(缺省 = 空停靠区)。 */
export interface SidebarDefaults {
  left: PersistedPanel[]
  right: PersistedPanel[]
  bottom?: PersistedPanel[]
}

/** 一个 Dockview panel 的句柄(≈ Obsidian WorkspaceLeaf)。 */
export interface Leaf {
  readonly id: string
  readonly type: string
  /** 所在区域(主区/左右侧栏),来自 panel 的 __loc。统一工作区等视图按侧自适应。 */
  readonly loc: ViewLocation
  /** 当前可序列化参数(如 {sessionId})。视图据此从 store 重建。 */
  readonly params: Record<string, unknown>
  setTitle(title: string): void
  /** 更新参数(写回 Dockview panel,纳入布局序列化)。 */
  setParams(params: Record<string, unknown>): void
  close(): void
}

/** 视图渲染时拿到的 props。 */
export interface ViewProps {
  leaf: Leaf
  params: Record<string, unknown>
}

/** 视图分类(View 基座统一化,正典 docs/ToBeImproved/View基座统一化方案_2026-08-25.md):
 *  entity = 打开某个有身份的东西(文件路径 / 会话 id);collection = 列举可打开项(列表/日历);
 *  aux = 跟随活动主视图的辅助面板(大纲/双链/记忆);page = 自包含页(设置/启动器/工具)。 */
export type ViewKind = 'entity' | 'collection' | 'aux' | 'page'

/** Dashboard 不再把完整页面无差别塞进任意矩形。每个可嵌视图要声明自己真正支持的
 *  尺寸档与卡片面；缺省仍可嵌，但只允许大/整行两档，由 Dashboard 给出安全兜底。 */
export type DashboardCardSize = 'sm' | 'md' | 'wide' | 'tall' | 'lg' | 'full' | 'workspace'
export type DashboardCardSurface = 'metric' | 'summary' | 'workspace'
export interface DashboardCardContext {
  size: DashboardCardSize
}
export interface DashboardCardDefinition {
  sizes: readonly DashboardCardSize[]
  defaultSize: DashboardCardSize
  surface?: DashboardCardSurface
  /** 尺寸感知的紧凑卡片面。缺席时 Dashboard 只在 lg/full 中渲染完整 factory。 */
  factory?: (props: ViewProps, context: DashboardCardContext) => ReactNode
}

/** 注册一种视图(≈ Obsidian registerView)。 */
export interface ViewDefinition {
  /** 注册键(= Dockview component 名)。 */
  type: string
  /** 标签名;函数形式支持 i18n 懒求值。 */
  displayName: string | (() => string)
  icon?: LucideIcon
  factory: (props: ViewProps) => ReactNode
  /** true = 全局至多一个实例(再开则聚焦已存在的)。 */
  singleton?: boolean
  /** 默认可关。主区视图通常可关;侧栏固定视图设 false。 */
  closable?: boolean
  /** 视图分类,缺省 'page'。deep link 白名单与「最近使用」按它分流。 */
  kind?: ViewKind
  /** entity 类:身份参数名(如 'notePath' / 'sessionId')——params[idParam] 即该实例的身份。 */
  idParam?: string
  /** entity 文件类:认领的后缀声明(小写含点,如 '.dashboard.md')。**声明元数据**:deep link 校验
   *  与嵌卡白名单消费;运行时分派仍在 amadeusNav/pageStore(判定次序=毁档防线),一致性由单测锁住。
   *  priority 大者先判(复合后缀 > 单后缀 > 缺省)。 */
  fileMatch?: { extensions: string[]; priority?: number }
  /** 可被嵌进 Dashboard 卡片(默认 false;宿主白名单语义,插件自声明不足信)。 */
  embeddable?: boolean
  /** Dashboard 的尺寸/表面/紧凑渲染契约。 */
  dashboard?: DashboardCardDefinition
  /** 该 view 做活动主视图时,左栏统一工作区应自动切到的模式(如 'notes' 或 'plugin:<pid>:<srcId>')。
   *  autoWorkspaceMode 的声明式扩展位;内置硬规则仍在 workspaceMode.ts。 */
  workspaceSource?: string
}

/** 命令面板(Cmd/Ctrl+K)里的一条命令(≈ Obsidian addCommand)。 */
export interface Command {
  id: string
  title: string | (() => string)
  keywords?: string
  /** 形如 'mod+k' / 'mod+shift+p';mod = mac⌘ / 其它 Ctrl。 */
  hotkey?: string
  /** 命令面板行首 + 钉进 ribbon 命令区时的图标;缺省用通用图标。 */
  icon?: LucideIcon
  run(): void
}

/** ribbon 竖条上的一个图标(≈ Obsidian addRibbonIcon)。 */
export interface RibbonItem {
  id: string
  /** 普通项:图标钮(component 缺省时必填)。 */
  icon?: LucideIcon
  /** 图标钮的悬浮名;ribbon 展开时也作为图标右侧的名称。 */
  tooltip?: string | (() => string)
  onClick?(): void
  /** 上区(默认;Spaces)或下区(命令);两区内均可拖拽改序、可进收纳夹,跨区禁止。
   *  'head' = 顶部固定区(折叠钮旁):不参与拖拽/收纳/溢出/持久化,宿主放全局常驻件(如 Unit 切换器)。
   *  'home' = **两区之间那段空当的正中**(垂直居中的单独槽位):同样不参与拖拽/收纳/溢出/持久化。
   *   宿主放「主位」件 —— 桌面端放的是 Home 槽位(默认指向主页 Space,可换成别的)。 */
  side?: 'top' | 'bottom' | 'head' | 'home'
  /** 钉死在 ribbon 最底部:不参与拖拽/收纳/溢出(账号卡)。仅对 side:'bottom' 有意义。 */
  pinned?: boolean
  /** 复合项:自定义组件渲染,拿到 ribbon 展开态(替代 icon/onClick)。用于账号卡。 */
  component?: ComponentType<{ expanded: boolean }>
}

/** 底部状态栏的一项(≈ Obsidian addStatusBarItem)。 */
export interface StatusItem {
  id: string
  component: ComponentType
  side?: 'left' | 'right'
}

/**
 * 一个 Space(空间)：取代传统「App」的功能组合 —— 一组视图 + 默认布局 + 侧栏默认。
 * Workbench ⊃ Space ⊃ View(+ Layout)。在 ribbon 顶部成组、单选切换;切换即整体换布局。
 * 刻意只含落地所需字段;plugins/commands/dataContext/permissions 等愿景项待真有第三方 Space 再加。
 */
export interface SpaceDefinition {
  /** 稳定键:localStorage 活动空间 + 命名布局键("space:<id>")。 */
  id: string
  /** 名称;函数形式支持 i18n 懒求值(同 ViewDefinition.displayName)。 */
  name: string | (() => string)
  icon?: LucideIcon
  /** 构建该 Space 的默认布局(开它的几个视图)。无已存命名布局时调用。 */
  build(): void
  /** 该 Space 的侧栏默认内容;每次切换都重设(applyNamed 不会跑 build)。
   *  `bottom` 可选:底部面板默认是**空停靠区**,只有明确要预置内容的 Space 才写(如 Tangu 预置终端)。
   *  写了也不等于展开 —— 展开与否由 build() 里的 initializeSidebar('bottom', …) 决定,缺省折叠。 */
  sidebarDefaults: SidebarDefaults
  /** 主区关掉最后一个 view 时填充的「新页面」(不留空白)。缺省 = 打开 launcher 启动器。
   *  Amadeus 等无启动器的 Space 用它指向自己的主视图(如空白编辑器)。 */
  newPage?(): void
  /** 哪些侧栏「可自由拖宽 + 持久化」。**2026-08-14 起缺省两侧都开**(用户要求:拖过的宽度要常驻,
   *  折叠/展开、切 Space、重启都不丢)——本字段因此变成**opt-out**:显式写 false 的那侧才钉黄金分割。 */
  resizableSides?: { left?: boolean; right?: boolean }
  /** 侧栏「首次无记录」的默认宽 = 黄金分割 × 本系数;**缺省 1 = 与其他 Space 同宽**。
   *  只有确实需要更宽起手的 Space 才设(如 Coding 对话栏 1.2)。用户拖过之后一律以记住的宽度为准。 */
  sideDefaultScale?: { left?: number; right?: number }
  /** 「工作区」视图处于 auto 档时,主视图**没有硬规则**则左栏落这个;**缺省 'sessions' = 与其他 Space 一致**。
   *  只有主区内容天然对应某个侧栏档的 Space 才设(如 Amadeus → 'notes')。
   *  右栏不受此影响(恒为 'files' = 参考/附件栏)。硬规则见 frontend/src/views/workspaceMode.ts。 */
  autoWorkspaceMode?: 'sessions' | 'files' | 'notes'
}

/** 插件契约 —— Amadeus PluginContext 的超集(加了 registerView / registerRibbonIcon)。 */
export interface PluginContext {
  registerView(def: ViewDefinition): void
  registerCommand(command: Command): void
  registerRibbonIcon(item: RibbonItem): void
  registerStatusItem(item: StatusItem): void
}

/** 求值 displayName/title/tooltip(支持 string | () => string)。 */
export function label(v: string | (() => string)): string {
  return typeof v === 'function' ? v() : v
}

/** 面板参数里「指向哪个对象」的那部分:一切 *Path / path / sessionId。视图类型五花八门
 *  (pdfPath / dbPath / drawingPath / dashPath / imagePath / filePath / notePath / path…),
 *  与其维护一张类型表,不如按参数名收 —— 新视图自带命名习惯就自动进比对。
 *  用途:MainTab 的身份指纹。**同一个 tab 里就地换一个文件**只改这些参数,不进比对的话
 *  mainTabs 引用不变 → 导航历史/最近使用两条订阅整片看不见这次跳转(2026-08-20 用户实报
 *  「同一个 View 里发生页面跳转,前进后退无法识别」)。 */
export function identitySig(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((k) => /path$/i.test(k) || k === 'sessionId')
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&')
}

export type { ReactNode }
