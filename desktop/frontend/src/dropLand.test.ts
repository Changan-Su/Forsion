// @vitest-environment happy-dom
// 松手落位(LCL dropIndicator.ts 的 land / landWhenMoved,借鉴 Comma 方案 2.5):纯位移计算(含界面缩放)、
// 减少动态效果直接到位、内联样式飞完原样还回去、异步重渲时等元素换了地方才落。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { dragGrab, land, landCancel, landOffset, landWhenMoved, releasePoint, LAND_MS } from '@lcl/engine/dropIndicator'

let reduce = false
beforeEach(() => {
  document.body.innerHTML = ''
  reduce = false
  vi.stubGlobal('matchMedia', () => ({ matches: reduce }))
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const xy = (t: string): number[] => (t.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\)/) || []).slice(1).map(Number)

/** happy-dom 不排版:每个元素的视口矩形由测试给,transform 不参与(只验写进去的值)。 */
const box = (rect: { x: number; y: number; w?: number; h?: number }, zoom = 1): HTMLDivElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  el.getBoundingClientRect = () => ({ left: rect.x, top: rect.y, x: rect.x, y: rect.y, width: rect.w ?? 200, height: rect.h ?? 28, right: rect.x + (rect.w ?? 200), bottom: rect.y + (rect.h ?? 28), toJSON() {} }) as DOMRect
  ;(el as unknown as { currentCSSZoom: number }).currentCSSZoom = zoom
  return el
}

describe('landOffset', () => {
  it('视口位移 ÷ 有效缩放 = 写进 translate 的局部 px', () => {
    expect(landOffset({ x: 30, y: 200 }, { x: 10, y: 90 })).toEqual({ dx: 20, dy: 110 })
    const z = landOffset({ x: 32, y: 211 }, { x: 10, y: 90 }, 1.1)
    expect(z.dx).toBeCloseTo(20)
    expect(z.dy).toBeCloseTo(110)
  })
  it('缩放给成 0 / NaN 当 1', () => {
    expect(landOffset({ x: 5, y: 5 }, { x: 0, y: 0 }, 0)).toEqual({ dx: 5, dy: 5 })
    expect(landOffset({ x: 5, y: 5 }, { x: 0, y: 0 }, Number.NaN)).toEqual({ dx: 5, dy: 5 })
  })
  it('松手处 = 指针 − 拖起时指针在元素里的位置(拖影左上角)', () => {
    const el = box({ x: 100, y: 40 })
    const grab = dragGrab(el, { clientX: 130, clientY: 50 })
    expect(grab).toEqual({ x: 30, y: 10 })
    expect(releasePoint({ clientX: 160, clientY: 300 }, grab)).toEqual({ x: 130, y: 290 })
  })
})

describe('land', () => {
  it('反向位移到松手处、带阴影,然后过渡回原样;飞完内联样式全部还回去', () => {
    const el = box({ x: 10, y: 90 })
    el.style.transition = 'opacity 1s'
    const r = land(el, { x: 30, y: 200 })
    expect(r).toEqual({ dx: 20, dy: 110 })
    // go() 之后:transform 回到原值(空 = 交还样式表),transition 换成落位那条,阴影淡回原值
    expect(el.style.transform).toBe('')
    expect(el.style.transition).toContain('transform var(--lcl-land, 160ms)')
    expect(el.style.boxShadow).toBe('')
    vi.advanceTimersByTime(LAND_MS + 100)
    expect(el.style.transition).toBe('opacity 1s')
    expect(el.style.transform).toBe('')
  })
  it('起飞那一帧写的是反向位移 + 统一阴影 token(在 go() 之前量)', () => {
    const el = box({ x: 10, y: 90 }, 1.1)
    const seen: string[] = []
    const real = el.getBoundingClientRect.bind(el)
    let n = 0
    el.getBoundingClientRect = () => { if (n++ === 1) seen.push(el.style.transform, el.style.boxShadow, el.style.transition); return real() }
    land(el, { x: 32, y: 211 })
    const [dx, dy] = xy(seen[0])
    expect(dx).toBeCloseTo(20) // 22 视口 px ÷ 1.1
    expect(dy).toBeCloseTo(110)
    expect(seen[1]).toBe('var(--card-shadow)')
    expect(seen[2]).toBe('none')
  })
  it('元素原本就有内联 transform:位移叠在前面,飞完回到它自己的', () => {
    const el = box({ x: 0, y: 0 })
    el.style.transform = 'scale(0.5)'
    let start = ''
    const real = el.getBoundingClientRect.bind(el)
    let n = 0
    el.getBoundingClientRect = () => { if (n++ === 1) start = el.style.transform; return real() }
    land(el, { x: 0, y: 50 })
    expect(start).toBe('translate(0px, 50px) scale(0.5)')
    expect(el.style.transform).toBe('scale(0.5)')
    vi.advanceTimersByTime(LAND_MS + 100)
    expect(el.style.transform).toBe('scale(0.5)')
  })
  it('减少动态效果:直接到位,一个内联样式都不写', () => {
    reduce = true
    const el = box({ x: 10, y: 90 })
    expect(land(el, { x: 30, y: 200 })).toBeNull()
    expect(el.getAttribute('style')).toBeNull()
  })
  it('没动(不到 1px)、没尺寸、不在文档里:什么都不做', () => {
    expect(land(box({ x: 10, y: 10 }), { x: 10.4, y: 10.6 })).toBeNull()
    expect(land(box({ x: 10, y: 10, w: 0, h: 0 }), { x: 50, y: 50 })).toBeNull()
    const off = box({ x: 0, y: 0 }); off.remove()
    expect(land(off, { x: 50, y: 50 })).toBeNull()
  })
  it('同伴(展开的那块会话)走同一段视口位移、不带阴影;放开的裁剪容器飞完还原', () => {
    const el = box({ x: 0, y: 100 })
    const kids = box({ x: 0, y: 128 }, 1.1)
    const clip = box({ x: 0, y: 0 })
    clip.style.overflow = 'clip'
    const starts: string[] = []
    const real = el.getBoundingClientRect.bind(el)
    let n = 0
    el.getBoundingClientRect = () => { if (n++ === 1) starts.push(kids.style.transform, kids.style.boxShadow, clip.style.overflow); return real() }
    land(el, { x: 0, y: 155 }, { with: [kids], unclip: [clip] })
    const [kx, ky] = xy(starts[0])
    expect(kx).toBe(0)
    expect(ky).toBeCloseTo(50) // 55 视口 px ÷ 1.1
    expect(starts[1]).toBe('')
    expect(starts[2]).toBe('visible')
    expect(kids.style.transition).toContain('transform')
    vi.advanceTimersByTime(LAND_MS + 100)
    expect(clip.style.overflow).toBe('clip')
    expect(kids.style.transition).toBe('')
  })
  it('飞到一半又落一次 / 取消:先把上一次的内联样式还回去', () => {
    const el = box({ x: 0, y: 0 })
    el.style.zIndex = '3'
    land(el, { x: 0, y: 40 })
    landCancel(el)
    expect(el.style.transition).toBe('')
    expect(el.style.zIndex).toBe('3')
  })
})

describe('landWhenMoved', () => {
  const frames = (): (() => void) => {
    const q: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { q.push(cb); return q.length })
    vi.stubGlobal('cancelAnimationFrame', () => { q.length = 0 })
    return () => { const cbs = q.splice(0); for (const cb of cbs) cb(performance.now()) }
  }
  it('异步重渲:元素重新挂载(换了一个)才落;之前每帧只是等', () => {
    const step = frames()
    const list = document.createElement('ul'); document.body.appendChild(list)
    const old = box({ x: 0, y: 0 }); list.appendChild(old); old.dataset.k = 'a'
    const onMoved = vi.fn()
    landWhenMoved(() => document.querySelector<HTMLElement>('[data-k="a"]'), { x: 0, y: 60 }, { onMoved })
    step(); step()
    expect(onMoved).not.toHaveBeenCalled()
    old.remove()
    step()
    expect(onMoved).not.toHaveBeenCalled() // 旧的摘了、新的还没来
    const fresh = box({ x: 0, y: 30 }); fresh.dataset.k = 'a'
    const other = document.createElement('ul'); document.body.appendChild(other); other.appendChild(fresh)
    step()
    expect(onMoved).toHaveBeenCalledWith(fresh)
  })
  it('同一个元素被挪动(前一个兄弟变了)也算;一直没动到点就作罢', () => {
    const step = frames()
    const list = document.createElement('div'); document.body.appendChild(list)
    const a = box({ x: 0, y: 0 }); const b = box({ x: 0, y: 28 })
    list.append(a, b)
    const onMoved = vi.fn()
    landWhenMoved(() => b, { x: 0, y: 0 }, { onMoved })
    step()
    expect(onMoved).not.toHaveBeenCalled()
    list.insertBefore(b, a)
    step()
    expect(onMoved).toHaveBeenCalledWith(b)

    const late = vi.fn()
    landWhenMoved(() => a, { x: 0, y: 0 }, { onMoved: late, timeout: 0 })
    step() // 到点:没动 → 不再排帧
    list.insertBefore(a, b) // 过了时限才挪(不相干的重渲),不算这一次拖放的
    step(); step()
    expect(late).not.toHaveBeenCalled()
  })
  it('减少动态效果:不排帧', () => {
    reduce = true
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    landWhenMoved(() => box({ x: 0, y: 0 }), { x: 0, y: 50 })
    expect(raf).not.toHaveBeenCalled()
  })
})
