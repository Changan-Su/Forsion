// @vitest-environment happy-dom
// LCL useSegDir(lcl/engine/viewModes.tsx):分段胶囊滑块往哪边拉(水滴复用方案第 4 条)。放在这里是因为 happy-dom 环境下 vitest 读不到 desktop 根外的测试文件。逐帧形状由 desktop 的 check:segstretch 钉,这里只钉方向的记法。
import { StrictMode, act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useSegDir } from '@lcl/engine'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Probe({ i, other }: { i: number; other: number }) {
  return h('div', { 'data-dir': useSegDir(i), 'data-other': other })
}
const render = (i: number, other = 0) => act(() => root.render(h(StrictMode, null, h(Probe, { i, other }))))
const dir = () => host.firstElementChild?.getAttribute('data-dir') ?? null

it('首帧没有方向(两条边一起走);往右 r、往左 l', () => {
  render(0)
  expect(dir()).toBeNull()
  render(2)
  expect(dir()).toBe('r')
  render(1)
  expect(dir()).toBe('l')
  render(3)
  expect(dir()).toBe('r')
})

it('格号没变的重渲染不抹掉方向(StrictMode 双渲染也不记错)', () => {
  render(0)
  render(3)
  render(3, 1)
  expect(dir()).toBe('r')
  render(3, 2)
  expect(dir()).toBe('r')
  render(0, 2)
  expect(dir()).toBe('l')
  render(0, 3)
  expect(dir()).toBe('l')
})
