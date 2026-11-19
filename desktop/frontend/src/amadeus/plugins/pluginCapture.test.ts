// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markPluginSurface, pluginSurfaceOwner } from './pluginSurfaces'
import { capturePluginElement, checkCaptureArgs, checkCaptureTarget } from './pluginCapture'
import { usePluginStore } from './pluginStore'
import type { PluginContext } from './types'

type R = { left: number; top: number; width: number; height: number }
const rects = new Map<Element, R>()
const place = (el: Element, r: R): Element => { rects.set(el, r); return el }
let hitAt: (x: number, y: number) => Element | null = () => null

beforeEach(() => {
  document.body.innerHTML = ''
  rects.clear()
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const r = rects.get(this) ?? { left: 0, top: 0, width: 0, height: 0 }
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON() {} } as DOMRect
  })
  ;(document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = (x, y) => hitAt(x, y)
})
afterEach(() => { vi.restoreAllMocks(); delete window.tangu })

/** 插件视图:登记过的容器 + 里面一块要截的元素;命中测试缺省打在元素上。 */
function view(pluginId = 'demo'): { host: HTMLElement; el: HTMLElement } {
  const host = document.body.appendChild(document.createElement('div'))
  const el = host.appendChild(document.createElement('div'))
  place(host, { left: 0, top: 0, width: 1000, height: 800 })
  place(el, { left: 100, top: 100, width: 400, height: 300 })
  markPluginSurface(host, pluginId)
  hitAt = () => el
  return { host, el }
}

const code = (fn: () => unknown): string | undefined => { try { fn(); return undefined } catch (e) { return (e as { code?: string }).code } }

describe('plugin surface ownership', () => {
  it('belongs to the plugin the host handed the surface to, through shadow roots; unmark only drops its own entry', () => {
    const { host, el } = view('a')
    const inner = el.attachShadow({ mode: 'open' }).appendChild(document.createElement('span'))
    expect(pluginSurfaceOwner(inner)).toBe('a')
    expect(pluginSurfaceOwner(document.body)).toBeNull()
    const undoB = markPluginSurface(host, 'b') // the same container handed to another plugin later
    const undoStale = markPluginSurface(document.createElement('div'), 'a')
    undoStale()
    expect(pluginSurfaceOwner(el)).toBe('b')
    undoB()
    expect(pluginSurfaceOwner(el)).toBeNull()
  })

  it('does not trust DOM attributes', () => {
    const el = document.body.appendChild(document.createElement('div'))
    el.setAttribute('data-guide-owner', 'demo'); el.dataset.floatOwner = 'demo'
    place(el, { left: 0, top: 0, width: 50, height: 50 })
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBe('not-owned')
  })
})

describe('what may be captured', () => {
  it('passes a fully visible owned element and returns its viewport rect', () => {
    const { el } = view()
    expect(checkCaptureTarget(el, 'demo')).toEqual({ x: 100, y: 100, width: 400, height: 300 })
  })

  it('refuses another plugin, a detached element, a zero-size one, a hidden window', () => {
    const { el } = view('other')
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBe('not-owned')
    expect(code(() => checkCaptureTarget(document.createElement('div'), 'demo'))).toBe('detached')
    const mine = view().el
    place(mine, { left: 0, top: 0, width: 0, height: 10 })
    expect(code(() => checkCaptureTarget(mine, 'demo'))).toBe('empty')
    place(mine, { left: 0, top: 0, width: 10, height: 10 })
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    expect(code(() => checkCaptureTarget(mine, 'demo'))).toBe('window-hidden')
    vis.mockRestore()
  })

  it('refuses an element partly outside the window', () => {
    const { el } = view()
    place(el, { left: 900, top: 100, width: 400, height: 300 })
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBe('clipped')
  })

  it('refuses an element scrolled half out of its scroll container, but not one that sits inside', () => {
    const { host, el } = view()
    const scroller = host.appendChild(document.createElement('div'))
    scroller.style.overflow = 'auto'
    place(scroller, { left: 0, top: 0, width: 600, height: 250 })
    scroller.appendChild(el)
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBe('clipped') // el bottom 400 > scroller bottom 250
    place(scroller, { left: 0, top: 0, width: 600, height: 500 })
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBeUndefined()
  })

  it('a fixed element is not clipped by an overflow ancestor it escapes (window-scope float)', () => {
    const { host, el } = view()
    const scroller = host.appendChild(document.createElement('div'))
    scroller.style.overflow = 'hidden'
    place(scroller, { left: 0, top: 0, width: 50, height: 50 })
    scroller.appendChild(el)
    el.style.position = 'fixed'
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBeUndefined()
    scroller.style.transform = 'translateX(0px)' // now it is the fixed element's containing block → clips
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBe('clipped')
  })

  it('refuses when something that is not the plugin\'s lies on top; its own float on top is fine', () => {
    const { el } = view()
    const toast = document.body.appendChild(document.createElement('div'))
    hitAt = (x, y) => (x > 300 && y > 300 ? toast : el)
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBe('covered')
    const float = document.body.appendChild(document.createElement('div'))
    markPluginSurface(float, 'demo')
    hitAt = (x, y) => (x > 300 && y > 300 ? float : el)
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBeUndefined()
    // an ancestor hit = nothing on top (children with pointer-events: none)
    hitAt = () => document.body
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBeUndefined()
  })

  it('throws TypeErrors synchronously for wrong argument shapes', () => {
    expect(() => checkCaptureArgs('div', undefined, 'capture')).toThrow(TypeError)
    expect(() => checkCaptureArgs(document.body, { scale: 0 }, 'capture')).toThrow(TypeError)
    expect(() => checkCaptureArgs(document.body, { fps: NaN }, 'record')).toThrow(TypeError)
    expect(() => checkCaptureArgs(document.body, { mimeType: 1 }, 'record')).toThrow(TypeError)
    expect(() => checkCaptureArgs(document.body, { scale: 1, fps: 30, maxSeconds: 5 }, 'record')).not.toThrow()
  })
})

describe('capture through the bridge', () => {
  it('asks the main process for the element rect as PNG and reports the delivered density', async () => {
    const { el } = view()
    const bridge = vi.fn(async () => ({ ok: true as const, data: new Uint8Array([137, 80, 78, 71]), width: 800, height: 600 }))
    window.tangu = { captureRegion: bridge } as unknown as typeof window.tangu
    const r = await capturePluginElement('demo', el, { scale: 2 })
    expect(bridge).toHaveBeenCalledWith({ rect: { x: 100, y: 100, width: 400, height: 300 }, format: 'png', scale: 2 })
    expect(r).toMatchObject({ mime: 'image/png', width: 800, height: 600, scale: 2 })
    expect(r.bytes[1]).toBe(80)
  })

  it('maps a hidden window, a missing bridge and a disabled plugin to their codes', async () => {
    const { el } = view()
    await expect(capturePluginElement('demo', el)).rejects.toMatchObject({ name: 'PluginCaptureError', code: 'unavailable' })
    window.tangu = { captureRegion: async () => ({ ok: false, code: 'window-hidden' }) } as unknown as typeof window.tangu
    await expect(capturePluginElement('demo', el)).rejects.toMatchObject({ code: 'window-hidden' })
    await expect(capturePluginElement('demo', el, {}, () => false)).rejects.toMatchObject({ code: 'disposed' })
    await expect(capturePluginElement('other', el)).rejects.toMatchObject({ code: 'not-owned' })
  })
})

describe('ctx.ui wiring', () => {
  afterEach(() => { usePluginStore.getState().disable('capture-probe') })
  const boot = (): PluginContext => {
    let ctx: PluginContext | undefined
    localStorage.clear() // disable() 会把 id 记进停用名单,不清的话下一次 init 不跑 setup
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {}, settings: [], readiness: [] })
    usePluginStore.getState().init([{ id: 'capture-probe', name: 'Capture probe', version: '1', builtin: false, setup(c) { ctx = c } }])
    return ctx!
  }

  it('exists only where the desktop bridge does', () => {
    expect(boot().ui?.capture).toBeUndefined()
    usePluginStore.getState().disable('capture-probe')
    window.tangu = { captureRegion: async () => ({ ok: false, code: 'failed' }) } as unknown as typeof window.tangu
    const ctx = boot()
    expect(typeof ctx.ui?.capture).toBe('function')
    expect(typeof ctx.ui?.record).toBe('function')
    expect(() => ctx.ui!.capture!('nope' as unknown as Element)).toThrow(TypeError)
  })

  it('a float the plugin opened is its own surface', async () => {
    window.tangu = { captureRegion: async () => ({ ok: true, data: new Uint8Array(4), width: 20, height: 20 }) } as unknown as typeof window.tangu
    const ctx = boot()
    const f = ctx.ui!.float!({ scope: 'window', anchor: 'bottom-end' })
    expect(pluginSurfaceOwner(f.el)).toBe('capture-probe')
    usePluginStore.getState().disable('capture-probe')
    expect(pluginSurfaceOwner(f.el)).toBeNull()
  })
})
