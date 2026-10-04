import { beforeEach, describe, expect, it, vi } from 'vitest'
type Remap = (type: string, params: Record<string, unknown>) => Record<string, unknown> | null | undefined
const ws = vi.hoisted(() => {
  const state = {
    mainTabs: [] as Array<{ type: string }>, leftTabs: [] as Array<{ type: string }>, rightTabs: [] as Array<{ type: string }>,
    leftVisible: true, rightVisible: false,
    /** only the docked (Dockview) store has a bottom panel; the single-column store has no such key */
    bottomVisible: false as boolean | undefined,
    /** every leaf type the workspace holds, live or stashed */
    leaves: [] as string[],
    toggleSidebar: vi.fn((side: 'left' | 'right') => { if (side === 'left') state.leftVisible = !state.leftVisible; else state.rightVisible = !state.rightVisible }),
    openView: vi.fn(),
    replaceViewsOfType: vi.fn((_from: string, to: string) => { state.leaves.push(to); return 1 }),
    remapLeaves: vi.fn((fn: Remap) => { state.leaves = state.leaves.filter(type => fn(type, {}) !== null) }),
    showSideView: vi.fn(),
  }
  return state
})
vi.mock('@lcl/engine', () => ({ useWorkspace: { getState: () => ws } }))
import { enterProjectLayout, leaveProjectLayout, resetStudioLayoutMemory, revealStudioPanel } from './layout'

const NAV = 'image-studio-nav', CHAT = 'image-studio-chat', LAYERS = 'image-studio-assets', INSPECTOR = 'image-studio-inspector'
beforeEach(() => {
  vi.clearAllMocks(); resetStudioLayoutMemory()
  Object.assign(ws, { mainTabs: [{ type: 'image-studio' }], leftTabs: [{ type: NAV }], rightTabs: [{ type: CHAT }, { type: INSPECTOR }], leftVisible: true, rightVisible: false, bottomVisible: false, leaves: ['image-studio', NAV, CHAT, INSPECTOR] })
})
describe('Image Studio panel placement', () => {
  it('expands a collapsed side before lighting a panel, and never toggles through showSideView', () => {
    revealStudioPanel(CHAT)
    expect(ws.toggleSidebar).toHaveBeenCalledWith('right')
    expect(ws.openView).toHaveBeenCalledWith(CHAT, {}, 'right')
    expect(ws.toggleSidebar.mock.invocationCallOrder[0]).toBeLessThan(ws.openView.mock.invocationCallOrder[0])
    // already open: a second reveal must not fold the side back (showSideView would)
    revealStudioPanel(INSPECTOR); revealStudioPanel(INSPECTOR)
    expect(ws.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(ws.rightVisible).toBe(true)
    expect(ws.showSideView).not.toHaveBeenCalled()
  })
  it('lights a panel where the user moved it', () => {
    ws.rightTabs = [{ type: CHAT }, { type: INSPECTOR }, { type: LAYERS }]; ws.rightVisible = true
    revealStudioPanel(LAYERS)
    expect(ws.openView).toHaveBeenLastCalledWith(LAYERS, {}, 'right')
    ws.rightTabs = [{ type: CHAT }]; ws.mainTabs = [{ type: 'image-studio' }, { type: INSPECTOR }]
    revealStudioPanel(INSPECTOR)
    expect(ws.openView).toHaveBeenLastCalledWith(INSPECTOR, {}, 'main')
    expect(ws.toggleSidebar).not.toHaveBeenCalled()
  })
  it('opens layers beside the pinned navigation once, and brings the right side out', () => {
    enterProjectLayout()
    expect(ws.replaceViewsOfType).toHaveBeenCalledWith(NAV, LAYERS)
    expect(ws.rightVisible).toBe(true)
    enterProjectLayout() // remount (Space switch): layers are already there, wherever the user left them
    expect(ws.replaceViewsOfType).toHaveBeenCalledTimes(1)
    expect(ws.toggleSidebar).toHaveBeenCalledTimes(1)
  })
  it('takes layers away on the way out and folds the right side only when leaving a project', () => {
    enterProjectLayout()
    leaveProjectLayout(true)
    expect(ws.leaves).not.toContain(LAYERS)
    expect(ws.rightVisible).toBe(false)
    // mounted on the project list with the right side expanded by the user: left alone
    ws.rightVisible = true; ws.leaves.push(LAYERS)
    leaveProjectLayout(false)
    expect(ws.leaves).not.toContain(LAYERS)
    expect(ws.rightVisible).toBe(true)
  })
  it('reopens the right side for the next project unless the user folded it in this run', () => {
    enterProjectLayout(); leaveProjectLayout(true); enterProjectLayout()
    expect(ws.rightVisible).toBe(true) // we folded it, so we bring it back
    ws.rightVisible = false // the user folds it inside a project
    leaveProjectLayout(true); enterProjectLayout()
    expect(ws.rightVisible).toBe(false)
    revealStudioPanel(CHAT) // an explicit request still opens it
    expect(ws.rightVisible).toBe(true)
  })
  it('never opens or closes a drawer on its own in the single-column shell', () => {
    delete (ws as { bottomVisible?: boolean }).bottomVisible // sides are drawers laid over the canvas
    enterProjectLayout()
    expect(ws.replaceViewsOfType).toHaveBeenCalledWith(NAV, LAYERS) // layers still join the navigation's drawer
    expect(ws.rightVisible).toBe(false)
    ws.rightVisible = true // the user pulled the chat drawer out
    leaveProjectLayout(true)
    expect(ws.rightVisible).toBe(true)
    expect(ws.toggleSidebar).not.toHaveBeenCalled()
    revealStudioPanel(INSPECTOR) // asking for a panel still shows it
    expect(ws.openView).toHaveBeenLastCalledWith(INSPECTOR, {}, 'right')
  })
})
