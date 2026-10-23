// @vitest-environment happy-dom
/**
 * 浮层退场的替身(lcl/engine/menuAnchor.tsx useExitGhost,借鉴 Comma 方案 §4):OverlayAt 卸载那一刻留一份 inert 的拷贝,
 * 放完退场动画再摘;没有退场动画(样式没命中)就立刻摘;父节点一起被拆时落进还在的最近祖先;输入框的值带上。
 * 负对照(2026-10-23 实跑):OverlayAt 里去掉 useExitGhost → 第一、三条红。
 */
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OverlayAt } from '@lcl/engine'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let finish: () => void = () => {}
const proto = HTMLElement.prototype as HTMLElement & { getAnimations?: () => Animation[] }
const original = proto.getAnimations

beforeEach(() => {
  host = document.createElement('div')
  host.className = 'scope'
  document.body.appendChild(host)
  root = createRoot(host)
  // happy-dom 不跑 CSS 动画:命中退场规则 = 有一个还没放完的动画,finish() 放完。
  proto.getAnimations = function (this: HTMLElement) {
    if (!this.hasAttribute('data-lcl-exit') || this.classList.contains('plain')) return []
    return [{ finished: new Promise<void>((r) => { finish = r }) } as unknown as Animation]
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  proto.getAnimations = original
})

const ghosts = () => document.querySelectorAll<HTMLElement>('[data-lcl-exit]')
const render = (node: unknown) => act(() => root.render(node as Parameters<Root['render']>[0]))

it('关掉时留一份 inert 替身,放完退场再摘', async () => {
  await render(h('div', null, h(OverlayAt, { x: 10, y: 10, className: 'ctx-menu', id: 'm' }, h('input', { defaultValue: '' }))))
  document.querySelector<HTMLInputElement>('#m input')!.value = 'typed'
  await render(h('div', null))
  await act(async () => { await Promise.resolve() })
  expect(ghosts().length).toBe(1)
  const g = ghosts()[0]
  expect(g.inert).toBe(true)
  expect(g.getAttribute('aria-hidden')).toBe('true')
  expect(g.id).toBe('')
  expect(g.querySelector('input')!.value).toBe('typed')
  await act(async () => { finish(); await new Promise((r) => setTimeout(r, 0)) })
  expect(ghosts().length).toBe(0)
})

it('样式里没有退场动画:替身立刻摘,等于原样', async () => {
  await render(h(OverlayAt, { x: 0, y: 0, className: 'plain' }))
  await render(null)
  await act(async () => { await Promise.resolve() })
  expect(ghosts().length).toBe(0)
})

it('外面包着的一层一起被拆:替身落进还在的最近祖先(作用域类照旧),拆掉的那层浅拷当壳', async () => {
  await render(h('div', { className: 'keep' }, h('div', { className: 'backdrop' }, h(OverlayAt, { x: 0, y: 0, className: 'ctx-menu' }))))
  await render(h('div', { className: 'keep' }))
  await act(async () => { await Promise.resolve() })
  expect(ghosts().length).toBe(1)
  const shell = ghosts()[0].parentElement!
  expect(shell.className, '拆掉的那层浅拷一份当壳(层叠上下文照旧)').toBe('backdrop')
  expect(shell.style.pointerEvents).toBe('none')
  expect(shell.parentElement!.className).toBe('keep')
  await act(async () => { finish(); await new Promise((r) => setTimeout(r, 0)) })
  expect(document.querySelector('.keep > .backdrop'), '放完连壳一起摘').toBeNull()
})

it('还挂着的(重渲染、没卸载)不留替身', async () => {
  await render(h(OverlayAt, { x: 0, y: 0, className: 'ctx-menu' }))
  await render(h(OverlayAt, { x: 5, y: 5, className: 'ctx-menu' }))
  await act(async () => { await Promise.resolve() })
  expect(ghosts().length).toBe(0)
  vi.restoreAllMocks()
})
