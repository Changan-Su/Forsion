import { create } from 'zustand'
import { activeMainPanel, useWorkspace } from '@lcl/engine'
import { useApp } from './appStore'

export type DetailsSubject = { kind: 'project'; path: string } | { kind: 'agent'; slug: string }

/** 侧栏「查看详情」:右栏 Tangu 详情临时显示这个项目 / Agent,不切当前会话。
 *  `from` = 设下时右栏跟随的主会话;主会话一变(切会话 / 新对话 / 换到钉住别的会话的主标签)就清掉,右栏回到跟随。
 *  清除放在 store 订阅里而不是视图 effect:右栏关着时视图挂载晚于设值,挂载期的 effect 会把刚设的 subject 清掉。 */
export const useDetailsSubject = create<{ subject: (DetailsSubject & { from: string | null }) | null }>(() => ({ subject: null }))

/** 右栏跟随的主会话(同 AgentProfileView 的 useMainSessionId,非 hook 版):主标签钉住了会话就是它,否则是当前会话。 */
export function mainSessionIdNow(): string | null {
  const ws = useWorkspace.getState()
  const panels = ws.api?.panels || []
  const main = ws.api ? activeMainPanel(ws.api) : panels.find((p) => p.id === ws.focusedChatLeafId && p.params?.__loc === 'main')
  const params = main?.params as { followActive?: boolean; sessionId?: unknown } | undefined
  return params?.followActive === false && typeof params.sessionId === 'string' ? params.sessionId : useApp.getState().activeId
}

const expire = (): void => {
  const sub = useDetailsSubject.getState().subject
  if (sub && sub.from !== mainSessionIdNow()) useDetailsSubject.setState({ subject: null })
}
// 第一次「查看详情」时才订阅(subject 只能经 showDetails 设下):模块导入不带副作用,mock 了 store 的测试照常能 import
let watching = false

export function showDetails(subject: DetailsSubject): void {
  if (!watching) { watching = true; useApp.subscribe(expire); useWorkspace.subscribe(expire) }
  useDetailsSubject.setState({ subject: { ...subject, from: mainSessionIdNow() } })
  revealRight(5)
}

/** 展开右栏并激活详情视图。收起补间(~200ms)期间 rightVisible 已是 false、面板却还在:这时 toggle 会被判成「还开着」再收一次
 *  (lcl 已知局限),所以等它收完再展开。收起态的视图在 stash 里:先 toggle 恢复那一份再激活,直接 openView 会另开一份。 */
function revealRight(retries: number): void {
  const ws = useWorkspace.getState()
  const closing = !ws.rightVisible && !!ws.api?.panels.some((p) => p.params?.__loc === 'right')
  if (closing && retries > 0) { setTimeout(() => revealRight(retries - 1), 120); return }
  if (!ws.rightVisible) ws.toggleSidebar('right')
  useWorkspace.getState().openView('tangu-details', {}, 'right')
}
