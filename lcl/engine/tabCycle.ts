import type { IDockviewPanel } from 'dockview-react'

type TabKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

/** Ctrl/Cmd+Tab 在当前 Dockview group 内循环；Shift 反向。 */
export function tabCycleDelta(event: TabKey): -1 | 0 | 1 {
  if (event.key !== 'Tab' || event.altKey || (!event.ctrlKey && !event.metaKey)) return 0
  return event.shiftKey ? -1 : 1
}

/** 只切当前聚焦 panel 所属 group，不跨左右栏或底栏。 */
export function cycleFocusedGroupTab(activePanel: IDockviewPanel | null | undefined, delta: -1 | 1): boolean {
  const group = activePanel?.group
  const panels = group?.panels ?? []
  if (!group || panels.length < 2) return false
  const current = group.activePanel ?? activePanel
  const index = panels.findIndex((panel) => panel.id === current?.id)
  if (index < 0) return false
  const next = panels[(index + delta + panels.length) % panels.length]
  if (!next || next.id === current?.id) return false
  next.api.setActive()
  return true
}
