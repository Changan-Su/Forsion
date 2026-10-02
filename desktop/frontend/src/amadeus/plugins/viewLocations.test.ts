// ctx.openView 的停靠位 + ctx.viewLocations(2026-10-02):桌面壳注入的打开器决定插件的视图能停在哪,
// 插件据 viewLocations feature-detect —— 旧桌面宿主把未知位置当主区开,会把当前主视图导航走。
// 负对照(已实跑红):去掉 ctx 上的 viewLocations getter → ②③④红;setViewOpener 不记 locations → ②④红;
// ctx.replaceView 不加命名空间 → ⑤红。
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ amadeus: undefined }))

const { usePluginStore } = await import('./pluginStore')
type Ctx = import('./types').PluginContext

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!
}

describe('ctx.viewLocations / openView 停靠位', () => {
  it('① 没有工作台(无打开器)→ undefined,openView 是 no-op', () => {
    usePluginStore.getState().setViewOpener(null)
    const ctx = ctxOf('p-none')
    expect(ctx.viewLocations).toBeUndefined()
    expect(() => ctx.openView('x', { location: 'bottom' })).not.toThrow()
  })

  it('② 桌面壳声明的停靠位原样给插件;openView 加命名空间、bottom 透传给打开器', () => {
    const calls: unknown[][] = []
    usePluginStore.getState().setViewOpener((type, loc) => { calls.push([type, loc]) }, ['main', 'left', 'right', 'bottom'])
    const ctx = ctxOf('p-desk')
    expect(ctx.viewLocations).toEqual(['main', 'left', 'right', 'bottom'])
    ctx.openView('timeline', { location: 'bottom' })
    expect(calls).toEqual([['plugin:p-desk:timeline', 'bottom']])
  })

  it('③ 打开器没声明停靠位(旧壳)→ 只宣称 main/left/right,插件就不会去要 bottom', () => {
    usePluginStore.getState().setViewOpener(() => {})
    expect(ctxOf('p-old').viewLocations).toEqual(['main', 'left', 'right'])
  })

  it('④ 跟随后来接线的打开器(插件 setup 早于桌面壳接线也拿得到)', () => {
    usePluginStore.getState().setViewOpener(null)
    const ctx = ctxOf('p-late')
    usePluginStore.getState().setViewOpener(() => {}, ['main', 'bottom'])
    expect(ctx.viewLocations).toEqual(['main', 'bottom'])
  })

  it('⑤ closeView / replaceView 只碰自己的视图:宿主拿到的是加了命名空间的类型名,返回值原样给插件', () => {
    const calls: unknown[][] = []
    usePluginStore.getState().setViewControls({
      close: (type) => { calls.push(['close', type]) },
      replace: (from, to, params) => { calls.push(['replace', from, to, params]); return 2 },
    })
    const ctx = ctxOf('p-swap')
    ctx.closeView?.('timeline')
    expect(ctx.replaceView?.('nav', 'media', { params: { a: 1 } })).toBe(2)
    expect(calls).toEqual([['close', 'plugin:p-swap:timeline'], ['replace', 'plugin:p-swap:nav', 'plugin:p-swap:media', { a: 1 }]])
  })

  it('⑥ 没有工作台(没注入)→ closeView 是 no-op,replaceView 返回 0(插件据此不去 openView 之外的事)', () => {
    usePluginStore.getState().setViewControls(null)
    const ctx = ctxOf('p-bare')
    expect(() => ctx.closeView?.('x')).not.toThrow()
    expect(ctx.replaceView?.('a', 'b')).toBe(0)
  })
})

