import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetClientSurfacesForTest, collectClientCapabilities, getClientSurface, listClientSurfaces,
  notifyClientSurfaces, registerClientSurface, type ClientSurface,
} from './clientSurfaces'

const surface = (caps: () => string[], extra: Partial<ClientSurface> = {}): ClientSurface => ({ capabilities: caps, exec: vi.fn(), ...extra })

afterEach(() => __resetClientSurfacesForTest())

describe('clientSurfaces 注册表', () => {
  it('没有注册任何面(desktop/web)时能力为空数组', () => {
    expect(collectClientCapabilities()).toEqual([])
    expect(listClientSurfaces()).toEqual([])
    expect(getClientSurface('phone')).toBeUndefined()
  })

  it('能力取所有面的并集:去重、排序、丢掉非字符串与空串', () => {
    registerClientSurface('phone', surface(() => ['phone.ui', 'phone.intents', 'phone.intents']))
    registerClientSurface('watch', surface(() => ['watch.tap', '', 42 as unknown as string, 'phone.ui']))
    expect(collectClientCapabilities()).toEqual(['phone.intents', 'phone.ui', 'watch.tap'])
  })

  it('一个面的 capabilities 抛错不连累别的面', () => {
    registerClientSurface('bad', surface(() => { throw new Error('native gone') }))
    registerClientSurface('phone', surface(() => ['phone.intents']))
    expect(collectClientCapabilities()).toEqual(['phone.intents'])
  })

  it('注销后不再声明、也查不到;同 ns 重复注册 = 后者覆盖', () => {
    const a = surface(() => ['phone.intents'])
    const b = surface(() => ['phone.ui'])
    const offA = registerClientSurface('phone', a)
    const offB = registerClientSurface('phone', b)
    expect(getClientSurface('phone')).toBe(b)
    expect(collectClientCapabilities()).toEqual(['phone.ui'])
    // 旧注册的注销函数(HMR 残留)不许把新注册摘掉
    offA()
    expect(getClientSurface('phone')).toBe(b)
    offB()
    expect(getClientSurface('phone')).toBeUndefined()
    expect(collectClientCapabilities()).toEqual([])
  })

  it('runEnd / reset 广播到每个面,单个面抛错不连累别的面', () => {
    const endA = vi.fn(() => { throw new Error('boom') })
    const resetA = vi.fn(() => { throw new Error('boom') })
    const endB = vi.fn()
    const resetB = vi.fn()
    registerClientSurface('a', surface(() => [], { onRunEnd: endA, onReset: resetA }))
    registerClientSurface('b', surface(() => [], { onRunEnd: endB, onReset: resetB }))
    registerClientSurface('c', surface(() => [])) // 两个钩子都可选

    notifyClientSurfaces('runEnd', 'r1')
    expect(endA).toHaveBeenCalledWith('r1')
    expect(endB).toHaveBeenCalledWith('r1')
    expect(resetB).not.toHaveBeenCalled()

    notifyClientSurfaces('reset')
    expect(resetA).toHaveBeenCalledOnce()
    expect(resetB).toHaveBeenCalledOnce()
    expect(endB).toHaveBeenCalledOnce()
  })

  it('listClientSurfaces 带出 SettingsRow 供设置页数据驱动渲染', () => {
    const Row = () => null
    registerClientSurface('phone', surface(() => [], { SettingsRow: Row }))
    registerClientSurface('headless', surface(() => []))
    expect(listClientSurfaces().filter((s) => s.surface.SettingsRow).map((s) => s.ns)).toEqual(['phone'])
  })
})
