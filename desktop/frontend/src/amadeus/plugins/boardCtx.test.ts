// @vitest-environment happy-dom
/** ctx.ui.mountBoard / boardToSvg 在插件上下文这一层:形状错当场抛、装载期间的调用攒着、停用插件时收掉。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginContext } from './types'

const surface = vi.hoisted(() => ({ mount: vi.fn(), toSvg: vi.fn(), handles: [] as any[] }))
vi.mock('./boardSurface', () => ({ mountPluginBoard: surface.mount, pluginBoardToSvg: surface.toSvg }))
vi.mock('../api', () => ({ amadeus: undefined }))
const { usePluginStore } = await import('./pluginStore')

function context(id: string): PluginContext {
  let ref!: PluginContext
  usePluginStore.getState().init([{ id, name: id, version: '1', setup(c) { ref = c } }])
  return ref
}
const VP = { scrollX: 0, scrollY: 0, zoom: 1 }
const opts = () => ({ scene: { elements: [{ id: 'a' }] }, viewport: VP })

beforeEach(() => {
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  surface.handles = []
  surface.toSvg.mockReset().mockResolvedValue({ svg: 'SVG', x: 0, y: 0, width: 1, height: 1 })
  surface.mount.mockReset().mockImplementation((_el: HTMLElement, o: any) => {
    const live = { ...o }
    const handle = { update: vi.fn((p: any) => Object.assign(live, p)), getScene: () => live.scene, undo: vi.fn(), redo: vi.fn(), dispose: vi.fn(), live }
    surface.handles.push(handle)
    return handle
  })
})
afterEach(() => { for (const id of [...usePluginStore.getState().activeIds]) usePluginStore.getState().disable(id) })

describe('ctx.ui.mountBoard', () => {
  it('形状不对当场抛(插件好就地走自己的退路),一样东西都不挂', () => {
    const ui = context('shape').ui!
    const el = document.createElement('div')
    expect(() => ui.mountBoard!(null as any, opts())).toThrow(TypeError)
    expect(() => ui.mountBoard!(el, { viewport: VP } as any)).toThrow(/scene\.elements/)
    expect(() => ui.mountBoard!(el, { scene: { elements: [] }, viewport: { scrollX: 0, scrollY: 0, zoom: 0 } })).toThrow(/viewport/)
    expect(() => ui.mountBoard!(el, { scene: { elements: [] }, viewport: { scrollX: NaN, scrollY: 0, zoom: 1 } })).toThrow(/viewport/)
    expect(surface.mount).not.toHaveBeenCalled()
  })

  it('句柄同步可用:装载期间的 update 攒着,装好时一起带进去;之后的 update 直达', async () => {
    const h = context('pending').ui!.mountBoard!(document.createElement('div'), opts())
    expect(h.getScene().elements).toEqual([{ id: 'a' }])
    h.update({ tool: 'eraser', viewport: { scrollX: 9, scrollY: 9, zoom: 2 } })
    expect(() => h.update({ viewport: { scrollX: 0, scrollY: 0, zoom: -1 } })).toThrow(/viewport/)
    await vi.dynamicImportSettled()
    await vi.waitFor(() => expect(surface.mount).toHaveBeenCalledTimes(1))
    expect(surface.mount.mock.calls[0][1]).toMatchObject({ tool: 'eraser', viewport: { scrollX: 9, scrollY: 9, zoom: 2 } })
    h.update({ pen: 'fountain' })
    expect(surface.handles[0].update).toHaveBeenCalledWith({ pen: 'fountain' })
    h.undo(); h.redo()
    expect(surface.handles[0].undo).toHaveBeenCalledTimes(1)
    expect(surface.handles[0].redo).toHaveBeenCalledTimes(1)
  })

  it('装载还在路上就 dispose:不挂;dispose 之后 getScene 答最后的样子、update 无效', async () => {
    const h = context('early').ui!.mountBoard!(document.createElement('div'), opts())
    h.dispose()
    await vi.dynamicImportSettled()
    expect(surface.mount).not.toHaveBeenCalled()
    h.update({ scene: { elements: [] } })
    expect(h.getScene().elements).toEqual([{ id: 'a' }])
  })

  it('停用插件:活着的那一层被收掉,句柄留着最后的内容', async () => {
    const h = context('retired').ui!.mountBoard!(document.createElement('div'), opts())
    await vi.dynamicImportSettled()
    await vi.waitFor(() => expect(surface.mount).toHaveBeenCalledTimes(1))
    surface.handles[0].live.scene = { elements: [{ id: 'drawn' }] }
    usePluginStore.getState().disable('retired')
    expect(surface.handles[0].dispose).toHaveBeenCalledTimes(1)
    expect(h.getScene().elements).toEqual([{ id: 'drawn' }])
    h.update({ tool: 'eraser' })
    expect(surface.handles[0].update).not.toHaveBeenCalled()
  })
})

describe('ctx.ui.boardToSvg', () => {
  it('空内容直接给 null(不为它装引擎);形状不对抛;停用后给 null', async () => {
    const c = context('svg')
    await expect(c.ui!.boardToSvg!({ elements: [] })).resolves.toBeNull()
    expect(surface.toSvg).not.toHaveBeenCalled()
    await expect(c.ui!.boardToSvg!({} as any)).rejects.toThrow(TypeError)
    await expect(c.ui!.boardToSvg!({ elements: [{ id: 'a' }] }, { padding: 2 })).resolves.toMatchObject({ svg: 'SVG' })
    expect(surface.toSvg).toHaveBeenCalledWith({ elements: [{ id: 'a' }] }, { padding: 2 })
    usePluginStore.getState().disable('svg')
    await expect(c.ui!.boardToSvg!({ elements: [{ id: 'a' }] })).resolves.toBeNull()
  })
})
