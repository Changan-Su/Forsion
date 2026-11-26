// @vitest-environment happy-dom
/** 插件桌面小窗的渲染层(pluginDesktopWindow.ts):没声明能力 / 用户拒了 = 回落到窗口里;limit 原样回;同 key 再开只换参数;
 *  视图挂进子窗拿到 surface 'desktop' 和控制器(挪窗夹在屏内、点穿模式、帧回调);关窗跑插件的清理并告诉主进程;插件停用(视图反注册)
 *  也关;别的卫星窗只回报。真子窗 / 真点穿 / 真主题同步在 scripts/desktop-window.check.cjs。
 *  负对照(11-26 已实跑红):不查 capabilities →「没声明 desktopWindow」红;同 key 不复用 →「同 key 再开」红;
 *  moveTo 不夹 →「挪窗夹在屏内」红;不订视图反注册 →「插件停用」红。
 *  评审补的(11-26 实跑红):询问后不再核视图定义 →「等询问框时插件被停用」红;同步 close 后不补跑清理 →「mount 里同步 close()」红;
 *  不定时重判 →「鼠标停着不动」红。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerView, unregisterView } from '@lcl/engine/viewRegistry'
import type { PluginViewContext, ViewContribution } from '@amadeus/plugins/types'
import type { DesktopScreen } from '../../shared/desktopWindow'

const { usePluginStore } = await import('@amadeus/plugins/pluginStore')
const { openPluginDesktopWindow, openPluginDesktopWindowElsewhere, resetPluginDesktopWindowsForTest } = await import('./pluginDesktopWindow')

const screen: DesktopScreen = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 800 }, scaleFactor: 2 }
let api: Record<string, ReturnType<typeof vi.fn>>
let child: { document: Document; requestAnimationFrame: (cb: (t: number) => void) => number; cancelAnimationFrame: (h: number) => void; addEventListener: () => void; setInterval: typeof setInterval; clearInterval: typeof clearInterval }
let mounted: { el: HTMLElement; view: PluginViewContext } | null
const cleanup = vi.fn()
const def: ViewContribution = { id: 'pet', title: 'Pet', mount: (el, view) => { mounted = { el, view: view! }; return cleanup } }

function setup(caps: string[] = ['desktopWindow']): void {
  usePluginStore.setState({ plugins: [{ id: 'p', name: 'Pet', version: '1', capabilities: caps as never, setup: () => {} }], views: [{ pluginId: 'p', item: def }] } as never)
  registerView({ type: 'plugin:p:pet', displayName: 'Pet', factory: () => null })
}

beforeEach(() => {
  mounted = null
  cleanup.mockReset()
  const d = document.implementation.createHTMLDocument('')
  let n = 0
  child = { document: d, requestAnimationFrame: (cb) => { n++; queueMicrotask(() => cb(16)); return n }, cancelAnimationFrame: () => {}, addEventListener: () => {}, setInterval: ((fn: () => void, ms: number) => setInterval(fn, ms)) as typeof setInterval, clearInterval: ((h: ReturnType<typeof setInterval>) => clearInterval(h)) as typeof clearInterval }
  api = {
    prepare: vi.fn(async () => ({ ok: true, id: 'dw1', frameName: 'forsion-plugin-desktop-x', existing: false, bounds: { x: 100, y: 100, width: 160, height: 160 }, screens: [screen], clickThrough: true })),
    setBounds: vi.fn(), passThrough: vi.fn(), released: vi.fn(), close: vi.fn(), closePlugin: vi.fn(),
    onClosed: vi.fn(() => () => {}), onScreensChanged: vi.fn(() => () => {}),
  }
  ;(window as unknown as { tangu?: unknown }).tangu = { desktopWindow: api }
  vi.spyOn(window, 'open').mockImplementation(() => child as unknown as Window)
})
afterEach(() => { resetPluginDesktopWindowsForTest(); unregisterView('plugin:p:pet'); vi.restoreAllMocks() })

const req = (over: Record<string, unknown> = {}) => ({ view: { type: 'plugin:p:pet', params: { skin: 'cat' } }, key: 'k', pin: true, ...over })

describe('回落与失败', () => {
  it('没声明 desktopWindow:回落(引擎改开窗口里的 bare 浮层),只提示一次,不去问主进程', async () => {
    setup([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await openPluginDesktopWindow(req())).toEqual({ ok: false, reason: 'fallback' })
    await openPluginDesktopWindow(req())
    expect(warn).toHaveBeenCalledTimes(1)
    expect(api.prepare).not.toHaveBeenCalled()
  })
  it('用户拒了 = 回落;开满了 = limit;别的 = unavailable', async () => {
    setup()
    api.prepare.mockResolvedValueOnce({ ok: false, reason: 'denied' })
    expect(await openPluginDesktopWindow(req())).toEqual({ ok: false, reason: 'fallback' })
    api.prepare.mockResolvedValueOnce({ ok: false, reason: 'limit', limit: 3 })
    expect(await openPluginDesktopWindow(req())).toEqual({ ok: false, reason: 'limit', limit: 3 })
    api.prepare.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect(await openPluginDesktopWindow(req())).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('不是插件视图 / 没有桥:回落', async () => {
    setup()
    expect(await openPluginDesktopWindow(req({ view: { type: 'note' } }))).toEqual({ ok: false, reason: 'fallback' })
    ;(window as unknown as { tangu?: unknown }).tangu = {}
    expect(await openPluginDesktopWindow(req())).toEqual({ ok: false, reason: 'fallback' })
  })
  it('别的卫星窗:主窗那边开着 = ok(什么都不做),没开 = unavailable', async () => {
    setup()
    api.prepare.mockResolvedValueOnce({ ok: false, reason: 'elsewhere' })
    expect(await openPluginDesktopWindowElsewhere(req())).toEqual({ ok: true })
    api.prepare.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect(await openPluginDesktopWindowElsewhere(req())).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('挂进子窗', () => {
  it('surface desktop + 控制器;同 key 再开只换参数,不另开', async () => {
    setup()
    const r = await openPluginDesktopWindow(req())
    expect(r.ok).toBe(true)
    expect(window.open).toHaveBeenCalledWith('about:blank', 'forsion-plugin-desktop-x')
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'p', pluginName: 'Pet', key: 'k', title: 'Pet', width: 160, height: 160, pin: true }))
    expect(mounted!.el.ownerDocument).toBe(child.document)
    expect(mounted!.view.surface).toBe('desktop')
    expect(mounted!.view.getParams!()).toEqual({ skin: 'cat' })
    const seen: unknown[] = []
    mounted!.view.onParamsChanged!((p) => seen.push(p))
    await openPluginDesktopWindow(req({ view: { type: 'plugin:p:pet', params: { skin: 'dog' } } }))
    expect(api.prepare).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([{ skin: 'dog' }])
  })
  it('挪窗夹在屏内并告诉主进程;onBounds 收到;点穿缺省 shape(先点穿),可换整扇接住', async () => {
    setup()
    await openPluginDesktopWindow(req())
    const d = mounted!.view.desktop!
    expect(api.passThrough).toHaveBeenLastCalledWith('dw1', true)
    const moves: unknown[] = []
    d.onBounds((b) => moves.push(b))
    d.moveTo(-1000, 50)
    expect(d.bounds()).toEqual({ x: -128, y: 50, width: 160, height: 160 })
    expect(api.setBounds).toHaveBeenLastCalledWith('dw1', { x: -128, y: 50, width: 160, height: 160 })
    d.resize(5000, 100)
    expect(d.bounds().width).toBe(720)
    expect(moves).toHaveLength(2)
    expect(d.workArea()).toEqual(screen.workArea)
    d.setClickThrough('none')
    expect(api.passThrough).toHaveBeenLastCalledWith('dw1', false)
    expect(() => d.setClickThrough('maybe' as never)).toThrow(TypeError)
    const t = await new Promise<number>((res) => d.requestFrame(res))
    expect(t).toBe(16)
  })
  it('关窗:跑插件的清理、告诉主进程;之后再调控制器抛错', async () => {
    setup()
    const r = await openPluginDesktopWindow(req())
    const d = mounted!.view.desktop!
    if (r.ok) r.close?.()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(api.close).toHaveBeenCalledWith('dw1')
    expect(() => d.moveTo(1, 1)).toThrow()
  })
  it('插件停用(视图反注册):小窗跟着关', async () => {
    setup()
    await openPluginDesktopWindow(req())
    unregisterView('plugin:p:pet')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(api.close).toHaveBeenCalledWith('dw1')
  })
  it('子窗拿不到(名额过期被拒 / 被拦):叫主进程关掉那扇,退成窗口里的卡', async () => {
    setup()
    vi.mocked(window.open).mockReturnValueOnce(null)
    expect(await openPluginDesktopWindow(req())).toEqual({ ok: false, reason: 'fallback' })
    expect(api.close).toHaveBeenCalledWith('dw1')
  })
  it('等询问框时插件被停用:不挂旧的视图定义,叫主进程收掉那扇', async () => {
    setup()
    let answer!: (v: unknown) => void
    api.prepare.mockImplementationOnce(() => new Promise((res) => { answer = res }))
    const p = openPluginDesktopWindow(req())
    unregisterView('plugin:p:pet')
    usePluginStore.setState({ plugins: [], views: [] } as never)
    answer({ ok: true, id: 'dw1', frameName: 'forsion-plugin-desktop-x', existing: false, bounds: { x: 100, y: 100, width: 160, height: 160 }, screens: [screen], clickThrough: true })
    expect(await p).toEqual({ ok: false, reason: 'unavailable' })
    expect(mounted).toBeNull()
    expect(api.close).toHaveBeenCalledWith('dw1')
    expect(window.open).not.toHaveBeenCalled()
  })
  it('mount 里同步 close() 再交回清理函数:清理照样跑', async () => {
    const late = vi.fn()
    usePluginStore.setState({ plugins: [{ id: 'p', name: 'Pet', version: '1', capabilities: ['desktopWindow'] as never, setup: () => {} }],
      views: [{ pluginId: 'p', item: { id: 'pet', title: 'Pet', mount: (_el: HTMLElement, view: PluginViewContext) => { view.close!(); return late } } }] } as never)
    registerView({ type: 'plugin:p:pet', displayName: 'Pet', factory: () => null })
    await openPluginDesktopWindow(req())
    expect(late).toHaveBeenCalledTimes(1)
  })
  it('鼠标停着不动、宠物自己走到底下:定时再判一次,接住', async () => {
    setup()
    await openPluginDesktopWindow(req())
    const d = child.document
    let onPet = false
    d.elementFromPoint = (() => (onPet ? mounted!.el.firstElementChild ?? d.body : d.body)) as never
    const pet = d.createElement('div'); mounted!.el.append(pet)
    d.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }))
    expect(api.passThrough).toHaveBeenLastCalledWith('dw1', true)
    onPet = true // 宠物走过来了,鼠标没动
    await vi.waitFor(() => expect(api.passThrough).toHaveBeenLastCalledWith('dw1', false), { timeout: 1000 })
  })
})
