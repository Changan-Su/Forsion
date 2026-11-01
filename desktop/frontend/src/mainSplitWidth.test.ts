// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDockview, type DockviewApi } from 'dockview-core'
import { captureSideWidths, useWorkspace } from '@lcl/engine/dockviewStore'

let api: DockviewApi
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16))
})
afterEach(() => {
  api?.dispose()
  useWorkspace.setState({ api: null })
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function setup(width: number, left: number) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  api = createDockview(host, { createComponent: () => ({ element: document.createElement('div'), init() {} }) })
  api.layout(width, 950)
  const main = api.addPanel({ id: 'note', component: 'probe', params: { __loc: 'main', __type: 'probe' } })
  const l = api.addPanel({ id: 'left', component: 'probe', params: { __loc: 'left', __type: 'probe' }, position: { referencePanel: main.id, direction: 'left' } })
  const r = api.addPanel({ id: 'right', component: 'probe', params: { __loc: 'right', __type: 'probe' }, position: { referencePanel: main.id, direction: 'right' } })
  l.group.api.setSize({ width: left })
  r.group.api.setSize({ width: 300 })
  await vi.advanceTimersByTimeAsync(100)
  const ws = useWorkspace.getState()
  ws.setApi(api)
  ws.setSideProfile('native-split', {}, {})
  api.onDidLayoutChange(() => captureSideWidths(api))
  main.api.setActive()
  return { ws, l, r }
}

describe('Main splits with the real Dockview layout engine', () => {
  it('preserves the other sidebar when collapse starts before split cleanup', async () => {
    const { ws, r } = await setup(1600, 280)
    ws.splitActive('right')
    await vi.advanceTimersByTimeAsync(50)
    ws.toggleSidebar('left')
    await vi.advanceTimersByTimeAsync(600)
    expect(api.getPanel('left')).toBeUndefined()
    expect(r.group.api.width).toBe(300)
    expect(useWorkspace.getState().sideWidths.right).toBeNull()
  })

  it('lets sidebars yield if their custom widths leave too little room for a split', async () => {
    const { ws } = await setup(880, 400)
    ws.splitActive('right')
    await vi.advanceTimersByTimeAsync(600)
    expect(api.groups).toHaveLength(4)
    expect(api.groups.reduce((sum, g) => sum + g.api.width, 0)).toBeLessThanOrEqual(880)
    expect(api.minimumWidth).toBeLessThanOrEqual(api.width)
  })
})
