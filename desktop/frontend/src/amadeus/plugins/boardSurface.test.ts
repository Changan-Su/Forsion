// @vitest-environment happy-dom
/**
 * ctx.ui.mountBoard 的那一层自己的逻辑:视口归调用方、滚轮截下交回、只在元素变了时回调、套笔。
 * 引擎换成一个桩(真引擎是 6 MB 的 <script>,happy-dom 里装不了);它画不画得对由真应用里的台架看
 * (插件仓 forsion-plugin-pdf-reader 的 verify/smoke.cjs ⑧)。
 * 负对照(2026-10-10 实跑):去掉滚轮的 stopPropagation → 「滚轮」那条红;去掉 onChange 的版本比对 → 「只在元素变了」那条红;
 * 去掉引擎漂移后的回推 → 「拉回」那条红。
 * 负对照(2026-10-10 实跑):推给引擎的缩放不乘界面缩放 → 「界面缩放」那条红。
 * 负对照(2026-10-10 评审返修时实跑):改回在 onExcalidrawAPI 里绑定 → 「装完初始内容之后」两条红;收尾回调里不记最后的样子 → 「被后来的挂载收掉」那条红。
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const eng = vi.hoisted(() => ({
  props: null as any,
  api: null as any,
  elements: [] as any[],
  appState: {} as Record<string, unknown>,
  engineWheel: null as any,
  boot(props: any) {
    props.onExcalidrawAPI?.(eng.api)
    eng.elements = props.initialData.elements
    for (const k of Object.keys(eng.appState)) delete eng.appState[k]
    Object.assign(eng.appState, props.initialData.appState)
    props.onInitialize?.(eng.api)
  },
}))
vi.mock('../blocks/excalidraw/forkRuntime', async () => {
  const { useEffect, createElement } = await import('react')
  return {
    CaptureUpdateAction: { NEVER: 'never' },
    restoreElements: (els: any[]) => els,
    newElementWith: (e: any, p: any) => ({ ...e, ...p }),
    serializeAsJSON: () => '',
    MainMenu: () => null,
    getCommonBounds: (els: any[]) => [Math.min(...els.map((e) => e.x)), Math.min(...els.map((e) => e.y)), Math.max(...els.map((e) => e.x + e.width)), Math.max(...els.map((e) => e.y + e.height))],
    exportToSvg: vi.fn(async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
    Excalidraw: (props: any) => {
      eng.props = props
      // 和真引擎同一个顺序:先交出 API,再装初始内容(此前推进去的内容 / 笔全被冲掉),装完才报 onInitialize。
      useEffect(() => { if (eng.api) eng.boot(props) }, []) // eslint-disable-line react-hooks/exhaustive-deps
      // 引擎的滚轮监听是挂在它自己容器上的原生监听
      return createElement('div', { 'data-stub': 'engine', ref: (n: HTMLElement | null) => n?.addEventListener('wheel', eng.engineWheel) })
    },
  }
})

const { mountPluginBoard, pluginBoardToSvg } = await import('./boardSurface')

const el0 = (id: string, version = 1, extra: object = {}) => ({ id, version, type: 'freedraw', x: 10, y: 20, width: 30, height: 40, isDeleted: false, ...extra })
const VP = { scrollX: 5, scrollY: -7, zoom: 1.5 }
let el: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  eng.elements = []
  eng.appState = {}
  eng.engineWheel = vi.fn()
  eng.api = {
    updateScene: vi.fn((p: any) => { if (p.elements) eng.elements = p.elements; Object.assign(eng.appState, p.appState) }),
    getAppState: () => eng.appState,
    getSceneElements: () => eng.elements.filter((e) => !e.isDeleted),
    getSceneElementsIncludingDeleted: () => eng.elements,
    getFiles: () => ({}),
    addFiles: vi.fn(),
    history: { undo: vi.fn(), redo: vi.fn() },
  }
  el = document.body.appendChild(document.createElement('div'))
})
afterEach(() => { el.remove(); vi.unstubAllGlobals() })

const mount = async (opts: object = {}) => {
  let handle!: ReturnType<typeof mountPluginBoard>
  await act(async () => { handle = mountPluginBoard(el, { scene: { elements: [el0('a')] }, viewport: VP, ...opts } as any) })
  eng.elements = eng.props.initialData.elements // 引擎装好初始内容
  return handle
}
const appPatches = () => eng.api.updateScene.mock.calls.map((c: any[]) => c[0]).filter((p: any) => p.appState)

describe('ctx.ui.mountBoard 的那一层', () => {
  it('没有界面、背景透明、工具受控;视口照调用方给的写进引擎,且不进撤销栈', async () => {
    const onReady = vi.fn()
    await mount({ tool: 'eraser', theme: 'light', onReady })
    expect(eng.props.ui).toBe(false)
    expect(eng.props.activeTool).toEqual({ type: 'eraser' })
    expect(eng.props.handleKeyboardGlobally).toBe(false)
    expect(eng.props.initialData.appState.viewBackgroundColor).toBe('transparent')
    expect(eng.props.initialData.scrollToContent).toBe(false)
    expect(eng.appState).toMatchObject({ scrollX: 5, scrollY: -7, zoom: { value: 1.5 } })
    expect(eng.api.updateScene.mock.calls.every((c: any[]) => c[0].captureUpdate === 'never')).toBe(true)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('update({ viewport }) 推给引擎;引擎自己动了视口(空格拖 / 双指)会被拉回', async () => {
    const h1 = await mount()
    h1.update({ viewport: { scrollX: 100, scrollY: 200, zoom: 2 } })
    expect(eng.appState).toMatchObject({ scrollX: 100, scrollY: 200, zoom: { value: 2 } })
    const before = appPatches().length
    await act(async () => { eng.props.onScrollChange(100, 200, { value: 2 }) }) // 和调用方给的一样:不动
    expect(appPatches().length).toBe(before)
    eng.appState.scrollX = 140
    await act(async () => { eng.props.onScrollChange(140, 200, { value: 2 }); await Promise.resolve() })
    expect(eng.appState.scrollX).toBe(100)
  })

  it('滚轮在进引擎之前截下,原样交给 onWheel', async () => {
    const onWheel = vi.fn()
    await mount({ onWheel })
    const ev = new WheelEvent('wheel', { deltaY: 30, bubbles: true, cancelable: true })
    el.querySelector('[data-stub="engine"]')!.dispatchEvent(ev)
    expect(onWheel).toHaveBeenCalledWith(ev)
    expect(eng.engineWheel).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
  })

  it('只在元素变了时回调 onChange:初始内容、选中态变化、自己推进去的内容都不算;删掉的元素不交出去', async () => {
    const onChange = vi.fn()
    const h1 = await mount({ onChange })
    eng.props.onChange(eng.elements, {}, {}) // 引擎装好初始内容后的那一次
    eng.props.onChange(eng.elements, { selectedElementIds: { a: true } }, {}) // 只是选中
    expect(onChange).not.toHaveBeenCalled()

    eng.elements = [el0('a'), el0('b', 3), el0('gone', 2, { isDeleted: true })]
    eng.props.onChange(eng.elements, {}, {})
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].elements.map((e: any) => e.id)).toEqual(['a', 'b'])
    expect(h1.getScene().elements.map((e: any) => e.id)).toEqual(['a', 'b'])

    h1.update({ scene: { elements: [el0('c', 9)] } })
    eng.props.onChange(eng.elements, {}, {}) // 引擎把我们推的那份回显出来
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(eng.elements.map((e) => e.id)).toEqual(['c'])
  })

  it('套笔:先套这支笔自己的参数,点名的颜色 / 粗细盖上去;带填充的笔填充跟着颜色走', async () => {
    const h1 = await mount({ pen: 'fountain' })
    expect((eng.appState.currentStrokeOptions as any).options.start.taper).toBe(150) // 钢笔的起笔
    expect(eng.appState.currentItemStrokeColor).toBe('#000000')
    h1.update({ pen: 'highlighter', strokeColor: '#ffd43b', strokeWidth: 2 })
    expect((eng.appState.currentStrokeOptions as any).highlighter).toBe(true)
    expect(eng.appState).toMatchObject({ currentItemStrokeColor: '#ffd43b', currentItemBackgroundColor: '#ffd43b', currentItemStrokeWidthKey: 'bold' })
    h1.update({ pen: 'no-such-pen' as any, strokeColor: undefined, strokeWidth: undefined })
    expect((eng.appState.currentStrokeOptions as any).highlighter).toBe(false) // 不认识的笔名 = 默认笔
  })

  it('update({ tool }) 换受控工具;不认识的工具名当成自由画笔', async () => {
    const h1 = await mount()
    expect(eng.props.activeTool).toEqual({ type: 'freedraw' })
    await act(async () => { h1.update({ tool: 'selection' }) })
    expect(eng.props.activeTool).toEqual({ type: 'selection' })
    await act(async () => { h1.update({ tool: 'image' as any }) })
    expect(eng.props.activeTool).toEqual({ type: 'freedraw' })
  })

  it('撤销 / 重做走引擎;dispose 之后 getScene 还答最后的样子,update 不再生效,el 归还', async () => {
    const h1 = await mount()
    h1.undo(); h1.redo()
    expect(eng.api.history.undo).toHaveBeenCalledTimes(1)
    expect(eng.api.history.redo).toHaveBeenCalledTimes(1)
    eng.elements = [el0('z', 4)]
    await act(async () => { h1.dispose() })
    expect(el.childElementCount).toBe(0)
    expect(h1.getScene().elements.map((e: any) => e.id)).toEqual(['z'])
    const n = eng.api.updateScene.mock.calls.length
    h1.update({ viewport: { scrollX: 1, scrollY: 1, zoom: 1 } })
    expect(eng.api.updateScene.mock.calls.length).toBe(n)
  })

  it('引擎还没好时换的内容,好了补推一次', async () => {
    const api = eng.api
    eng.api = null // 引擎的 API 回调还没来
    let h1!: ReturnType<typeof mountPluginBoard>
    await act(async () => { h1 = mountPluginBoard(el, { scene: { elements: [el0('a')] }, viewport: VP }) })
    h1.update({ scene: { elements: [el0('late', 2)] } })
    eng.api = api
    await act(async () => { eng.boot(eng.props) })
    expect(eng.elements.map((e) => e.id)).toEqual(['late'])
    expect(h1.getScene().elements.map((e: any) => e.id)).toEqual(['late'])
  })

  it('笔和颜色是在引擎装完初始内容之后套的(早了会被装载冲掉)', async () => {
    await mount({ pen: 'marker', strokeColor: '#e03131' })
    expect(eng.appState.currentItemStrokeColor).toBe('#e03131')
    expect(eng.appState.zoom).toEqual({ value: 1.5 })
  })

  it('界面缩放(祖先的 CSS zoom):容器反向抵消、铺满原来的大小,引擎的缩放乘回去;改了界面缩放跟着重算', async () => {
    let uiz = 1.1
    Object.defineProperty(el, 'currentCSSZoom', { configurable: true, get: () => uiz })
    const h = await mount()
    const box = el.querySelector('.am-plugin-board') as HTMLElement
    expect(parseFloat(box.style.width)).toBeCloseTo(110)
    expect(parseFloat(box.style.height)).toBeCloseTo(110)
    expect(Number(box.style.zoom)).toBeCloseTo(1 / 1.1)
    expect(eng.appState.zoom.value).toBeCloseTo(1.5 * 1.1) // 调用方给的 1.5 是 el 自己的 CSS 像素口径
    h.update({ viewport: { scrollX: 0, scrollY: 0, zoom: 2 } })
    expect(eng.appState.zoom.value).toBeCloseTo(2 * 1.1)
    uiz = 1.25
    await act(async () => { window.dispatchEvent(new Event('forsion:uizoom')) })
    expect(eng.appState.zoom.value).toBeCloseTo(2 * 1.25)
    expect(parseFloat(box.style.width)).toBeCloseTo(125)
    // 引擎报回来的就是乘过的值:不许被当成「引擎自己动了视口」再推一遍
    const n = appPatches().length
    await act(async () => { eng.props.onScrollChange(0, 0, { value: 2.5 }); await Promise.resolve() })
    expect(appPatches().length).toBe(n)
  })

  it('被同一个元素上后来的挂载收掉时,旧句柄的 getScene 还答最后的样子', async () => {
    const h1 = await mount()
    eng.elements = [el0('a'), el0('b', 2)]
    await act(async () => { mountPluginBoard(el, { scene: { elements: [] }, viewport: VP }) })
    expect(h1.getScene().elements.map((e: any) => e.id)).toEqual(['a', 'b'])
  })
})

describe('ctx.ui.boardToSvg', () => {
  it('空内容给 null;否则给 SVG 和它在场景里的外框(含留白)', async () => {
    expect(await pluginBoardToSvg({ elements: [el0('x', 1, { isDeleted: true })] })).toBeNull()
    const out = await pluginBoardToSvg({ elements: [el0('a'), el0('b', 1, { x: 100, y: 5 })] }, { padding: 4, theme: 'light' })
    expect(out).toMatchObject({ x: 6, y: 1, width: 128, height: 63 })
    expect(out!.svg.tagName.toLowerCase()).toBe('svg')
  })
})
