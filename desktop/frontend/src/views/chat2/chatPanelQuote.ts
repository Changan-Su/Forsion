/**
 * 把一段引用交给**侧栏对话**(`chat-panel`)并把它揭到前台 —— 编辑器「问 Tangu」(评审 G3-04,经 tanguProbe.askInChat)走这里。
 * 聊天里划线的「在侧栏提问」2026-10-11 起不走这条:它开的是右侧栏的旁聊(btwStore.openBtwInSidebar)。
 *
 * 引用挂成输入框上方的一张引用卡(setPendingChatQuote,侧栏还没挂载也行:ChatView 一挂上就消费),不发送、不动草稿。
 */
import { useWorkspace } from '@lcl/engine'
import { useApp } from '../../stores/appStore'

export function quoteInChatPanel(text: string): void {
  if (!text.trim()) return
  useApp.getState().setPendingChatQuote('chat-panel', text)
  const workspace = useWorkspace.getState()
  const panelIsFront = workspace.rightVisible
    && workspace.rightTabs.some((tab) => tab.type === 'chat-panel' && tab.active)
  // showSideView 对当前活动项是 toggle(dockview;单列壳是纯 reveal);这里的语义是 reveal,已在前台时不能反向收起。
  if (!panelIsFront) workspace.showSideView('right', 'chat-panel')
}
