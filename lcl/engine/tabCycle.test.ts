import { describe, expect, it, vi } from 'vitest'
import type { IDockviewPanel } from 'dockview-react'
import { cycleFocusedGroupTab, tabCycleDelta } from './tabCycle'

function group(ids: string[], activeIndex: number) {
  const calls: string[] = []
  const g = { panels: [] as IDockviewPanel[], activePanel: undefined as IDockviewPanel | undefined }
  g.panels = ids.map((id) => ({
    id,
    group: g,
    api: { setActive: vi.fn(() => calls.push(id)) },
  }) as unknown as IDockviewPanel)
  g.activePanel = g.panels[activeIndex]
  return { g, calls }
}

describe('cycleFocusedGroupTab', () => {
  it('识别 Ctrl/Cmd+Tab，并让 Shift 反向', () => {
    expect(tabCycleDelta({ key: 'Tab', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(1)
    expect(tabCycleDelta({ key: 'Tab', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true })).toBe(-1)
    expect(tabCycleDelta({ key: 'Tab', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(0)
    expect(tabCycleDelta({ key: 'Tab', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false })).toBe(0)
  })

  it('只在当前聚焦 group 内前进，并在末尾回绕', () => {
    const { g, calls } = group(['left-a', 'left-b', 'left-c'], 2)
    expect(cycleFocusedGroupTab(g.activePanel, 1)).toBe(true)
    expect(calls).toEqual(['left-a'])
  })

  it('Shift 反向，并在首位回绕到末尾', () => {
    const { g, calls } = group(['main-a', 'main-b', 'main-c'], 0)
    expect(cycleFocusedGroupTab(g.activePanel, -1)).toBe(true)
    expect(calls).toEqual(['main-c'])
  })

  it('当前 group 只有一个 tab 时不吞快捷键', () => {
    const { g, calls } = group(['only'], 0)
    expect(cycleFocusedGroupTab(g.activePanel, 1)).toBe(false)
    expect(calls).toEqual([])
  })
})
