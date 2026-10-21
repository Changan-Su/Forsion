import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimedHostView, isClaimingHostView, isCorePlugin, replacesNativeSpaceRecipe } from './corePlugins'

const home = { pluginId: 'forsion-home', item: { id: 'home' } }
const other = { pluginId: 'forsion-home', item: { id: 'settings' } }
const state = (plugin: { id: string; builtin?: boolean; preinstalled?: boolean }) => ({ views: [other, home], plugins: [plugin] })
const trial = (value: string | null) => vi.stubGlobal('localStorage', { getItem: () => value })

afterEach(() => { vi.unstubAllGlobals() })

describe('宿主视图芯(主页插件化 S1)', () => {
  it('只是 id 对上不够:商店里同 id 的插件接管不了主页', () => {
    trial(null)
    expect(claimedHostView(state({ id: 'forsion-home' }), 'homepage')).toBeUndefined()
  })

  it('开发 / 台架档:forsion.dev.coreTrial 写着它的 id 才接管,而且只接管表里那个视图', () => {
    trial('forsion-calendar, forsion-home')
    const s = state({ id: 'forsion-home' })
    expect(claimedHostView(s, 'homepage')).toBe(home)
    expect(isClaimingHostView(s, home)).toBe(true)
    expect(isClaimingHostView(s, other)).toBe(false)
    expect(claimedHostView(s, 'calendar')).toBeUndefined()
  })

  it('读不到 localStorage(node / 被禁)= 不接管,不抛', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') } })
    expect(claimedHostView(state({ id: 'forsion-home' }), 'homepage')).toBeUndefined()
  })

  it('插件没注册那个视图(关着 / 还没装载完)= 用内置那份', () => {
    trial('forsion-home')
    expect(claimedHostView({ views: [other], plugins: [{ id: 'forsion-home' }] }, 'homepage')).toBeUndefined()
  })

  it('Calendar core renderer retains native views and skips only its redundant recipe', () => {
    trial(null)
    const view = { pluginId: 'forsion-calendar', item: { id: 'calendar' } }
    const s = { views: [view], plugins: [{ id: 'forsion-calendar', preinstalled: true }] }
    expect(isCorePlugin(s.plugins[0])).toBe(true)
    expect(claimedHostView(s, 'calendar')).toBe(view)
    expect(isClaimingHostView(s, view)).toBe(false) // aliases keep saved layouts usable
    expect(replacesNativeSpaceRecipe(s, 'forsion-calendar', 'calendar')).toBe(true)
    expect(replacesNativeSpaceRecipe(s, 'forsion-calendar', 'todo')).toBe(false)
    expect(replacesNativeSpaceRecipe({ ...s, plugins: [{ id: 'forsion-calendar' }] }, 'forsion-calendar', 'calendar')).toBe(false)
  })
})
