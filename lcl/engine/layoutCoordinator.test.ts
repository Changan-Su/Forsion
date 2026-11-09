// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDockview, type DockviewApi } from 'dockview-core'
import { LayoutCoordinator } from './layoutCoordinator'
import { useWorkspace, attachLayoutCoordinator, presentDockedExtension } from './dockviewStore'
import { loadLayout } from './layoutPersist'
import { registerView, unregisterView } from './viewRegistry'

let api: DockviewApi, c: LayoutCoordinator
const host = () => {
  const viewport = document.createElement('div'), canvas = document.createElement('div')
  viewport.append(canvas); document.body.append(viewport)
  let width = 1500
  Object.defineProperty(viewport, 'clientWidth', { get: () => width })
  Object.defineProperty(viewport, 'clientHeight', { value: 800 })
  api = createDockview(canvas, { defaultRenderer: 'always', disableAutoResizing: true, createComponent: () => ({ element: document.createElement('div'), init() {} }) })
  api.layout(1500, 800)
  useWorkspace.getState().setApi(api)
  useWorkspace.setState({ stash: { left: [], right: [], bottom: [] }, stashActive: { left: null, right: null, bottom: null }, sidebarDefaults: { left: [], right: [], bottom: [] }, pinned: {}, sideWidths: { left: 240, right: 260, bottom: 200 }, sideFree: { left: true, right: true } })
  for (const type of ['probe', 'other', 'third', 'sidebar-empty']) registerView({ type, displayName: type, factory: () => null })
  const a = api.addPanel({ id: 'a', component: 'probe', params: { __loc: 'main', __type: 'probe' } })
  const b = api.addPanel({ id: 'b', component: 'probe', params: { __loc: 'main', __type: 'probe' }, position: { referencePanel: 'a', direction: 'right' } })
  const l = api.addPanel({ id: 'l', component: 'probe', params: { __loc: 'left', __type: 'probe' }, position: { direction: 'left' } })
  c = attachLayoutCoordinator(api, viewport, canvas); c.initialize()
  return { a, b, l, viewport, resize: (w: number) => { width = w; c.refresh(false) } }
}
afterEach(() => { c?.dispose(); api?.dispose(); ['probe', 'other', 'third', 'sidebar-empty'].forEach(unregisterView); useWorkspace.setState({ api: null }); document.body.replaceChildren(); vi.unstubAllGlobals() })
describe('LCL real Dockview coordination', () => {
  it('sizes the actual native groups and scroll canvas without shrinking Views below their minima', () => {
    const { a, b, l, resize } = host()
    expect(l.group.api.width).toBeCloseTo(240, 0)
    expect(a.group.api.width + b.group.api.width).toBeCloseTo(1260, 0)
    const ratios = c.exportRatios()
    resize(700)
    expect(a.group.api.width).toBeGreaterThanOrEqual(320)
    expect(b.group.api.width).toBeGreaterThanOrEqual(320)
    expect(api.width).toBeCloseTo(880, 0)
    expect(c.exportRatios()).toEqual(ratios)
    resize(1500)
    expect(a.group.api.width + b.group.api.width).toBeCloseTo(1260, 0)
  })
  it('parks/reveals the same live side panel and reverses intent before completion', () => {
    const { l } = host()
    const panel = api.getPanel('l')
    useWorkspace.getState().toggleSidebar('left'); c.refresh(false)
    expect(l.group.api.isVisible).toBe(false)
    expect(api.getPanel('l')).toBe(panel)
    useWorkspace.getState().toggleSidebar('left'); c.refresh(false)
    expect(l.group.api.isVisible).toBe(true)
    expect(l.group.api.width).toBeCloseTo(240, 0)
    useWorkspace.getState().toggleSidebar('left')
    useWorkspace.getState().toggleSidebar('left'); c.refresh(false)
    expect(c.visible('left')).toBe(true)
    expect(api.getPanel('l')).toBe(panel)
  })
  it('routes new tabs to explicit origin, then focused main; invalid targets fall back safely', () => {
    const { a, b, l } = host()
    a.api.setActive()
    const opened = useWorkspace.getState().openView('probe', {}, 'main', { newTab: true, groupId: b.group.id })!
    expect(api.getPanel(opened.id)!.group).toBe(b.group)
    b.api.setActive(); useWorkspace.getState().refreshTabs(); l.api.setActive()
    const fallback = useWorkspace.getState().openView('probe', {}, 'main', { newTab: true, groupId: 'gone' })!
    expect(api.getPanel(fallback.id)!.group).toBe(b.group)
  })
  it('restores parked panels and unconstrained preferences from a saved layout', () => {
    const { resize } = host()
    const ws = useWorkspace.getState(), ratios = c.exportRatios()
    ws.toggleSidebar('left'); c.refresh(false); resize(680); ws.saveCurrent()
    const saved = loadLayout()!
    expect(saved.sidebars.left.visible).toBe(false)
    expect(saved.layoutRatios).toEqual(ratios)
    expect(ws.applyLayout(saved)).toBe(true); resize(1500)
    expect(c.visible('left')).toBe(false)
    expect(api.getPanel('l')).toBeDefined()
    ws.toggleSidebar('left'); c.refresh(false)
    expect(api.getPanel('l')!.group.api.width).toBeCloseTo(240, 0)
  })
  it('cleans temporary native Views through the coordinator and allows reopening their region', async () => {
    host()
    const extension = presentDockedExtension({ title: 'Detail', side: 'right' } as never, () => {})
    c.refresh(false)
    expect(api.panels.some(p => p.params?.__type === '__extend')).toBe(true)
    await extension.dispose()
    c.refresh(false)
    expect(api.panels.some(p => p.params?.__type === '__extend')).toBe(false)
    expect(c.visible('right')).toBe(false)
    useWorkspace.getState().toggleSidebar('right'); c.refresh(false)
    expect(c.visible('right')).toBe(true)
  })

  it('finishes a cancelled transition after clicking a sash without saving its intermediate size', () => {
    const { l, viewport } = host()
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frame = f; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    useWorkspace.getState().toggleSidebar('left'); c.refresh(true)
    frame!(performance.now() + 55)
    expect(l.group.api.width).toBeGreaterThan(0)
    expect(l.group.api.width).toBeLessThan(240)
    viewport.querySelector('.dv-sash')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    expect(viewport.dataset.layoutPhase).toBe('settled')
    expect(l.group.api.isVisible).toBe(false)
    expect(useWorkspace.getState().sideWidths.left).toBe(240)
    useWorkspace.getState().toggleSidebar('left'); c.refresh(false)
    expect(l.group.api.width).toBeCloseTo(240, 0)
  })
  it('adds pinned Views introduced while folded without replacing the retained live View', () => {
    const { l } = host(), ws = useWorkspace.getState()
    ws.toggleSidebar('left'); c.refresh(false)
    ws.setPinned({ left: [{ type: 'other', params: {} }] }); ws.ensurePinned()
    expect(c.visible('left')).toBe(false)
    ws.toggleSidebar('left'); c.refresh(false)
    expect(api.getPanel('l')).toBe(l)
    expect(api.panels.filter(p => p.params?.__loc === 'left').map(p => p.params?.__type).sort()).toEqual(['other', 'probe'])
  })
  it('does not resurrect explicitly closed companions on an unchanged right-rule group', () => {
    const { a } = host(), ws = useWorkspace.getState()
    ws.setSidebarDefaults({ left: [], right: [{ type: 'other', params: {} }, { type: 'third', params: {} }] })
    ws.toggleSidebar('right'); c.refresh(false)
    a.api.setActive(); ws.refreshTabs(); ws.applyRightRules(); c.refresh(false)
    ws.closeLeaf(api.panels.find(p => p.params?.__loc === 'right' && p.params?.__type === 'other')!.id)
    ws.toggleSidebar('right'); c.refresh(false)
    ws.toggleSidebar('right'); c.refresh(false); ws.applyRightRules()
    expect(api.panels.filter(p => p.params?.__loc === 'right').map(p => p.params?.__type)).toEqual(['third'])
  })
  it('honors explicit closes of parked Views and changed companion recipes', () => {
    const { l } = host(), ws = useWorkspace.getState()
    ws.toggleSidebar('left'); c.refresh(false); ws.closeLeaf(l.id)
    ws.toggleSidebar('left'); c.refresh(false)
    expect(api.panels.filter(p => p.params?.__loc === 'left').map(p => p.params?.__type)).toEqual(['sidebar-empty'])
    ws.toggleSidebar('right'); c.refresh(false); ws.toggleSidebar('right'); c.refresh(false)
    useWorkspace.setState(s => ({ stash: { ...s.stash, right: [{ type: 'other', params: {} }] } }))
    ws.toggleSidebar('right'); c.refresh(false)
    expect(api.panels.filter(p => p.params?.__loc === 'right').map(p => p.params?.__type)).toEqual(['other'])
  })
  it('transfers preferred main proportions when adding a sidebar in a constrained window', () => {
    const { a, b, resize } = host()
    const key = Object.keys(c.exportRatios()).find(k => k.startsWith('width(') && c.exportRatios()[k].length === 3)!
    c.restoreRatios({ [key]: [240, 350, 910] }); c.refresh(false)
    const preferred = a.group.api.width / b.group.api.width
    resize(640)
    useWorkspace.getState().openView('other', {}, 'right'); c.refresh(false)
    resize(2000)
    expect(a.group.api.width / b.group.api.width).toBeCloseTo(preferred, 2)
  })
  it('collapses a sole extension continuously and still records main sashes after its empty group remains', async () => {
    const { a, b, viewport, resize } = host()
    const extension = presentDockedExtension({ title: 'Detail', side: 'right' } as never, () => {})
    c.refresh(false)
    const panel = api.panels.find(p => p.params?.__type === '__extend')!
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frame = f; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const closing = extension.dispose(); c.refresh(true)
    expect(api.getPanel(panel.id)).toBe(panel)
    frame!(performance.now() + 55)
    expect(panel.group.api.width).toBeGreaterThan(0)
    expect(panel.group.api.width).toBeLessThan(260)
    frame!(performance.now() + 250); await closing; c.refresh(false)
    expect(api.getPanel(panel.id)).toBeUndefined()
    const sash = [...viewport.querySelectorAll('.dv-sash')].filter(el => el.closest('.dv-split-view-container')?.classList.contains('dv-horizontal'))[1]
    sash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    a.group.api.setSize({ width: 800 }); b.group.api.setSize({ width: 460 })
    window.dispatchEvent(new PointerEvent('pointerup'))
    const preferred = a.group.api.width / b.group.api.width
    expect(preferred).toBeGreaterThan(1.6)
    resize(1900)
    expect(a.group.api.width / b.group.api.width).toBeCloseTo(preferred, 2)
  })

})
