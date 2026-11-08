// @vitest-environment happy-dom
// LCL 表面规范第三期:插件的三个旧入口(openView / openMiniPanel / openFloatingPanel)内部转到 workspace.open,
// 参数照旧;新入口 ctx.workspace.open 只开自己的视图、形状不对同步抛、浮在窗口里的卡随插件停用收掉。
// 规则本身(回落、复用、反注册收卡)在 frontend/src/workspaceOpen.test.ts。
// 负对照(11-08 已实跑红):workspace.open 里不 scope.own →「浮在窗口里的卡:插件停用时宿主收掉」红;openMiniPanel 无条件传
// mainView →「声明了 forms 又没点名主视图 = 按 forms 挑」红;没声明 forms 时不传 mainView →「没声明 forms 的视图:mainView
// = 它自己」红(Codex 评审 P1:会被某个 Space 的 Mini 映射改道、实体键变了);每次都 scope.own →「同一张卡再开只记一笔账」红;
// pin 没给填成 false →「desktop 的 pin 只认布尔」红(真 Electron 台架 ⑦ 抓到的:插件开的 Mini 缺省成了不置顶)。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn()
vi.mock('../../workspaceOpenHost', () => ({ hostWorkspaceOpen: (...a: unknown[]) => open(...a) }))

const { usePluginStore, pluginFootprint } = await import('./pluginStore')
type Ctx = import('./types').PluginContext

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, views: [] })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => {
    ref = c
    c.registerView({ id: 'v', title: 'Tasks', mount() {} })
    c.registerView({ id: 'full', title: 'Full', mount() {} })
    c.registerView({ id: 'board', title: 'Board', mount() {}, forms: { main: true, mini: { view: 'v' } } })
  } }])
  return ref!
}

beforeEach(() => {
  localStorage.clear()
  open.mockReset()
  open.mockResolvedValue({ ok: true, layer: { dock: 'main' }, form: 'main' })
  ;(window as unknown as { tangu?: unknown }).tangu = { openMini: vi.fn(), openFloatingPanel: vi.fn() }
  usePluginStore.getState().setViewOpener(() => {}, ['main', 'left', 'right', 'bottom'])
})

describe('old entry points forward to workspace.open', () => {
  it('openView 照旧经宿主的打开器(壳层的打开器再转 workspace.open,见 workspaceOpenHost.test);没有工作台的宿主照旧 no-op', () => {
    const opener = vi.fn()
    usePluginStore.getState().setViewOpener(opener, ['main', 'right'])
    const ctx = ctxOf('p')
    ctx.openView('v', { location: 'right', params: { a: 1 } })
    expect(opener).toHaveBeenLastCalledWith('plugin:p:v', 'right', { a: 1 })
    usePluginStore.getState().setViewOpener(null)
    ctx.openView('v')
    expect(opener).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })
  it('openMiniPanel → { float: desktop } + mini,key 去空白;没声明 forms 的视图:mainView = 它自己(2.13.7 的实体键不变)', () => {
    const ctx = ctxOf('p')
    ctx.openMiniPanel!('v', { key: ' k1 ', params: { day: 3 } })
    expect(open).toHaveBeenLastCalledWith({ type: 'plugin:p:v', params: { day: 3 } },
      { layer: { float: 'desktop' }, form: 'mini', key: 'k1', title: 'Tasks', mainView: { type: 'plugin:p:v', params: undefined } })
  })
  it('openMiniPanel:声明了 forms 又没点名主视图 = 按 forms 挑(不传 mainView)', () => {
    const ctx = ctxOf('p')
    ctx.openMiniPanel!('board')
    expect(open).toHaveBeenLastCalledWith({ type: 'plugin:p:board', params: undefined },
      { layer: { float: 'desktop' }, form: 'mini', key: undefined, title: 'Board', mainView: undefined })
  })
  it('openMiniPanel 点名了 mainViewId:viewId 就是紧凑视图,原样(旧写法)', () => {
    const ctx = ctxOf('p')
    ctx.openMiniPanel!('v', { mainViewId: 'full', mainViewParams: { tab: 1 }, title: 'Mine' })
    expect(open).toHaveBeenLastCalledWith({ type: 'plugin:p:v', params: undefined },
      { layer: { float: 'desktop' }, form: 'mini', key: undefined, title: 'Mine', mainView: { type: 'plugin:p:full', params: { tab: 1 } } })
  })
  it('openFloatingPanel → { float: desktop } + main,带尺寸;不是自己的视图不开', () => {
    const ctx = ctxOf('p')
    ctx.openFloatingPanel!('v', { width: 500, params: { q: 'x' } })
    expect(open).toHaveBeenLastCalledWith({ type: 'plugin:p:v', params: { q: 'x' } },
      { layer: { float: 'desktop' }, form: 'main', title: 'Tasks', size: { width: 500, height: undefined, minWidth: undefined, minHeight: undefined } })
    open.mockClear()
    ctx.openFloatingPanel!('nope')
    expect(open).not.toHaveBeenCalled()
  })
})

describe('ctx.workspace.open', () => {
  it('只开自己的视图;字符串或 { view, params } 都行;layer 原样转', async () => {
    const ctx = ctxOf('p')
    await ctx.workspace!.open('v', { layer: { float: 'desktop', pin: true }, form: 'main' })
    expect(open).toHaveBeenLastCalledWith({ type: 'plugin:p:v', params: undefined }, { layer: { float: 'desktop', pin: true }, form: 'main', key: undefined, title: undefined })
    await ctx.workspace!.open({ view: 'v', params: { a: 1 } }, { layer: { float: 'space', anchor: 'top-end' }, key: 'x' })
    expect(open).toHaveBeenLastCalledWith({ type: 'plugin:p:v', params: { a: 1 } }, { layer: { float: 'space', anchor: 'top-end' }, form: undefined, key: 'x', title: undefined })
  })
  it('desktop 的 pin 只认布尔、没给就不带(Mini 缺省置顶):不能替插件填成 false', async () => {
    const ctx = ctxOf('p')
    await ctx.workspace!.open('v', { layer: { float: 'desktop' } })
    expect((open.mock.calls.at(-1)![1] as { layer: object }).layer).toEqual({ float: 'desktop' })
    await ctx.workspace!.open('v', { layer: { float: 'desktop', pin: false } })
    expect((open.mock.calls.at(-1)![1] as { layer: object }).layer).toEqual({ float: 'desktop', pin: false })
    await ctx.workspace!.open('v', { layer: { float: 'desktop', pin: 'yes' } as never })
    expect((open.mock.calls.at(-1)![1] as { layer: object }).layer).toEqual({ float: 'desktop' })
  })
  it('形状不对同步抛', () => {
    const ctx = ctxOf('p')
    expect(() => ctx.workspace!.open('' as never)).toThrow(TypeError)
    expect(() => ctx.workspace!.open('v', { layer: { float: 'screen' } as never })).toThrow(TypeError)
    expect(() => ctx.workspace!.open('v', { layer: 'right' as never })).toThrow(TypeError)
  })
  it('没有工作台的宿主 = unavailable;失败原样回(limit 带上上限)', async () => {
    const ctx = ctxOf('p')
    open.mockResolvedValueOnce({ ok: false, reason: 'limit', limit: 6 })
    expect(await ctx.workspace!.open('v', { layer: { float: 'desktop' } })).toEqual({ ok: false, reason: 'limit', limit: 6 })
    usePluginStore.getState().setViewOpener(null)
    expect(await ctx.workspace!.open('v')).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('浮在窗口里的卡:插件停用时宿主收掉;停用后再调 close 不再动', async () => {
    const ctx = ctxOf('p')
    const close = vi.fn()
    open.mockResolvedValueOnce({ ok: true, layer: { float: 'space' }, form: 'mini', close })
    const r = await ctx.workspace!.open('v', { layer: { float: 'space' } })
    expect(r).toMatchObject({ ok: true, layer: { float: 'space' }, form: 'mini' })
    usePluginStore.getState().disable('p')
    expect(close).toHaveBeenCalledTimes(1)
    if (r.ok) r.close?.()
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('同一张卡再开只记一笔账;卡自己收掉(点了关闭)就划掉', async () => {
    const ctx = ctxOf('p')
    const close = vi.fn()
    let done!: () => void
    const closed = new Promise<void>((r) => { done = r })
    open.mockResolvedValue({ ok: true, layer: { float: 'space' }, form: 'mini', close, closed })
    const before = pluginFootprint('p').effects.length
    for (let i = 0; i < 5; i++) await ctx.workspace!.open('v', { layer: { float: 'space' } })
    expect(pluginFootprint('p').effects.length).toBe(before + 1)
    done()
    await closed
    await Promise.resolve()
    expect(pluginFootprint('p').effects.length).toBe(before)
    usePluginStore.getState().disable('p')
    expect(close).not.toHaveBeenCalled()
  })
  it('停用之后的 ctx:resolve disabled,不开', async () => {
    const ctx = ctxOf('p')
    usePluginStore.getState().disable('p')
    expect(await ctx.workspace!.open('v')).toEqual({ ok: false, reason: 'disabled' })
    expect(open).not.toHaveBeenCalled()
  })
})
