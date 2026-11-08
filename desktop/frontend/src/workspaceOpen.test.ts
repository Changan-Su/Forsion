// @vitest-environment happy-dom
/** workspace.open(LCL 表面规范第三期,lcl/engine/workspaceOpen.ts):映射与回落规则(planOpen,纯函数)、桌面接缝、
 *  浮层里挂 View 的复用与收起。放在 desktop 下:lcl/ 里的测试不能用 happy-dom 文档块(见 lcl/engine/nativeSheet.test.ts 头注)。
 *  负对照(11-08 已实跑红):主区梯子去掉 'right' →「位置的样子不支持 → 按梯子换位置」红;watchUnregister 不装 →
 *  「视图反注册(插件停用)→ 挂着它的浮层收掉」红;compactOf 不看 forms.mini → 三条红(只有 Mini 的停靠 / 桌面 Mini 的紧凑视图 / 反注册)。
 *  Codex 评审(11-08)那一轮的负对照(已实跑红):不比主人 →「紧凑视图只认同一个主人」红;身份按紧凑视图算 →「两个视图共用紧凑视图」红;
 *  换样子原地复用 →「换了样子 = 换一张卡」红;只看紧凑视图反注册 →「主视图反注册也收」红;停靠回落不看 mini 支持 →
 *  「一个样子都不支持 = unsupported」红;async 校验 →「参数不对同步抛」红;只看 UI_MODE →「原生手机」红;showInMain 不 setParams →「在主面板显示」红。
 *  Space 布局那一轮(11-08 已实跑红):collect 不带挂起的 →「读不到 ≠ 没有」红;还原不 move 到布局锚点 →「锚点以布局为准」红;
 *  锚点 id 不带 Space →「各记各的」红;不查能否序列化 →「循环引用」红;noteFloatParams 不改 rec.view →「开着的卡记进」红;
 *  clear 不清挂起 →「恢复默认布局」红;Mini 的 pin 恒 true →「Mini 缺省置顶」两条红;
 *  别的 Space 的卡变了也只存屏上这份(Codex 第二轮 P2)→「藏着的 Space」红。 */
import * as React from 'react'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FloatViews } from '@lcl/engine/FloatViews'
import { checkOpenOptions, dockFallback, floatViewsSnapshot, noteFloatParams, planOpen, registerFloatViewRenderer, resetWorkspaceOpenForTest, setDesktopOpener, workspaceOpen, type OpenEnv } from '@lcl/engine/workspaceOpen'
import { floatPersistence, setFloatLayoutHost } from '@lcl/engine/floatPersistSeam'
import { liveLayoutOwner, scheduleWorkspaceSave } from '@lcl/engine/dockviewStore'
import { loadNamedLayout, saveNamedLayout, type PersistedFloat } from '@lcl/engine/layoutPersist'
import { registerView, unregisterView } from '@lcl/engine/viewRegistry'
import { resetFloatsForTest } from '@lcl/engine/floatLayer'
import { useSpaceStore } from '@lcl/engine/spaceRegistry'
import { useWorkspace } from '@lcl/engine/workspaceStore'
import type { ViewForms } from '@lcl/engine/types'

const env = (defs: Record<string, ViewForms | undefined | null>, over: Partial<OpenEnv> = {}): OpenEnv => ({
  getDef: (type) => (type in defs ? { forms: defs[type] ?? undefined } : undefined),
  spaceMiniOf: () => null,
  desktopMini: true, desktopPanel: true, bottom: true, floats: true, mobile: false,
  ...over,
})

describe('planOpen · dock', () => {
  it('没声明 forms:开在要的位置,样子由位置定(左右 = side)', () => {
    const e = env({ v: undefined })
    expect(planOpen({ type: 'v' }, {}, e)).toEqual({ kind: 'dock', loc: 'main', form: 'main' })
    expect(planOpen({ type: 'v' }, { layer: { dock: 'left' } }, e)).toEqual({ kind: 'dock', loc: 'left', form: 'side' })
    expect(planOpen({ type: 'v' }, { layer: { dock: 'bottom' } }, e)).toEqual({ kind: 'dock', loc: 'bottom', form: 'bottom' })
    expect(planOpen({ type: 'v' }, { layer: { dock: 'right' }, form: 'mini' }, e)).toEqual({ kind: 'dock', loc: 'right', form: 'side' }) // 停靠时 form 不看
  })
  it('这扇窗没有底部面板:底部当右栏(同 2.13.7)', () => {
    expect(planOpen({ type: 'v' }, { layer: { dock: 'bottom' } }, env({ v: undefined }, { bottom: false }))).toEqual({ kind: 'dock', loc: 'right', form: 'side' })
  })
  it('位置的样子不支持 → 按梯子换位置', () => {
    expect(dockFallback({ side: true }, 'main', true)).toBe('right')
    expect(dockFallback({ main: true }, 'left', true)).toBe('main')
    expect(dockFallback({ main: true }, 'bottom', true)).toBe('main')
    expect(dockFallback({ bottom: true }, 'right', true)).toBe('bottom')
    expect(dockFallback({ bottom: true }, 'right', false)).toBeNull() // 没有底部面板,底部当右栏,还是 side → 不行
    expect(dockFallback({ side: true, bottom: true }, 'bottom', false)).toBe('right')
  })
  it('只有 Mini 样子的视图停靠:开成当前 Space 的浮层;没有浮层宿主 = unavailable', () => {
    const forms = { mini: { view: { type: 'v.mini' } } }
    expect(planOpen({ type: 'v' }, { layer: { dock: 'main' } }, env({ v: forms, 'v.mini': undefined })))
      .toMatchObject({ kind: 'float', scope: 'space', form: 'mini', view: { type: 'v.mini' }, mainView: { type: 'v' } })
    expect(planOpen({ type: 'v' }, {}, env({ v: forms }, { floats: false }))).toEqual({ kind: 'none', reason: 'unavailable' })
  })
  it('一个样子都不支持(forms 是空的;只有底部又没有底部面板)= unsupported,不偷偷开成 Mini', () => {
    expect(planOpen({ type: 'v' }, {}, env({ v: {} }))).toEqual({ kind: 'none', reason: 'unsupported' })
    expect(planOpen({ type: 'v' }, { layer: { dock: 'bottom' } }, env({ v: { bottom: true } }, { bottom: false }))).toEqual({ kind: 'none', reason: 'unsupported' })
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' }, form: 'main' }, env({ v: {} }, { desktopPanel: false }))).toEqual({ kind: 'none', reason: 'unsupported' })
  })
  it('没注册的视图 = unknown-view', () => {
    expect(planOpen({ type: 'nope' }, {}, env({}))).toEqual({ kind: 'none', reason: 'unknown-view' })
  })
})

describe('planOpen · float desktop', () => {
  it('mini = 桌面 Mini:Mini 显示声明的紧凑视图(参数带过去),在主面板显示回到视图本身', () => {
    const p = planOpen({ type: 'v', params: { id: 1 } }, { layer: { float: 'desktop' }, form: 'mini' },
      env({ v: { main: true, mini: { view: { type: 'v.mini', params: { compact: true } } } }, 'v.mini': undefined }))
    expect(p).toEqual({ kind: 'mini', view: { type: 'v.mini', params: { compact: true, id: 1 } }, mainView: { type: 'v', params: { id: 1 } }, pin: true })
  })
  it('form 缺省就是 mini;没声明 forms = Mini 里显示视图本身(同 openMiniPanel)', () => {
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' } }, env({ v: undefined }))).toEqual({ kind: 'mini', view: { type: 'v', params: undefined }, mainView: { type: 'v', params: undefined }, pin: true })
  })
  it('Mini 缺省置顶;pin:false 不置顶(§7「桌面不等于置顶」:和 Floating Panel 的缺省相反)', () => {
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop', pin: false } }, env({ v: undefined }))).toMatchObject({ kind: 'mini', pin: false })
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop', pin: true } }, env({ v: undefined }))).toMatchObject({ kind: 'mini', pin: true })
  })
  it('某个 Space 的 mini 以它为主视图:走那个 Space(实体键 space:<id>,和 ⌘⇧M 开的是同一扇)', () => {
    const p = planOpen({ type: 'todo-list' }, { layer: { float: 'desktop' }, form: 'mini' },
      env({ 'todo-list': undefined }, { spaceMiniOf: (t) => (t === 'todo-list' ? { spaceId: 'calendar', view: { type: 'mini-todo' } } : null) }))
    expect(p).toMatchObject({ kind: 'mini', spaceId: 'calendar', view: { type: 'mini-todo' }, mainView: { type: 'todo-list' } })
  })
  it('紧凑视图只认同一个主人:插件 P 的视图不落到插件 Q 的紧凑视图上(Space 映射、forms.mini 都一样)', () => {
    const spaceMiniOf = (t: string) => (t === 'plugin:p:v' ? { spaceId: 's', view: { type: 'plugin:q:c' } } : null)
    expect(planOpen({ type: 'plugin:p:v' }, { layer: { float: 'desktop' } }, env({ 'plugin:p:v': undefined, 'plugin:q:c': undefined }, { spaceMiniOf })))
      .toEqual({ kind: 'mini', view: { type: 'plugin:p:v', params: undefined }, mainView: { type: 'plugin:p:v', params: undefined }, pin: true })
    expect(planOpen({ type: 'plugin:p:v' }, { layer: { float: 'desktop' } }, env({ 'plugin:p:v': { main: true, mini: { view: { type: 'plugin:q:c' } } }, 'plugin:q:c': undefined })))
      .toMatchObject({ kind: 'mini', view: { type: 'plugin:p:v' } })
    expect(planOpen({ type: 'plugin:p:v' }, { layer: { float: 'desktop' } }, env({ 'plugin:p:v': { main: true, mini: { view: { type: 'plugin:p:c' } } }, 'plugin:p:c': undefined })))
      .toMatchObject({ kind: 'mini', view: { type: 'plugin:p:c' } })
  })
  it('调用方点名了主视图(旧 openMiniPanel 的 mainViewId):target 就是紧凑视图,不按 forms 换', () => {
    const p = planOpen({ type: 'v.mini' }, { layer: { float: 'desktop' }, form: 'mini', mainView: { type: 'v' } }, env({ 'v.mini': { side: true } }))
    expect(p).toEqual({ kind: 'mini', view: { type: 'v.mini', params: undefined }, mainView: { type: 'v' }, pin: true })
  })
  it('main = Floating Panel,缺省不置顶;pin:true 置顶', () => {
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' }, form: 'main' }, env({ v: undefined }))).toEqual({ kind: 'panel', pin: false })
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop', pin: true }, form: 'main' }, env({ v: undefined }))).toEqual({ kind: 'panel', pin: true })
  })
  it('样子不支持就换另一种:mini 不支持 → Floating Panel;视图本身不支持 → Mini', () => {
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' }, form: 'mini' }, env({ v: { main: true } }))).toEqual({ kind: 'panel', pin: false })
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' }, form: 'main' }, env({ v: { mini: true } }))).toMatchObject({ kind: 'mini' })
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' }, form: 'main' }, env({ v: {} }))).toEqual({ kind: 'none', reason: 'unsupported' })
  })
  it('网页 / 手机没有桌面 Mini:降成窗口作用域(手机上 = 半屏抽屉)', () => {
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' }, form: 'mini' }, env({ v: undefined }, { desktopMini: false })))
      .toMatchObject({ kind: 'float', scope: 'window', form: 'mini', sheet: false })
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' }, form: 'mini' }, env({ v: undefined }, { desktopMini: false, mobile: true })))
      .toMatchObject({ kind: 'float', scope: 'window', form: 'mini', sheet: true })
  })
  it('手机没有 Floating Panel:main 停靠主区', () => {
    expect(planOpen({ type: 'v' }, { layer: { float: 'desktop' }, form: 'main' }, env({ v: undefined }, { desktopMini: false, desktopPanel: false, mobile: true })))
      .toEqual({ kind: 'dock', loc: 'main', form: 'main' })
  })
})

describe('planOpen · float view / space / window', () => {
  it('缺省 mini;side / bottom 当 main(浮着的面板没有边)', () => {
    const e = env({ v: undefined })
    expect(planOpen({ type: 'v' }, { layer: { float: 'space' } }, e)).toMatchObject({ kind: 'float', scope: 'space', form: 'mini' })
    expect(planOpen({ type: 'v' }, { layer: { float: 'window' }, form: 'side' }, e)).toMatchObject({ kind: 'float', scope: 'window', form: 'main', view: { type: 'v' } })
  })
  it('手机:Space / 窗口作用域的 Mini 是半屏抽屉,View 作用域不是', () => {
    const e = env({ v: undefined }, { mobile: true })
    expect(planOpen({ type: 'v' }, { layer: { float: 'space' } }, e)).toMatchObject({ sheet: true })
    expect(planOpen({ type: 'v' }, { layer: { float: 'view', host: {} as HTMLElement } }, e)).toMatchObject({ sheet: false })
    expect(planOpen({ type: 'v' }, { layer: { float: 'space' }, form: 'main' }, e)).toMatchObject({ sheet: false })
  })
  it('没挂浮层宿主的窗口(Mini、Floating Panel)= unavailable', () => {
    expect(planOpen({ type: 'v' }, { layer: { float: 'window' } }, env({ v: undefined }, { floats: false }))).toEqual({ kind: 'none', reason: 'unavailable' })
  })
})

describe('checkOpenOptions', () => {
  it('形状不对同步抛', () => {
    expect(() => checkOpenOptions({ layer: { dock: 'top' as never } })).toThrow(TypeError)
    expect(() => checkOpenOptions({ layer: { float: 'screen' as never } })).toThrow(TypeError)
    expect(() => checkOpenOptions({ form: 'tiny' as never })).toThrow(TypeError)
    expect(() => checkOpenOptions({ layer: { float: 'space', anchor: 'middle' as never } })).toThrow(/anchor/)
    expect(() => checkOpenOptions({ layer: { float: 'view' } })).toThrow(/host/)
    expect(() => checkOpenOptions({ layer: { float: 'desktop', pin: true }, form: 'main' })).not.toThrow()
  })
})

describe('workspaceOpen', () => {
  const factory = () => null
  beforeEach(() => {
    resetWorkspaceOpenForTest()
    resetFloatsForTest()
    document.body.innerHTML = ''
    localStorage.clear()
    useSpaceStore.setState({ activeSpaceId: 'cloud' })
    registerView({ type: 'v', displayName: 'V', factory })
  })
  const ws0 = useWorkspace.getState()
  afterEach(() => { resetWorkspaceOpenForTest(); resetFloatsForTest(); unregisterView('v'); unregisterView('v.mini'); unregisterView('w'); useWorkspace.setState(ws0, true) })

  it('参数不对同步抛(不是 reject)', () => {
    expect(() => workspaceOpen({ type: 'v' }, { form: 'tiny' } as never)).toThrow(TypeError)
    expect(() => workspaceOpen({ type: '' })).toThrow(TypeError)
  })

  it('停靠 = openView(主区带上开法),回 leaf 和 close', async () => {
    const leaf = { id: 'l1', type: 'v', loc: 'right', params: {}, setTitle() {}, setParams() {}, close: vi.fn() }
    const openView = vi.fn(() => leaf)
    useWorkspace.setState({ openView } as never)
    const r = await workspaceOpen({ type: 'v', params: { a: 1 } }, { layer: { dock: 'right' } })
    expect(openView).toHaveBeenCalledWith('v', { a: 1 }, 'right', undefined)
    expect(r).toMatchObject({ ok: true, layer: { dock: 'right' }, form: 'side', leaf })
    if (r.ok) r.close?.()
    expect(leaf.close).toHaveBeenCalled()
    await workspaceOpen({ type: 'v' }, { dock: { newTab: true } })
    expect(openView).toHaveBeenLastCalledWith('v', {}, 'main', { newTab: true })
  })

  it('桌面:Mini 满了回 limit;Floating Panel 带上标题、置顶、key', async () => {
    const mini = vi.fn(async () => ({ ok: false as const, reason: 'limit' as const, limit: 6 }))
    const panel = vi.fn()
    setDesktopOpener({ mini, panel })
    expect(await workspaceOpen({ type: 'v', params: { a: 1 } }, { layer: { float: 'desktop' }, form: 'mini', key: 'k' })).toEqual({ ok: false, reason: 'limit', limit: 6 })
    expect(mini).toHaveBeenCalledWith({ view: { type: 'v', params: { a: 1 } }, mainView: { type: 'v', params: { a: 1 } }, spaceId: undefined, params: { a: 1 }, key: 'k', title: 'V' })
    await workspaceOpen({ type: 'v' }, { layer: { float: 'desktop', pin: false }, form: 'mini' })
    expect(mini).toHaveBeenLastCalledWith(expect.objectContaining({ pin: false }))
    expect(await workspaceOpen({ type: 'v' }, { layer: { float: 'desktop', pin: true }, form: 'main', key: 'k' })).toEqual({ ok: true, layer: { float: 'desktop' }, form: 'main' })
    expect(panel).toHaveBeenCalledWith({ view: { type: 'v', params: undefined }, title: 'V', pin: true, key: 'k', size: undefined })
  })

  it('浮层:同一份再开 = 同一张卡(换参数、轻跳);别的 key 另开一张', async () => {
    registerFloatViewRenderer()
    const a = await workspaceOpen({ type: 'v', params: { n: 1 } }, { layer: { float: 'window' } })
    expect(a).toMatchObject({ ok: true, layer: { float: 'window' }, form: 'mini' })
    const [rec] = floatViewsSnapshot()
    expect(rec.handle.el.dataset.viewFloat).toBe('mini')
    expect(rec.handle.el.closest('[data-scope="window"]')).not.toBeNull()
    await workspaceOpen({ type: 'v', params: { n: 2 } }, { layer: { float: 'window' } })
    expect(floatViewsSnapshot()).toHaveLength(1)
    expect(floatViewsSnapshot()[0]).toBe(rec)
    expect(rec).toMatchObject({ gen: 1, nudge: 1, view: { params: { n: 2 } } })
    await workspaceOpen({ type: 'v' }, { layer: { float: 'window' }, key: 'other' })
    expect(floatViewsSnapshot()).toHaveLength(2)
    if (a.ok) a.close?.()
    expect(rec.handle.closed).toBe(true)
    expect(floatViewsSnapshot()).toHaveLength(1)
  })

  it('Space 作用域按当前 Space 记身份:切走就藏;别的 Space 里再开是另一张', async () => {
    registerFloatViewRenderer()
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space' } })
    const [rec] = floatViewsSnapshot()
    useSpaceStore.setState({ activeSpaceId: 'chat' })
    expect(rec.handle.el.hidden).toBe(true)
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space' } })
    expect(floatViewsSnapshot()).toHaveLength(2)
  })

  it('视图反注册(插件停用)→ 挂着它的浮层收掉', async () => {
    registerFloatViewRenderer()
    registerView({ type: 'v.mini', displayName: 'V mini', factory })
    registerView({ type: 'v', displayName: 'V', factory, forms: { main: true, mini: { view: { type: 'v.mini' } } } })
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space' } })
    const [rec] = floatViewsSnapshot()
    expect(rec.view.type).toBe('v.mini')
    unregisterView('v.mini')
    expect(rec.handle.closed).toBe(true)
    expect(floatViewsSnapshot()).toHaveLength(0)
  })

  it('两个视图共用紧凑视图:各是各的卡,A 的 close 不收 B', async () => {
    registerFloatViewRenderer()
    registerView({ type: 'v.mini', displayName: 'V mini', factory })
    registerView({ type: 'v', displayName: 'V', factory, forms: { main: true, mini: { view: { type: 'v.mini' } } } })
    registerView({ type: 'w', displayName: 'W', factory, forms: { main: true, mini: { view: { type: 'v.mini' } } } })
    const a = await workspaceOpen({ type: 'v', params: { a: 1 } }, { layer: { float: 'window' } })
    const b = await workspaceOpen({ type: 'w', params: { b: 1 } }, { layer: { float: 'window' } })
    expect(floatViewsSnapshot()).toHaveLength(2)
    expect(floatViewsSnapshot().map((r) => r.mainView.type)).toEqual(['v', 'w'])
    if (a.ok) a.close?.()
    expect(floatViewsSnapshot()).toHaveLength(1)
    expect(floatViewsSnapshot()[0].mainView.type).toBe('w')
    expect(b.ok && b.closed).toBeInstanceOf(Promise)
  })

  it('换了样子(mini → main)= 换一张卡:旧卡收掉、新卡是新样子;同一张卡的 close 恒为同一个、closed 收卡时 resolve', async () => {
    registerFloatViewRenderer()
    const a = await workspaceOpen({ type: 'v' }, { layer: { float: 'window' } })
    const a2 = await workspaceOpen({ type: 'v' }, { layer: { float: 'window' } })
    expect(a.ok && a2.ok && a.close === a2.close).toBe(true)
    const [old] = floatViewsSnapshot()
    let resolved = false
    if (a.ok) void a.closed?.then(() => { resolved = true })
    const b = await workspaceOpen({ type: 'v' }, { layer: { float: 'window' }, form: 'main' })
    expect(b).toMatchObject({ ok: true, form: 'main' })
    expect(old.handle.closed).toBe(true)
    await Promise.resolve()
    expect(resolved).toBe(true)
    const [rec] = floatViewsSnapshot()
    expect(floatViewsSnapshot()).toHaveLength(1)
    expect(rec.form).toBe('main')
    expect(rec.handle.el.dataset.viewFloat).toBe('main')
  })

  it('主视图反注册也收(紧凑视图还在也一样)', async () => {
    registerFloatViewRenderer()
    registerView({ type: 'v.mini', displayName: 'V mini', factory })
    registerView({ type: 'v', displayName: 'V', factory, forms: { main: true, mini: { view: { type: 'v.mini' } } } })
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space' } })
    const [rec] = floatViewsSnapshot()
    unregisterView('v')
    expect(rec.handle.closed).toBe(true)
    expect(floatViewsSnapshot()).toHaveLength(0)
  })

  it('原生手机(UI_MODE 仍是 desktop、单列 store):窗口作用域的 Mini 是半屏抽屉', async () => {
    useWorkspace.setState({ activeMainId: null } as never)
    registerFloatViewRenderer()
    await workspaceOpen({ type: 'v' }, { layer: { float: 'window' } })
    expect(floatViewsSnapshot()[0].sheet).toBe(true)
  })

  it('「在主面板显示」:主区复用了 singleton 也把参数带过去,然后收卡;没开成就不收', async () => {
    const leaf = { id: 'l1', type: 'v', loc: 'main', params: { old: 1, n: 0 }, setTitle() {}, setParams: vi.fn(), close() {} }
    const openView = vi.fn((): unknown => leaf)
    useWorkspace.setState({ openView } as never)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    // vitest 这边 lcl 的 .tsx 走经典 JSX(React.createElement),应用构建是自动 runtime:只在这条里给个全局 React
    ;(globalThis as { React?: unknown }).React = React
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    act(() => root.render(h(FloatViews)))
    await act(async () => { await workspaceOpen({ type: 'v', params: { n: 2 } }, { layer: { float: 'window' } }) })
    const [rec] = floatViewsSnapshot()
    const btn = () => rec.handle.el.querySelectorAll<HTMLButtonElement>('.lcl-float-view-btn')[0]
    openView.mockReturnValueOnce(null)
    act(() => btn().click())
    expect(rec.handle.closed).toBe(false)
    act(() => btn().click())
    expect(openView).toHaveBeenLastCalledWith('v', { n: 2 }, 'main')
    expect(leaf.setParams).toHaveBeenCalledWith({ old: 1, n: 2 })
    expect(rec.handle.closed).toBe(true)
    act(() => root.unmount())
  })

  it('没挂浮层宿主:unavailable,不留浮层', async () => {
    expect(await workspaceOpen({ type: 'v' }, { layer: { float: 'window' } })).toEqual({ ok: false, reason: 'unavailable' })
    expect(document.querySelector('.lcl-float')).toBeNull()
  })
})

describe('Space 作用域的卡 × Space 布局(§7 位置记忆)', () => {
  const factory = () => null
  const saved = vi.fn()
  let owner: string | null = 'cloud'
  const fp = () => floatPersistence()!
  const card = (type: string, over: Partial<PersistedFloat> = {}): PersistedFloat =>
    ({ type, form: 'mini', anchor: 'bottom-center', view: { type, params: { n: 2 } }, mainView: { type, params: { n: 2 } }, ...over })
  beforeEach(() => {
    resetWorkspaceOpenForTest(); resetFloatsForTest()
    document.body.innerHTML = ''
    localStorage.clear()
    useSpaceStore.setState({ activeSpaceId: 'cloud' })
    registerView({ type: 'v', displayName: 'V', factory })
    saved.mockClear()
    owner = 'cloud'
    setFloatLayoutHost({ save: saved, owner: () => owner })
  })
  afterEach(() => { resetWorkspaceOpenForTest(); resetFloatsForTest(); unregisterView('v'); unregisterView('late'); setFloatLayoutHost({ save: scheduleWorkspaceSave, owner: liveLayoutOwner }) })

  it('开着的卡记进这个 Space 的布局(视图、当前参数、样子、key、锚点);开 / 视图改参数 / 关都请存一次;窗口作用域不记', async () => {
    registerFloatViewRenderer()
    await workspaceOpen({ type: 'v', params: { n: 1 } }, { layer: { float: 'space', anchor: 'top-end' }, key: 'k' })
    expect(saved).toHaveBeenCalledTimes(1)
    expect(fp().collect('cloud')).toEqual([{ type: 'v', form: 'mini', anchor: 'top-end', view: { type: 'v', params: { n: 1 } }, mainView: { type: 'v', params: { n: 1 } }, key: 'k' }])
    expect(fp().collect('chat')).toEqual([])
    const [rec] = floatViewsSnapshot()
    noteFloatParams(rec, { n: 5 })
    expect(saved).toHaveBeenCalledTimes(2)
    expect(fp().collect('cloud')[0]).toMatchObject({ view: { params: { n: 5 } }, mainView: { params: { n: 5 } } })
    rec.handle.move('bottom-start')
    expect(fp().collect('cloud')[0].anchor).toBe('bottom-start')
    await workspaceOpen({ type: 'v' }, { layer: { float: 'window' } })
    expect(fp().collect('cloud')).toHaveLength(1)
    rec.close()
    expect(saved).toHaveBeenCalledTimes(3)
    expect(fp().collect('cloud')).toEqual([])
  })

  it('布局换上来:按布局开回卡,锚点以布局为准(盖过本机记忆);开着的不重开、不改', () => {
    registerFloatViewRenderer()
    localStorage.setItem('lcl.float.anchor.open:space:cloud:v#k', 'top-start')
    fp().restore('cloud', [card('v', { key: 'k' })])
    const [rec] = floatViewsSnapshot()
    expect(rec).toMatchObject({ scope: 'space', space: 'cloud', key: 'k', view: { params: { n: 2 } } })
    expect(rec.handle.anchor).toBe('bottom-center')
    fp().restore('cloud', [card('v', { key: 'k', view: { type: 'v', params: { n: 9 } } })])
    expect(floatViewsSnapshot()).toEqual([rec])
    expect(rec.view.params).toEqual({ n: 2 })
  })

  it('视图还没注册 / 浮层宿主还没挂上:先挂起,存布局照样带上(读不到 ≠ 没有);到了再开', () => {
    fp().restore('cloud', [card('late'), card('v')])
    expect(floatViewsSnapshot()).toHaveLength(0)
    expect(fp().collect('cloud').map((f) => f.type)).toEqual(['late', 'v'])
    registerFloatViewRenderer()
    expect(floatViewsSnapshot().map((r) => r.targetType)).toEqual(['v'])
    expect(fp().collect('cloud').map((f) => f.type).sort()).toEqual(['late', 'v'])
    registerView({ type: 'late', displayName: 'Late', factory })
    expect(floatViewsSnapshot().map((r) => r.targetType).sort()).toEqual(['late', 'v'])
    expect(fp().collect('cloud')).toHaveLength(2)
  })

  it('恢复默认布局:收掉这个 Space 的卡和挂起的;别的 Space 不动', async () => {
    registerFloatViewRenderer()
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space' } })
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space', space: 'chat' } })
    fp().restore('cloud', [card('late')])
    fp().clear('cloud')
    expect(fp().collect('cloud')).toEqual([])
    expect(floatViewsSnapshot().map((r) => r.space)).toEqual(['chat'])
  })

  it('参数存不下(循环引用)的卡不记,别的照记', async () => {
    registerFloatViewRenderer()
    const loop: Record<string, unknown> = {}
    loop.self = loop
    await workspaceOpen({ type: 'v', params: loop }, { layer: { float: 'space' }, key: 'a' })
    await workspaceOpen({ type: 'v', params: { ok: 1 } }, { layer: { float: 'space' }, key: 'b' })
    expect(fp().collect('cloud').map((f) => f.key)).toEqual(['b'])
  })

  it('藏着的 Space 的卡变了(插件 close() / 视图改参数):改那个 Space 存着的那份,不存屏上这份;那个 Space 没存过就不建', async () => {
    registerFloatViewRenderer()
    const env = { version: 4 as const, space: 'chat', dockview: { tag: 'chat-layout' }, sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [] } } }
    saveNamedLayout('space:chat', { ...env, floats: [card('v')] })
    await workspaceOpen({ type: 'v', params: { n: 1 } }, { layer: { float: 'space', space: 'chat' } })
    const [rec] = floatViewsSnapshot()
    saved.mockClear()
    noteFloatParams(rec, { n: 7 })
    await new Promise((r) => setTimeout(r, 150))
    expect(saved).not.toHaveBeenCalled()
    expect(loadNamedLayout('space:chat')).toMatchObject({ dockview: { tag: 'chat-layout' }, floats: [{ view: { params: { n: 7 } } }] })
    rec.close()
    await new Promise((r) => setTimeout(r, 150))
    expect(loadNamedLayout('space:chat')).toMatchObject({ dockview: { tag: 'chat-layout' } })
    expect('floats' in loadNamedLayout('space:chat')!).toBe(false)
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space', space: 'never' } })
    await new Promise((r) => setTimeout(r, 150))
    expect(loadNamedLayout('space:never')).toBeNull()
  })

  it('Space 作用域的锚点记忆每个 Space 各记各的', async () => {
    registerFloatViewRenderer()
    localStorage.setItem('lcl.float.anchor.open:space:cloud:v', 'top-start')
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space' } })
    await workspaceOpen({ type: 'v' }, { layer: { float: 'space', space: 'chat' } })
    expect(floatViewsSnapshot().map((r) => [r.space, r.handle.anchor])).toEqual([['cloud', 'top-start'], ['chat', 'bottom-end']])
  })
})
