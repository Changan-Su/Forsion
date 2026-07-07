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

/** 视图可被开在主区 / 左侧栏 / 右侧栏。 */
export type ViewLocation = 'main' | 'left' | 'right'

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
}

/** 命令面板(Cmd/Ctrl+K)里的一条命令(≈ Obsidian addCommand)。 */
export interface Command {
  id: string
  title: string | (() => string)
  keywords?: string
  /** 形如 'mod+k' / 'mod+shift+p';mod = mac⌘ / 其它 Ctrl。 */
  hotkey?: string
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
  /** 顶部(默认,可拖动改序)或底部(常驻:设置 / 账号)。 */
  side?: 'top' | 'bottom'
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
  /** 该 Space 的侧栏默认内容;每次切换都重设(applyNamed 不会跑 build)。 */
  sidebarDefaults: Record<'left' | 'right', PersistedPanel[]>
  /** 主区关掉最后一个 view 时填充的「新页面」(不留空白)。缺省 = 打开 launcher 启动器。
   *  Amadeus 等无启动器的 Space 用它指向自己的主视图(如空白编辑器)。 */
  newPage?(): void
  /** 哪些侧栏「可自由拖宽 + 持久化」(默认 20% 宽);缺省两侧都钉黄金分割宽。
   *  Coding Space 的对话栏(左)用它当宽 IDE 侧栏。 */
  resizableSides?: { left?: boolean; right?: boolean }
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

export type { ReactNode }
