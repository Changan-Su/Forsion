// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDockview, type DockviewApi } from 'dockview-core'
import { useWorkspace, captureSideWidths } from '@lcl/engine/dockviewStore'
import { registerView, unregisterView } from '@lcl/engine/viewRegistry'
import { setPluginCompanions } from './pluginCompanions'
import type { ViewContribution } from './amadeus/plugins/types'

let api: DockviewApi
const def = { id: 'workbench', mainCompanions: [{ type: 'amadeus-editor', key: 'split-probe-document', split: 'right' }] } as ViewContribution
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16))
  localStorage.clear()
  registerView({ type: 'amadeus-editor', displayName: 'Document', factory: () => null })
})
afterEach(() => {
  api?.dispose()
  useWorkspace.setState({ api: null })
  unregisterView('amadeus-editor')
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function setup(width = 1600, leftWidth = 345) {
  const host = document.createElement('div'); document.body.append(host)
  api = createDockview(host, { createComponent: () => ({ element: document.createElement('div'), init() {} }) })
  api.layout(width, 950)
  const owner = api.addPanel({ id: 'owner', component: 'probe', params: { __loc: 'main', __type: 'plugin:split-probe:workbench' } })
  const left = api.addPanel({ id: 'left', component: 'probe', params: { __loc: 'left' }, position: { referencePanel: 'owner', direction: 'left' } })
  const right = api.addPanel({ id: 'right', component: 'probe', params: { __loc: 'right' }, position: { referencePanel: 'owner', direction: 'right' } })
  left.group.api.setSize({ width: leftWidth }); right.group.api.setSize({ width: 300 })
  await vi.advanceTimersByTimeAsync(100)
  useWorkspace.getState().setApi(api)
  useWorkspace.getState().setSideProfile('companions-probe', {}, {})
  // 300px is the default at 1600px; narrower fixtures intentionally use a custom right width.
  useWorkspace.setState({ sideWidths: { left: leftWidth, right: width < 1600 ? 300 : null, bottom: null } })
  api.onDidLayoutChange(() => captureSideWidths(api))
  owner.api.setActive()
  return { owner, left, right }
}

describe('Plugin companions use the same shell sizing contract as file splits', () => {
  it('keeps both sidebars and preferences while creating, folding, and reopening a native companion', async () => {
    const { owner, left, right } = await setup()
    for (const visible of [true, false, true]) {
      setPluginCompanions('split-probe', owner.id, def, visible)
      await vi.advanceTimersByTimeAsync(250)
      expect(left.group.api.width).toBe(345)
      expect(right.group.api.width).toBe(300)
      expect(localStorage.getItem('lcl.sideWidth2.companions-probe')).toBeNull()
      const companion = api.panels.find(p => p.params?.reuseKey === 'split-probe-document')!
      expect(companion.group === owner.group).toBe(!visible)
    }
  })
  it('lets a pending pin land when a plugin folds its companions during mount', async () => {
    const { owner, left } = await setup()
    useWorkspace.getState().repinSides()
    left.group.api.setSize({ width: 700 }) // Dockview's birth width for a new side group
    setPluginCompanions('split-probe', owner.id, def, false)
    await vi.advanceTimersByTimeAsync(250)
    expect(left.group.api.width).toBe(345)
    expect(localStorage.getItem('lcl.sideWidth2.companions-probe')).toBeNull()
  })
  it('keeps narrow layouts inside the container', async () => {
    const { owner } = await setup(880, 400)
    setPluginCompanions('split-probe', owner.id, def, true)
    await vi.advanceTimersByTimeAsync(250)
    expect(api.groups).toHaveLength(4)
    expect(api.groups.reduce((sum, g) => sum + g.api.width, 0)).toBeLessThanOrEqual(api.width)
  })
  it('does not release a newer sidebar-collapse lock', async () => {
    const { owner, right } = await setup()
    setPluginCompanions('split-probe', owner.id, def, true)
    await vi.advanceTimersByTimeAsync(50)
    useWorkspace.getState().toggleSidebar('left')
    await vi.advanceTimersByTimeAsync(600)
    expect(api.getPanel('left')).toBeUndefined()
    expect(right.group.api.width).toBe(300)
    expect(useWorkspace.getState().sideWidths.right).toBeNull()
  })
  it('reserves width only for missing companion columns', async () => {
    const { owner, left, right } = await setup(950)
    setPluginCompanions('split-probe', owner.id, def, true)
    const expanded = { ...def, mainCompanions: [...def.mainCompanions!, { type: 'amadeus-editor', key: 'split-probe-second', split: 'right' }] } as ViewContribution
    setPluginCompanions('split-probe', owner.id, expanded, true)
    await vi.advanceTimersByTimeAsync(250)
    expect(api.panels.filter(p => p.params?.__loc === 'main')).toHaveLength(3)
    expect(left.group.api.width).toBe(345)
    expect(right.group.api.width).toBe(300)
    expect(localStorage.getItem('lcl.sideWidth2.companions-probe')).toBeNull()
  })
  it('fits consecutive owner mutations while the first width lease is pending', async () => {
    const { owner } = await setup(850)
    const second = api.addPanel({ id: 'second-owner', component: 'probe', params: { __loc: 'main', __type: 'plugin:split-probe:second' }, position: { referencePanel: owner.id, direction: 'within' } })
    setPluginCompanions('split-probe', owner.id, def, true)
    const other = { ...def, id: 'second', mainCompanions: [{ type: 'amadeus-editor', key: 'split-probe-second', split: 'right' }] } as ViewContribution
    setPluginCompanions('split-probe', second.id, other, true)
    await vi.advanceTimersByTimeAsync(250)
    expect(api.panels.filter(p => p.params?.__loc === 'main')).toHaveLength(4)
    expect(api.minimumWidth).toBeLessThanOrEqual(api.width)
    expect(api.groups.reduce((sum, g) => sum + g.api.width, 0)).toBeLessThanOrEqual(api.width)
  })
})
