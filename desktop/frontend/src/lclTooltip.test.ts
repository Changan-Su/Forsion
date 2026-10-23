// @vitest-environment happy-dom
/**
 * (放在 desktop 下:lcl 目录里的测试只跑 node 环境,DOM 环境的从这里经 @lcl 别名进。)
 * 提示框时序(借鉴 Comma 方案 §4):300ms 才出、相邻接力不重播、离开 80ms 宽限后收、键盘聚焦不做动画、按下即收且不再弹。
 * 负对照(实跑):把 enter() 里「弹着就接力」那一行删掉 → 「接力」红;leave() 不等宽限直接收 → 「宽限里回来」红。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachTooltip, hideTooltip, placeHover } from '@lcl/engine/hoverSurface'

const tip = () => document.querySelector<HTMLElement>('.lcl-tip')
const open = () => !!tip()?.hasAttribute('data-open')
let a: HTMLElement
let b: HTMLElement
let handles: { dispose(): void }[] = []

beforeEach(() => {
  vi.useFakeTimers()
  a = document.createElement('button')
  b = document.createElement('button')
  document.body.append(a, b)
  handles = [attachTooltip(a, 'Alpha'), attachTooltip(b, ['Beta', 'secondary'])]
})
afterEach(() => {
  hideTooltip()
  for (const h of handles) h.dispose()
  a.remove()
  b.remove()
  vi.useRealTimers()
})

const fire = (el: HTMLElement, type: string) => el.dispatchEvent(new MouseEvent(type))

it('停够 300ms 才出,内容是那一行', async () => {
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(200)
  expect(open()).toBe(false)
  await vi.advanceTimersByTimeAsync(120)
  expect(open()).toBe(true)
  expect(tip()!.textContent).toBe('Alpha')
  expect(tip()!.getAttribute('role')).toBe('tooltip')
})

it('接力:弹着移到相邻触发点,同一张浮层直接换过去、这一帧不过渡', async () => {
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(320)
  const first = tip()
  fire(a, 'mouseleave')
  fire(b, 'mouseenter')
  await vi.advanceTimersByTimeAsync(0)
  expect(tip()).toBe(first)
  expect(open()).toBe(true)
  expect(tip()!.hasAttribute('data-instant')).toBe(true)
  expect([...tip()!.children].map((c) => c.textContent)).toEqual(['Beta', 'secondary'])
  expect(tip()!.firstElementChild!.className).toBe('lcl-tip-head')
})

it('离开后有 80ms 宽限:宽限里回来不收;过了宽限才收并摘掉', async () => {
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(320)
  fire(a, 'mouseleave')
  await vi.advanceTimersByTimeAsync(40)
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(200)
  expect(open()).toBe(true)
  fire(a, 'mouseleave')
  await vi.advanceTimersByTimeAsync(100)
  expect(tip()).toBeNull()
})

it('路过不弹:没等够就离开,之后也不出', async () => {
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(150)
  fire(a, 'mouseleave')
  await vi.advanceTimersByTimeAsync(500)
  expect(tip()).toBeNull()
})

it('键盘聚焦立刻出、不做动画;失焦收', async () => {
  a.matches = ((sel: string) => sel === ':focus-visible') as typeof a.matches
  a.dispatchEvent(new FocusEvent('focus'))
  await vi.advanceTimersByTimeAsync(0)
  expect(open()).toBe(true)
  expect(tip()!.hasAttribute('data-instant')).toBe(true)
  a.dispatchEvent(new FocusEvent('blur'))
  await vi.advanceTimersByTimeAsync(0)
  expect(tip()).toBeNull()
})

it('鼠标点出来的焦点不弹', async () => {
  a.matches = (() => false) as typeof a.matches
  a.dispatchEvent(new FocusEvent('focus'))
  await vi.advanceTimersByTimeAsync(500)
  expect(tip()).toBeNull()
})

it('按下即收;指针还停在原处不再弹,移开再回来才重新计时', async () => {
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(320)
  fire(a, 'mousedown')
  await vi.advanceTimersByTimeAsync(0)
  expect(tip()).toBeNull()
  fire(a, 'mouseenter') // 同一次停留里的重复进入(React 重渲染、子元素进出)
  await vi.advanceTimersByTimeAsync(500)
  expect(tip()).toBeNull()
  fire(a, 'mouseleave')
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(320)
  expect(open()).toBe(true)
})

it('update 换字:弹着就原地换;dispose 收掉', async () => {
  const h = attachTooltip(a, 'x')
  handles.push(h)
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(320)
  h.update('Renamed')
  await vi.advanceTimersByTimeAsync(0)
  expect(tip()!.textContent).toBe('Renamed')
  h.dispose()
  await vi.advanceTimersByTimeAsync(0)
  expect(tip()).toBeNull()
})

it('placeHover:首选方向放不下就翻面,横向夹进视口', () => {
  const near = { left: 100, right: 140, top: 4, bottom: 24 }
  expect(placeHover(near, 80, 24, 1000, 800, 'top').side).toBe('bottom')
  expect(placeHover({ left: 960, right: 990, top: 300, bottom: 320 }, 120, 24, 1000, 800, 'right').side).toBe('left')
  const p = placeHover({ left: 0, right: 20, top: 300, bottom: 320 }, 200, 24, 1000, 800, 'top')
  expect(p.left).toBe(8)
})

it('弹着移到一个这次不出提示的元素:不一下子消失,宽限后才收;宽限里再到有提示的照样接力', async () => {
  const empty = document.createElement('button')
  document.body.append(empty)
  handles.push(attachTooltip(empty, () => null))
  fire(a, 'mouseenter')
  await vi.advanceTimersByTimeAsync(320)
  fire(a, 'mouseleave')
  fire(empty, 'mouseenter')
  await vi.advanceTimersByTimeAsync(40)
  expect(open()).toBe(true)
  fire(empty, 'mouseleave')
  fire(b, 'mouseenter')
  await vi.advanceTimersByTimeAsync(0)
  expect(open()).toBe(true)
  expect(tip()!.firstElementChild!.textContent).toBe('Beta')
  empty.remove()
})
