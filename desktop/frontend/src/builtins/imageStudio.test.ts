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
import { BUILTINS } from './index'
beforeEach(() => { vi.clearAllMocks(); engine.space.spaces = []; engine.tangu = true })
describe('Image Studio builtin contribution', () => {
  it('registers native Views and builds the Space with native panels', () => {
    installImageStudioViews(); imageStudioSpace.build()
    expect(engine.registerView.mock.calls.map(call => call[0].type)).toEqual(['image-studio', 'image-studio-nav', 'image-studio-chat', 'image-studio-assets', 'image-studio-inspector'])
    expect(engine.workspace.openView.mock.calls).toEqual([['image-studio', {}, 'main'], ['image-studio-nav', {}, 'left']])
    expect(engine.workspace.initializeSidebar).toHaveBeenCalledWith('right', false)
  })
  it('keeps the project navigation on the left and the chat on the right', () => {
    const types = (list?: Array<{ type: string }>) => list?.map(view => view.type)
    // 右栏起手收起:对话与属性从默认项进暂存,展开即还原;图层不在默认里(进项目时才开在导航旁边)
    imageStudioSpace.build()
    expect(engine.workspace.setSidebarDefaults.mock.calls[0][0]).toMatchObject({ left: [{ type: 'image-studio-nav' }], right: [{ type: 'image-studio-chat' }, { type: 'image-studio-inspector' }] })
    expect(types(imageStudioSpace.pinned?.main)).toEqual(['image-studio'])
    expect(types(imageStudioSpace.pinned?.left)).toEqual(['image-studio-nav'])
    expect(types(imageStudioSpace.pinned?.right)).toEqual(['image-studio-chat'])
    // 每个固定的类型都在这个内置插件的清场名单里(反注册时漏关 = 布局里留下已不存在的类型,下次启动整份丢回默认)
    const pinned = Object.values(imageStudioSpace.pinned ?? {}).flat().map(view => view.type)
    for (const type of pinned) expect(BUILTINS.find(item => item.id === 'image-studio')?.types).toContain(type)
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
