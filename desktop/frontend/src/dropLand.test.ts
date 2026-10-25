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
  // 落位在下一帧起跑:这里的 rAF 直接同步执行(要验「起跑前」的那个用例自己换掉它)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
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

describe('land 起跑时机', () => {
  it('反向位移当场写上(这一帧画在松手处),过渡等下一帧的 rAF 才起跑;起跑前取消也能还原', () => {
    const q: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { q.push(cb); return q.length })
    const el = box({ x: 0, y: 0 })
    land(el, { x: 0, y: 40 })
    expect(el.style.transform).toBe('translate(0px, 40px)')
    expect(el.style.transition).toBe('none')
    q.shift()!(0)
    expect(el.style.transform).toBe('')
    expect(el.style.transition).toContain('transform')
    const el2 = box({ x: 0, y: 0 })
    land(el2, { x: 0, y: 40 })
    landCancel(el2)
    expect(el2.style.transform).toBe('')
    expect(el2.style.transition).toBe('')
  })
})

describe('landWhenMoved', () => {
  /** MutationObserver 在微任务里报:让出一拍。 */
  const flush = async (): Promise<void> => { for (let i = 0; i < 3; i++) await Promise.resolve() }
  it('异步重渲:元素重新挂载(换了一个)才落;之前的增删只是等', async () => {
    const list = document.createElement('ul'); document.body.appendChild(list)
    const old = box({ x: 0, y: 0 }); list.appendChild(old); old.dataset.k = 'a'
    const onMoved = vi.fn()
    landWhenMoved(() => document.querySelector<HTMLElement>('[data-k="a"]'), { x: 0, y: 60 }, { onMoved })
    list.appendChild(document.createElement('li')) // 不相干的增删
    await flush()
    expect(onMoved).not.toHaveBeenCalled()
    old.remove()
    await flush()
    expect(onMoved).not.toHaveBeenCalled() // 旧的摘了、新的还没来
    const fresh = box({ x: 0, y: 30 }); fresh.dataset.k = 'a'
    const other = document.createElement('ul'); document.body.appendChild(other); other.appendChild(fresh)
    await flush()
    expect(onMoved).toHaveBeenCalledTimes(1)
    expect(onMoved).toHaveBeenCalledWith(fresh)
  })
  it('同一个元素被挪动(前一个兄弟变了)也算,而且在下一帧之前就发现(不靠轮询 rAF)', async () => {
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    const list = document.createElement('div'); document.body.appendChild(list)
    const a = box({ x: 0, y: 0 }); const b = box({ x: 0, y: 28 })
    list.append(a, b)
    const onMoved = vi.fn()
    landWhenMoved(() => b, { x: 0, y: 0 }, { onMoved })
    list.insertBefore(b, a)
    await flush()
    expect(onMoved).toHaveBeenCalledWith(b)
    expect(raf).not.toHaveBeenCalled()
  })
  it('到点没动就作罢;取消之后也不落', async () => {
    const list = document.createElement('div'); document.body.appendChild(list)
    const a = box({ x: 0, y: 0 }); const b = box({ x: 0, y: 28 })
    list.append(a, b)
    const late = vi.fn()
    landWhenMoved(() => a, { x: 0, y: 0 }, { onMoved: late, timeout: 50 })
    vi.advanceTimersByTime(60)
    list.insertBefore(b, a) // 过了时限才挪(不相干的重渲),不算这一次拖放的
    await flush()
    expect(late).not.toHaveBeenCalled()
    const cancelled = vi.fn()
    const stop = landWhenMoved(() => b, { x: 0, y: 0 }, { onMoved: cancelled })
    stop()
    list.insertBefore(a, b)
    await flush()
    expect(cancelled).not.toHaveBeenCalled()
  })
  it('减少动态效果:不观察', async () => {
    reduce = true
    const onMoved = vi.fn()
    const list = document.createElement('div'); document.body.appendChild(list)
    const a = box({ x: 0, y: 0 }); const b = box({ x: 0, y: 28 }); list.append(a, b)
    landWhenMoved(() => b, { x: 0, y: 50 }, { onMoved })
    list.insertBefore(b, a)
    await flush()
    expect(onMoved).not.toHaveBeenCalled()
  })
})

describe('unclip 记数', () => {
  it('两段飞行同时穿过同一个折叠容器:第一段落定不提前裁掉,最后一段落定才还原成原值', () => {
    const clip = box({ x: 0, y: 0 }); clip.style.overflow = 'clip'
    const r1 = box({ x: 0, y: 0 }); const r2 = box({ x: 0, y: 40 })
    land(r1, { x: 0, y: 100 }, { unclip: [clip] })
    vi.advanceTimersByTime(100)
    land(r2, { x: 0, y: 140 }, { unclip: [clip] })
    vi.advanceTimersByTime(LAND_MS + 10) // r1 落定,r2 还在飞
    expect(clip.style.overflow).toBe('visible')
    vi.advanceTimersByTime(200)
    expect(clip.style.overflow).toBe('clip')
  })
})
