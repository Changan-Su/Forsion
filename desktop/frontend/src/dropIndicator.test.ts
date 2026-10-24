// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDropIndicator, dropHide, dropRetarget } from '@lcl/engine/dropIndicator'

// happy-dom 没有 Web Animations:记下每次 animate,finished 立即兑现
let calls: Array<{ el: HTMLElement; frames: Keyframe[] }> = []
beforeEach(() => {
  document.body.innerHTML = ''
  calls = []
  ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: HTMLElement, frames: Keyframe[]) {
    calls.push({ el: this, frames })
    return { finished: Promise.resolve() }
  }
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})

const line = (): HTMLDivElement => {
  const el = document.createElement('div')
  el.className = 'unified-drop-line'
  document.body.appendChild(el)
  return el
}
const ghosts = (): Element[] => [...document.querySelectorAll('.lcl-drop-ghost')]

describe('dropRetarget', () => {
  it('第一次出现:淡入并从左端展开,不留影子', () => {
    const el = line()
    dropRetarget(el, 'a')
    expect(ghosts()).toHaveLength(0)
    expect(calls[0].frames[0]).toMatchObject({ opacity: 0, scale: '.6 1' })
    expect(el.style.transformOrigin).toBe('left center')
  })
  it('同一个落点只是坐标变了:什么都不做', () => {
    const el = line()
    dropRetarget(el, 'a')
    dropRetarget(el, 'a')
    expect(calls).toHaveLength(1)
    expect(ghosts()).toHaveLength(0)
  })
  it('换落点:旧样子留一份淡出(不带原类名,仪器数不到它),新的淡入', async () => {
    const el = line()
    el.style.transform = 'translate(10px, 20px)'
    dropRetarget(el, 'a')
    dropRetarget(el, 'b')
    const g = ghosts()
    expect(g).toHaveLength(1)
    expect(g[0].classList.contains('unified-drop-line')).toBe(false)
    expect((g[0] as HTMLElement).style.transform).toBe('translate(10px, 20px)')
    expect(document.querySelectorAll('.unified-drop-line')).toHaveLength(1)
    await Promise.resolve(); await Promise.resolve()
    expect(ghosts()).toHaveLength(0) // 淡完就删
  })
  it('竖线明说 axis:从上端展开', () => {
    const el = line()
    dropRetarget(el, 'a', { axis: 'v' })
    expect(calls[0].frames[0]).toMatchObject({ scale: '1 .6' })
    expect(el.style.transformOrigin).toBe('center top')
  })
  it('藏起来:留一份淡出、display:none;再出现算新落点', () => {
    const el = line()
    dropRetarget(el, 'a')
    dropHide(el)
    expect(el.style.display).toBe('none')
    expect(ghosts()).toHaveLength(1)
    calls = []
    el.style.display = ''
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000) // 过了 80ms 才回来
    dropRetarget(el, 'a')
    vi.restoreAllMocks()
    expect(calls).toHaveLength(1) // key 一样也重新淡入
  })
  it('藏了又马上以同一个落点画回来(编辑器同一拍先藏后画):撤掉影子、不重播淡入', () => {
    const el = line()
    dropRetarget(el, 'a')
    dropHide(el)
    expect(ghosts()).toHaveLength(1)
    calls = [] // 影子自己的淡出不算
    el.style.display = 'block'
    dropRetarget(el, 'a')
    expect(ghosts()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
  it('藏了马上画到别的落点:影子留着淡出,新的淡入', () => {
    const el = line()
    dropRetarget(el, 'a')
    dropHide(el)
    el.style.display = 'block'
    calls = []
    dropRetarget(el, 'b')
    expect(ghosts()).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
  it('系统关了动效:不动画、不留影子', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const el = line()
    dropRetarget(el, 'a')
    dropRetarget(el, 'b')
    dropHide(el)
    expect(calls).toHaveLength(0)
    expect(ghosts()).toHaveLength(0)
  })
})

describe('createDropIndicator', () => {
  it('host 还没挂进文档:反复画也只有一个元素,销毁后一个不剩(连淡出中的影子)', () => {
    const host = document.createElement('div')
    const d = createDropIndicator({ host })
    d.line({ x: 0, y: 0, w: 10 }); d.line({ x: 0, y: 5, w: 10 }); d.line({ x: 0, y: 9, w: 10 })
    expect(host.querySelectorAll('.lcl-drop-ind')).toHaveLength(1)
    d.destroy()
    expect(host.children).toHaveLength(0)
  })
  it('线换成描边:影子是旧的那根线,不是描边', () => {
    const d = createDropIndicator()
    d.line({ x: 0, y: 10, w: 100 })
    d.zone({ x: 0, y: 0, w: 50, h: 30 })
    const g = ghosts()[0] as HTMLElement
    expect(g.style.width).toBe('100px')
    d.destroy()
    expect(ghosts(), '销毁时影子一起收').toHaveLength(0)
  })

  it('线 / 描边按视口坐标落位,换形状算换落点,destroy 收走元素', () => {
    const d = createDropIndicator({ className: 'my-drop' })
    d.line({ x: 10, y: 20, w: 100 })
    const el = document.querySelector('.lcl-drop-ind.my-drop') as HTMLElement
    expect(el.style.display).toBe('block')
    expect([el.style.left, el.style.top, el.style.width]).toEqual(['10px', '20px', '100px'])
    d.line({ x: 10, y: 20, w: 100 })
    expect(ghosts()).toHaveLength(0)
    d.zone({ x: 0, y: 0, w: 50, h: 30 })
    expect(el.classList.contains('lcl-drop-ind--zone')).toBe(true)
    expect(ghosts()).toHaveLength(1)
    d.hide()
    expect(el.style.display).toBe('none')
    d.destroy()
    expect(document.querySelector('.lcl-drop-ind')).toBeNull()
  })
  it('给了 key:同一个落点换坐标(滚动)直接跟,不淡入', () => {
    const d = createDropIndicator()
    d.line({ x: 0, y: 100, w: 50 }, { key: 'row-3' })
    calls = []
    d.line({ x: 0, y: 60, w: 50 }, { key: 'row-3' })
    expect(calls).toHaveLength(0)
    expect((document.querySelector('.lcl-drop-ind') as HTMLElement).style.top).toBe('60px')
  })
})
