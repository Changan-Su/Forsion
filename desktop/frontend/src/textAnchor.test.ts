// @vitest-environment happy-dom
/** 文字锚点(lcl/engine/textAnchor.ts,划线菜单方案 B):那段字在哪、看不看得见、没了没有。
 *  happy-dom 没有排版:几何由测试按「文本节点 → 矩形」打桩;滚动祖先的可见区由 overflow + 元素矩形算(和真浏览器同一段代码)。
 *  放在 desktop 下:lcl/ 里的测试不能用 happy-dom 文档块(见 lcl/engine/nativeSheet.test.ts 头注)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rangeAnchor, rectAnchor } from '@lcl/engine'

type R = { left: number; top: number; right: number; bottom: number }
const box = (r: R): DOMRect => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r }) as DOMRect

let textRect: R
let scrollerRect: R
let owner: HTMLElement
let scroller: HTMLElement
let text: Text

beforeEach(() => {
  textRect = { left: 100, top: 200, right: 300, bottom: 218 }
  scrollerRect = { left: 0, top: 100, right: 800, bottom: 600 }
  document.body.innerHTML = '<div id="owner"><div id="scroller" style="overflow-y:auto"><p id="p">同步点选这里最稳</p></div></div>'
  owner = document.getElementById('owner')!
  scroller = document.getElementById('scroller')!
  text = document.getElementById('p')!.firstChild as Text
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
    return box(this.startContainer === text ? textRect : { left: 0, top: 0, right: 0, bottom: 0 })
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return box(this === scroller ? scrollerRect : { left: 0, top: 0, right: 1000, bottom: 800 })
  })
  // 有盒子 = 在文档里;摘下来就没有(Dockview 换标签时就是这样)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.isConnected ? [box({ left: 0, top: 0, right: 1, bottom: 1 })] : []) as unknown as DOMRectList
  })
  for (const k of ['offsetWidth', 'clientWidth'] as const) vi.spyOn(HTMLElement.prototype, k, 'get').mockImplementation(function (this: HTMLElement) { return this === scroller ? 800 : 1000 })
  for (const k of ['offsetHeight', 'clientHeight'] as const) vi.spyOn(HTMLElement.prototype, k, 'get').mockImplementation(function (this: HTMLElement) { return this === scroller ? 500 : 800 })
})
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

const selectText = (): Range => { const r = document.createRange(); r.setStart(text, 0); r.setEnd(text, 4); return r }

describe('rangeAnchor', () => {
  it('跟着那段字:矩形变了 read() 就是新位置', () => {
    const a = rangeAnchor(owner, selectText())
    expect(a.read()).toEqual(textRect)
    textRect = { left: 100, top: 310, right: 300, bottom: 328 } // 往上滚了 110px 的反方向
    expect(a.read()).toEqual(textRect)
    a.dispose()
  })
  it('滚出滚动容器的可见区:看不见(null),不算没了;只露一角按露出来的那块摆', () => {
    const a = rangeAnchor(owner, selectText())
    textRect = { left: 100, top: 60, right: 300, bottom: 78 } // 整个在 scroller 上沿(100)之上
    expect(a.read()).toBeNull()
    expect(a.lost()).toBe(false)
    textRect = { left: 100, top: 90, right: 300, bottom: 108 } // 露出 8px
    expect(a.read()).toEqual({ left: 100, top: 100, right: 300, bottom: 108 })
    textRect = { left: 100, top: 98, right: 300, bottom: 116 }
    expect(a.read()?.top).toBe(100)
    a.dispose()
  })
  it('视图被摘下:看不见;挂回来:按原来那几个节点回到原处(活 Range 会塌缩,锚点记的是节点 + 偏移)', () => {
    const range = selectText()
    const a = rangeAnchor(owner, range)
    const parent = owner.parentNode!
    owner.remove()
    // (真浏览器里此刻活 Range 的端点已塌缩到外面;happy-dom 不实现这条,由 check:selectionbar 在真 Electron 里钉)
    range.setStart(document.body, 0); range.setEnd(document.body, 0) // 照真浏览器那样把它弄塌:锚点不该受影响
    expect(a.read()).toBeNull()
    expect(a.lost()).toBe(false)
    parent.appendChild(owner)
    expect(a.read()).toEqual(textRect)
    a.dispose()
  })
  it('那段字没了(节点被重渲染,owner 还在):lost,onLost 只调一次', async () => {
    const onLost = vi.fn()
    const a = rangeAnchor(owner, selectText(), { onLost })
    document.getElementById('p')!.textContent = '整段换掉了' // 旧文本节点被摘掉
    expect(a.read()).toBeNull()
    expect(a.read()).toBeNull()
    expect(a.lost()).toBe(true)
    await Promise.resolve()
    expect(onLost).toHaveBeenCalledTimes(1)
    a.dispose()
  })
  it('监听等有人订阅才挂、都走了就摘(渲染期建锚点不漏监听)', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const a = rangeAnchor(owner, selectText())
    expect(add.mock.calls.filter(([n]) => n === 'scroll')).toHaveLength(0)
    const u1 = a.subscribe(() => {}), u2 = a.subscribe(() => {})
    expect(add.mock.calls.filter(([n]) => n === 'scroll')).toHaveLength(1)
    u1()
    expect(remove.mock.calls.filter(([n]) => n === 'scroll')).toHaveLength(0)
    u2()
    expect(remove.mock.calls.filter(([n]) => n === 'scroll')).toHaveLength(1)
    a.dispose()
  })
  it('订阅后:滚动一帧只通知一次', async () => {
    const a = rangeAnchor(owner, selectText())
    const fn = vi.fn()
    a.subscribe(fn)
    scroller.dispatchEvent(new Event('scroll'))
    document.dispatchEvent(new Event('scroll'))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => setTimeout(r, 30))
    expect(fn).toHaveBeenCalledTimes(1)
    a.dispose()
  })
})

describe('rectAnchor', () => {
  it('调用方现量:null / 非数 / 抛错都是看不见,不是没了', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let next: R | null | 'throw' = { left: 10, top: 300, right: 60, bottom: 320 }
    const a = rectAnchor(owner, () => { if (next === 'throw') throw new Error('plugin bug'); return next })
    expect(a.read()).toEqual({ left: 10, top: 300, right: 60, bottom: 320 })
    next = null
    expect(a.read()).toBeNull()
    next = { left: NaN, top: 0, right: 1, bottom: 1 }
    expect(a.read()).toBeNull()
    next = 'throw'
    expect(a.read()).toBeNull()
    expect(err).toHaveBeenCalled()
    expect(a.lost()).toBe(false)
    a.dispose()
  })
})
