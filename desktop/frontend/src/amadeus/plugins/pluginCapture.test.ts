// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markPluginSurface, pluginSurfaceOwner } from './pluginSurfaces'
import { capturePluginElement, checkCaptureArgs, checkCaptureTarget, recordPluginElement } from './pluginCapture'
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

  it('clips per axis: overflow clip on x only does not cut the element vertically', () => {
    const { host, el } = view()
    const strip = host.appendChild(document.createElement('div'))
    strip.style.overflow = 'clip visible'
    place(strip, { left: 0, top: 150, width: 1000, height: 50 }) // vertically much shorter than el (100..400)
    strip.appendChild(el)
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBeUndefined()
    strip.style.overflow = 'hidden'
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBe('clipped')
  })

  it('a display: contents wrapper is no box: it neither clips nor counts as a containing block', () => {
    const { host, el } = view()
    const wrap = host.appendChild(document.createElement('div'))
    wrap.style.display = 'contents'; wrap.style.overflow = 'hidden'
    place(wrap, { left: 0, top: 0, width: 0, height: 0 })
    wrap.appendChild(el)
    expect(code(() => checkCaptureTarget(el, 'demo'))).toBeUndefined()
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

describe('record lifecycle (fake encoder)', () => {
  /** 假 MediaRecorder:start / stop 同步改状态,stop 后异步发 dataavailable + stop;startThrows 模拟编码器起不来。 */
  let startThrows = false
  class FakeRecorder {
    static isTypeSupported = (m: string): boolean => m.startsWith('video/mp4') || m.startsWith('video/webm')
    state: 'inactive' | 'recording' = 'inactive'
    mimeType: string
    ondataavailable: ((e: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(_s: unknown, o: { mimeType: string }) { this.mimeType = o.mimeType; (globalThis as unknown as { __lastRecorder?: unknown }).__lastRecorder = this }
    start(): void { if (startThrows) throw new Error('NotSupportedError'); this.state = 'recording' }
    stop(): void {
      this.state = 'inactive'
      setTimeout(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) }); this.onstop?.() }, 0)
    }
  }
  let frameThrows = false
  class FakeFrame { constructor() { if (frameThrows) throw new Error('bad bitmap') } close(): void {} }
  beforeEach(() => {
    startThrows = false; frameThrows = false
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('VideoFrame', FakeFrame)
    const track = { stop: vi.fn(), requestFrame: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    ;(HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream = () => ({ getVideoTracks: () => [track] })
    window.tangu = { captureRegion: async () => ({ ok: true, data: new Uint8Array(16), width: 2, height: 2 }) } as unknown as typeof window.tangu
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('stop() returns the video; a second recording is busy until then, free afterwards', async () => {
    const { el } = view()
    const rec = await recordPluginElement('demo', el, { fps: 30 })
    await expect(recordPluginElement('demo', el)).rejects.toMatchObject({ code: 'busy' })
    const out = await rec.stop()
    expect(out).toMatchObject({ mime: 'video/mp4;codecs=avc1', stoppedBy: 'stop' })
    expect(out!.bytes.length).toBe(3)
    expect(await rec.stop()).toBe(out)
    const again = await recordPluginElement('demo', el)
    again.cancel()
    expect(await again.done).toBeNull()
  })

  it('an encoder that fails to start rejects and does not leave the window busy', async () => {
    const { el } = view()
    startThrows = true
    await expect(recordPluginElement('demo', el)).rejects.toThrow()
    startThrows = false
    const rec = await recordPluginElement('demo', el)
    rec.cancel()
    expect(await rec.done).toBeNull()
  })

  it('a frame that throws mid-recording only drops that frame; maxSeconds still ends it', async () => {
    const { el } = view()
    const rec = await recordPluginElement('demo', el, { fps: 60, maxSeconds: 1 })
    frameThrows = true
    const out = await rec.done
    expect(out).toMatchObject({ stoppedBy: 'maxSeconds' })
    expect(out!.frames).toBe(1)
  })

  it('the plugin being disabled before the first frame rejects disposed and frees the window', async () => {
    const { el } = view()
    window.tangu = { captureRegion: async () => ({ ok: false, code: 'failed' }) } as unknown as typeof window.tangu
    let alive = true
    let cancel: (() => void) | null = null
    const p = recordPluginElement('demo', el, {}, { alive: () => alive, own: (c) => { cancel = c; return Object.assign(() => c(), { forget() {} }) } })
    alive = false; cancel!()
    await expect(p).rejects.toMatchObject({ code: 'disposed' })
    window.tangu = { captureRegion: async () => ({ ok: true, data: new Uint8Array(16), width: 2, height: 2 }) } as unknown as typeof window.tangu
    const rec = await recordPluginElement('demo', el)
    rec.cancel()
    await rec.done
  })

  it('holds the last frame while the element is smaller than the locked frame (no neighbours in the crop)', async () => {
    const { el } = view()
    const bridge = vi.fn(async (_req: unknown) => ({ ok: true as const, data: new Uint8Array(16), width: 2, height: 2 }))
    window.tangu = { captureRegion: bridge } as unknown as typeof window.tangu
    const rec = await recordPluginElement('demo', el, { fps: 60 })
    expect(bridge.mock.calls[0][0]).toMatchObject({ format: 'bgra', size: expect.objectContaining({ width: expect.any(Number) }) })
    place(el, { left: 100, top: 100, width: 200, height: 300 }) // shrank
    await new Promise((r) => setTimeout(r, 30))
    const calls = bridge.mock.calls.length
    await new Promise((r) => setTimeout(r, 120))
    expect(bridge.mock.calls.length).toBe(calls)
    rec.cancel()
    await rec.done
  })

  it('an encoder error ends the recording with null, not an empty "video"', async () => {
    const { el } = view()
    const rec = await recordPluginElement('demo', el)
    const r = (globalThis as unknown as { __lastRecorder?: { onerror: (() => void) | null } }).__lastRecorder
    r!.onerror!()
    expect(await rec.done).toBeNull()
    expect(await rec.stop()).toBeNull()
  })

  it('a cancel that arrives while stop() is finishing still discards the video', async () => {
    const { el } = view()
    const rec = await recordPluginElement('demo', el)
    const out = rec.stop()
    rec.cancel()
    expect(await out).toBeNull()
  })

  it('an unknown mimeType is unsupported', async () => {
    const { el } = view()
    await expect(recordPluginElement('demo', el, { mimeType: 'video/x-nope' })).rejects.toMatchObject({ code: 'unsupported' })
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
