import { create } from 'zustand'
import { useWorkspace } from '@lcl/engine'
import { useApp } from './appStore'

export type DetailsSubject = { kind: 'project'; path: string } | { kind: 'agent'; slug: string }

/** 侧栏「查看详情」:右栏 Tangu 详情临时显示这个项目 / Agent,不切当前会话。
 *  `from` = 设下时的当前会话;当前会话一变(切会话 / 新对话)就清掉,右栏回到跟随当前会话。
 *  清除放在 store 订阅里而不是视图 effect:右栏关着时视图挂载晚于设值,挂载期的 effect 会把刚设的 subject 清掉。 */
export const useDetailsSubject = create<{ subject: (DetailsSubject & { from: string | null }) | null }>(() => ({ subject: null }))

useApp.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId && useDetailsSubject.getState().subject) useDetailsSubject.setState({ subject: null })
})

export function showDetails(subject: DetailsSubject): void {
  useDetailsSubject.setState({ subject: { ...subject, from: useApp.getState().activeId } })
  // 右栏收起时视图在 stash 里:先展开(恢复那一份),再激活 —— 直接 openView 会在收起态另开一份
  const ws = useWorkspace.getState()
  if (!ws.rightVisible) ws.toggleSidebar('right')
  useWorkspace.getState().openView('tangu-details', {}, 'right')
}
