// 打开会话的统一门面(会话列表 / ⌘K 快切等都走这里)——把会话开进「当前聚焦的主 leaf」,
// 修「新建标签页并聚焦时点会话,却替换了旧视图而非新标签」。决策见 planSessionOpen。
import { useApp } from './stores/appStore'
import { useWorkspace, activeMainPanel } from '@lcl/engine'
import { planSessionOpen } from './sessionOpenPlan'

export function openSession(id: string, opts?: { newTab?: boolean }): void {
  useApp.getState().setActiveId(id) // 侧栏高亮 + 「跟随主聊天」据此切换会话
  const ws = useWorkspace.getState()
  // ⌘/Ctrl 单击:直接开一个**钉住该会话**的新标签(followActive:false,否则它会跟着侧栏高亮乱跑,
  // 等于两个标签永远显示同一个会话)。语义同 Amadeus 的 openNote({newTab})。
  if (opts?.newTab) { ws.openView('chat', { sessionId: id, followActive: false }, 'main', { newTab: true }); return }
  const focused = ws.api ? activeMainPanel(ws.api) : null
  const fp = (focused?.params ?? {}) as { __type?: string; followActive?: boolean }
  switch (planSessionOpen(focused ? { type: fp.__type, followActive: fp.followActive } : null)) {
    case 'follow':
      return // 跟随主聊天已随 activeId 切到该会话,无需动 leaf
    case 'pin':
      // 就地把聚焦 leaf 固定成该会话的聊天;bootstrapEngine 的跟随订阅对固定 leaf 放行不回拽。
      ws.navigateLeaf(focused!.id, 'chat', { sessionId: id, followActive: false })
      return
    case 'fresh':
      ws.openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
      return
  }
}
