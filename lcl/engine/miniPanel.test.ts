import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelTop } from 'lucide-react'
vi.mock('./uiMode', () => ({ IS_MINI_PANEL: true, IS_TRANSIENT_MINI_PANEL: false, UI_MODE: 'desktop' }))
import { supportsMiniPanel, setMiniViewRouter } from './miniPanel'
import { registerView, unregisterView } from './viewRegistry'
import { useWorkspace } from './singleColumnStore'
import type { SpaceDefinition } from './types'

const space: SpaceDefinition = { id: 'probe', name: 'Probe', icon: PanelTop, sidebarDefaults: { left: [], right: [] }, build() {},
  mini: { view: { type: 'mini-probe' }, mainView: { type: 'full-probe' } } }
beforeEach(() => {
  useWorkspace.setState({ mainLeaves: [], leftLeaves: [], rightLeaves: [], activeMainId: null, leftActiveId: null, rightActiveId: null })
  registerView({ type: 'mini-probe', displayName: 'Mini', factory: () => null, singleton: true })
  registerView({ type: 'full-probe', displayName: 'Full', factory: () => null })
  setMiniViewRouter((target) => target.type === 'full-probe' ? { ...target, type: 'mini-probe' } : target)
})
describe('Mini runtime routing and optional plugin availability', () => {
  it('removes a Space as soon as either registered surface disappears, and restores it on enable', () => {
    expect(supportsMiniPanel(space)).toBe(true)
    unregisterView('mini-probe')
    expect(supportsMiniPanel(space)).toBe(false)
    registerView({ type: 'mini-probe', displayName: 'Mini', factory: () => null })
    expect(supportsMiniPanel(space)).toBe(true)
    unregisterView('full-probe')
    expect(supportsMiniPanel(space)).toBe(false)
  })
  it('does not expose legacy or self-declared full views as adapted', () => {
    expect(supportsMiniPanel({ ...space, mini: undefined })).toBe(false)
    expect(supportsMiniPanel({ ...space, mini: { view: { type: 'full-probe' }, mainView: { type: 'full-probe' } } })).toBe(false)
  })
  it('retargets a singleton entity while keeping one main surface even for new-tab/side requests', () => {
    useWorkspace.getState().openView('full-probe', { itemId: '7' })
    useWorkspace.getState().openView('full-probe', { itemId: '42' }, 'right', { newTab: true })
    expect(useWorkspace.getState().mainLeaves).toHaveLength(1)
    expect(useWorkspace.getState().getActiveLeaf()?.params.itemId).toBe('42')
    expect(useWorkspace.getState().rightLeaves).toHaveLength(0)
  })
  it('closing the last plugin surface does not route a home page into the main window', () => {
    useWorkspace.getState().openView('mini-probe')
    const route = vi.fn(() => null)
    setMiniViewRouter(route)
    useWorkspace.getState().closeViewsOfType('mini-probe')
    expect(useWorkspace.getState().mainLeaves).toHaveLength(0)
    expect(route).not.toHaveBeenCalled()
  })
  it('external navigation delegated to the main panel leaves the Mini surface intact', () => {
    useWorkspace.getState().openView('mini-probe', { itemId: '7' })
    setMiniViewRouter(() => null)
    expect(useWorkspace.getState().openView('full-tool')).toBeNull()
    expect(useWorkspace.getState().getActiveLeaf()?.type).toBe('mini-probe')
    expect(useWorkspace.getState().getActiveLeaf()?.params.itemId).toBe('7')
  })
})
