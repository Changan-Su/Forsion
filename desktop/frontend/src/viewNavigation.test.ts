// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
const mode = vi.hoisted(() => ({ mini: false }))
vi.mock('../../../lcl/engine/uiMode', () => ({ get IS_MINI_PANEL() { return mode.mini }, UI_MODE: 'desktop' }))
vi.mock('../../../lcl/engine/workspaceStore', () => ({
  useWorkspace: { getState: () => ({ leafById: () => ({ loc: 'main' }) }) }, activeMainPanel: () => null,
}))
import { ViewHead, ViewModeSwitch } from '../../../lcl/engine/viewModes'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const mounted: Array<() => void> = []
afterEach(() => { mounted.splice(0).forEach(fn => fn()); mode.mini = false })
function mount(node: React.ReactNode) {
  const el = document.createElement('div'); document.body.append(el)
  const root = createRoot(el)
  act(() => root.render(node))
  mounted.push(() => { act(() => root.unmount()); el.remove() })
  return el
}
describe('Navigation belongs to the available shell', () => {
  it('desktop empty heads and mode switches do not reserve content space', () => {
    const el = mount(React.createElement(React.Fragment, null, React.createElement(ViewHead, { leafId: 'desktop' }), React.createElement(ViewModeSwitch, { leafId: 'desktop' })))
    expect(el.children.length).toBe(0)
  })
  it('Mini without a tab strip retains its existing head navigation', () => {
    mode.mini = true
    const el = mount(React.createElement(ViewHead, { leafId: 'mini' }))
    expect(el.querySelectorAll('[data-view-nav="mini"]')).toHaveLength(1)
    expect(el.querySelectorAll('button')).toHaveLength(2)
  })
  it('Mini custom toolbar retains navigation before its mode switch', () => {
    mode.mini = true
    const el = mount(React.createElement(ViewModeSwitch, { leafId: 'mini-custom' }))
    expect(el.querySelectorAll('[data-view-nav="mini-custom"]')).toHaveLength(1)
  })
})
