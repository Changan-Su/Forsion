/** 真实引擎装配:注册视图(会话/对话)+ ribbon + 命令 + 默认布局。替代 demoBootstrap。 */
import { MessageCircle, MessagesSquare, Plus, Command as CommandIcon, Moon, Languages, MessageSquare, FolderOpen, List, BookOpen, Bot, Smartphone, Store } from 'lucide-react'
import { registerView, addCommand, addRibbonIcon, openCommandPalette, useWorkspace } from './engine'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { cycleLocale } from './i18n'
import { SessionsView } from './views/SessionsView'
import { ChatView } from './views/ChatView'
import { FilesView, TocView, MemoryPanelView, SubchatsView } from './views/RightViews'
import { NewTabView } from './views/NewTabView'
import { WeChatSpecialView, AgentsDetailSpecialView, WorkspaceDetailSpecialView } from './views/SpecialViews'

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
const splitChat = (): void => {
  const active = ws().getActiveLeaf()
  if (active?.type !== 'chat') { ws().splitActive('right'); return }
  const pinned = typeof active.params.sessionId === 'string' ? active.params.sessionId : app().activeId
  ws().splitActive('right', { followActive: false, sessionId: pinned, reuseKey: `session:${pinned || 'new'}` })
}
const DEFAULT_SIDE_VIEWS = {
  left: [{ type: 'sessions', params: {} }],
  right: [
    { type: 'files', params: {} },
    { type: 'toc', params: {} },
    { type: 'memory', params: {} },
    { type: 'subchats', params: {} },
  ],
}

let installed = false

export function installEngine(): void {
  if (installed) return
  installed = true
  ws().setSidebarDefaults(DEFAULT_SIDE_VIEWS)

  registerView({ type: 'sessions', displayName: () => app().tr('workbench.sessions'), icon: MessagesSquare, factory: () => <SessionsView />, singleton: true, closable: false })
  registerView({ type: 'chat', displayName: () => app().tr('workbench.chat'), icon: MessageCircle, factory: (props) => <ChatView {...props} />, singleton: true, closable: false })
  // 右栏视图(可关,可重开)
  registerView({ type: 'files', displayName: () => app().tr('panel.tab.workspace'), icon: FolderOpen, factory: () => <FilesView />, singleton: true })
  registerView({ type: 'toc', displayName: () => app().tr('panel.tab.toc'), icon: List, factory: () => <TocView />, singleton: true })
  registerView({ type: 'memory', displayName: () => app().tr('panel.tab.memory'), icon: BookOpen, factory: () => <MemoryPanelView />, singleton: true })
  registerView({ type: 'subchats', displayName: () => app().tr('panel.tab.subchats'), icon: MessageCircle, factory: () => <SubchatsView />, singleton: true })
  // 主区特殊视图(按需从侧栏打开,不进默认布局)
  registerView({ type: 'wechat', displayName: () => app().tr('special.wechat.title'), icon: Smartphone, factory: () => <WeChatSpecialView />, singleton: true })
  registerView({ type: 'agents-detail', displayName: () => app().tr('special.agents.title'), icon: Bot, factory: () => <AgentsDetailSpecialView />, singleton: true })
  registerView({ type: 'workspace-detail', displayName: () => app().tr('app.workspace'), icon: FolderOpen, factory: () => <WorkspaceDetailSpecialView />, singleton: true })
  // 新建标签页(空白启动器):列出所有视图按 主区/侧区 分类,选中即在对应区打开。
  registerView({ type: 'launcher', displayName: () => app().tr('newtab.title'), icon: Plus, factory: (props) => <NewTabView {...props} /> })

  // ribbon = 左侧功能条:商店置顶为第一个图标,其后明暗/语言/反馈/命令。左右栏折叠钮已移到各自面板右缘(见 WorkspaceHost)。
  // 商店(装到 ~/.tangu)与反馈(submitFeedback)是 host 能力:Tangu Web 下 window.tangu 无对应方法 → 不注册。
  if (window.tangu?.marketList) addRibbonIcon({ id: 'rb-market', icon: Store, tooltip: () => app().tr('market.title'), onClick: () => app().openMarket() })
  addRibbonIcon({ id: 'rb-mode', icon: Moon, tooltip: () => app().tr('theme.changeMode'), onClick: () => useTheme.getState().toggleMode() })
  addRibbonIcon({ id: 'rb-locale', icon: Languages, tooltip: () => app().tr('locale.toggleTitle'), onClick: () => cycleLocale() })
  if (window.tangu?.submitFeedback) addRibbonIcon({ id: 'rb-feedback', icon: MessageSquare, tooltip: () => app().tr('feedback.title'), onClick: () => app().openFeedback() })
  addRibbonIcon({ id: 'rb-cmd', icon: CommandIcon, tooltip: () => app().tr('command.palette'), onClick: openCommandPalette })

  // commands
  addCommand({ id: 'new-chat', title: () => app().tr('sidebar.newChat'), keywords: 'new chat 新对话', hotkey: 'mod+n', run: blankNewChat })
  addCommand({ id: 'toggle-left', title: () => app().tr('command.toggleLeft'), keywords: 'sidebar 左栏', hotkey: 'mod+b', run: () => ws().toggleSidebar('left') })
  addCommand({ id: 'toggle-right', title: () => app().tr('command.toggleRight'), keywords: 'sidebar 右栏', run: () => ws().toggleSidebar('right') })
  addCommand({ id: 'theme-mode', title: () => app().tr('theme.changeMode'), keywords: 'theme dark 明暗', run: () => useTheme.getState().toggleMode() })
  addCommand({ id: 'theme-skin', title: () => app().tr('theme.changeSkin'), keywords: 'theme skin 配色', run: () => useTheme.getState().cycleSkin() })
  addCommand({ id: 'theme-lang', title: () => app().tr('theme.changeLanguage'), keywords: 'theme language lovable soft', run: () => useTheme.getState().cycleLang() })
  addCommand({ id: 'split-right', title: () => app().tr('command.splitRight'), keywords: 'split 分屏', hotkey: 'mod+\\', run: splitChat })
  addCommand({ id: 'reset-layout', title: () => app().tr('command.resetLayout'), keywords: 'layout reset default 布局 默认 黄金分割', run: () => ws().resetLayout() })
  addCommand({ id: 'save-layout', title: () => app().tr('command.saveLayout'), keywords: 'layout workspace save 命名布局', run: () => {
    const name = window.prompt(app().tr('layout.namePrompt'))?.trim()
    if (name) { ws().saveNamed(name); app().toast(app().tr('layout.saved', { name })) }
  } })
  addCommand({ id: 'apply-layout', title: () => app().tr('command.applyLayout'), keywords: 'layout workspace restore 命名布局', run: () => {
    const names = ws().namedLayouts()
    if (!names.length) { app().toast(app().tr('layout.none')); return }
    const name = window.prompt(app().tr('layout.applyPrompt', { names: names.join(', ') }), names[0])?.trim()
    if (name && names.includes(name)) ws().applyNamed(name)
  } })
  addCommand({ id: 'stop-run', title: () => app().tr('command.stop'), keywords: 'stop 停止', run: () => app().stop() })
  addCommand({ id: 'compact', title: () => app().tr('command.compact'), keywords: 'compact 压缩', run: () => void app().compact() })
  addCommand({ id: 'branch', title: () => app().tr('command.branch'), keywords: 'branch 分支', run: () => void app().branchFromMessage() })
  addCommand({ id: 'open-settings', title: () => app().tr('settings.title'), keywords: 'settings 设置 preferences', hotkey: 'mod+,', run: () => app().openSettings() })
}

/** 默认布局:对话(主)→ 会话(左)→ 右栏(文件 + 目录/记忆/子聊天 同组 tab)。 */
export function buildDefaultLayout(): void {
  ws().setSidebarDefaults(DEFAULT_SIDE_VIEWS)
  ws().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
  ws().openView('sessions', {}, 'left')
  if (typeof window === 'undefined' || window.innerWidth >= 1100) {
    ws().openView('files', {}, 'right')
    ws().openView('toc', {}, 'right')
    ws().openView('memory', {}, 'right')
    ws().openView('subchats', {}, 'right')
  } else {
    ws().initializeSidebar('right', false)
  }
}
