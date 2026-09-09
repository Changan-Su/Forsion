import { MessageCircle, BookOpen, FolderOpen, Bot } from 'lucide-react'
import { registerView } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { translate } from '../i18n'
import { ChatView } from '../views/ChatView'
import { MemoryPanelView, SubchatsView, SessionFilesView } from '../views/RightViews'
import { AgentsDetailSpecialView, WorkspaceDetailSpecialView } from '../views/SpecialViews'
import { hasNativeFeature } from './runtime'
const app = () => useApp.getState()

/** Activate only the Tangu package's native view contributions. */
export function registerTanguViews(): void {
  if (!hasNativeFeature('tangu')) return
  // chat 可关闭(浏览器式):关掉主区最后一个 view → 显示「新建标签页」启动器(见 workspaceStore.closeLeaf)。
  registerView({ type: 'chat', kind: 'entity', idParam: 'sessionId', displayName: () => app().tr('workbench.chat'), icon: MessageCircle, factory: (props) => <ChatView {...props} />, singleton: true })
  // 侧栏对话只是 ChatView 的另一个停靠身份:绕开 `chat` singleton 与主区实例冲突,但仍跟随同一
  // activeId / messagesBySession / runningBySession,不创建所谓「Side Chat」会话或第二套 runtime。
  registerView({ type: 'chat-panel', kind: 'aux', displayName: () => translate('bootengine.view.chatPanel'), icon: MessageCircle, factory: (props) => <ChatView {...props} />, singleton: true })
  // 右栏视图(可关,可重开)
  registerView({ type: 'memory', kind: 'aux', displayName: () => app().tr('panel.tab.memory'), icon: BookOpen, factory: () => <MemoryPanelView />, singleton: true })
  registerView({ type: 'subchats', kind: 'aux', displayName: () => app().tr('panel.tab.subchats'), icon: MessageCircle, factory: () => <SubchatsView />, singleton: true })
  registerView({ type: 'session-files', kind: 'aux', displayName: () => app().tr('panel.tab.workspace'), icon: FolderOpen, factory: () => <SessionFilesView />, singleton: true })
  // 主区特殊视图(按需从侧栏打开,不进默认布局)。旧 'wechat' 视图已退役:恢复布局时未注册类型被引擎自动剔除。
  registerView({ type: 'agents-detail', kind: 'page', displayName: () => app().tr('special.agents.title'), icon: Bot, factory: () => <AgentsDetailSpecialView />, singleton: true })
  registerView({ type: 'workspace-detail', kind: 'page', displayName: () => app().tr('app.workspace'), icon: FolderOpen, factory: () => <WorkspaceDetailSpecialView />, singleton: true })
}
