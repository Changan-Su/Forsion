import { beforeEach, describe, expect, it, vi } from 'vitest'
const engine = vi.hoisted(() => ({
  registerView: vi.fn(), registerSpace: vi.fn(), unregisterSpace: vi.fn(), addRibbonIcon: vi.fn(), removeRibbonIcon: vi.fn(), addCommand: vi.fn(), setActiveSpace: vi.fn(),
  workspace: { setSidebarDefaults: vi.fn(), openView: vi.fn(), initializeSidebar: vi.fn() },
  space: { spaces: [] as Array<{ id: string }>, activeSpaceId: 'image-studio' },
  tangu: true,
}))
vi.mock('@lcl/engine', () => ({ ...engine, Skeleton: () => null, useWorkspace: { getState: () => engine.workspace }, useSpaceStore: { getState: () => engine.space } }))
vi.mock('../features/runtime', () => ({ hasNativeFeature: () => engine.tangu }))
vi.mock('../components/SpaceButton', () => ({ SpaceButton: () => null }))
vi.mock('../product', () => ({ PRODUCT: { defaultSpace: 'home' } }))
import { imageStudioAvailable, imageStudioSpace, installImageStudioSpace, installImageStudioViews, removeImageStudioSpace } from './imageStudio'
beforeEach(() => { vi.clearAllMocks(); engine.space.spaces = []; engine.tangu = true })
describe('Image Studio builtin contribution', () => {
  it('registers native Views and builds the Space with native panels', () => {
    installImageStudioViews(); imageStudioSpace.build()
    expect(engine.registerView.mock.calls.map(call => call[0].type)).toEqual(['image-studio', 'image-studio-chat', 'image-studio-assets', 'image-studio-inspector'])
    expect(engine.workspace.openView).toHaveBeenCalledWith('image-studio', {}, 'main')
    expect(engine.workspace.openView).toHaveBeenCalledWith('image-studio-chat', {}, 'left')
    expect(engine.workspace.initializeSidebar).toHaveBeenCalledWith('right', false)
  })
  it('installs idempotently and leaves the current Space before unregistering', () => {
    installImageStudioSpace(); engine.space.spaces = [{ id: 'home' }, { id: 'image-studio' }]; installImageStudioSpace()
    expect(engine.registerSpace).toHaveBeenCalledTimes(1)
    removeImageStudioSpace()
    expect(engine.setActiveSpace).toHaveBeenCalledWith('home')
    expect(engine.unregisterSpace).toHaveBeenCalledWith('image-studio')
    expect(engine.setActiveSpace.mock.invocationCallOrder[0]).toBeLessThan(engine.unregisterSpace.mock.invocationCallOrder[0])
  })
  it('follows the native Tangu capability boundary', () => {
    expect(imageStudioAvailable()).toBe(true); engine.tangu = false; expect(imageStudioAvailable()).toBe(false)
  })
})
