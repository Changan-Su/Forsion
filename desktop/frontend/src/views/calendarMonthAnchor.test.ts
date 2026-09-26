// @vitest-environment happy-dom
/**
 * 改「一周开始于」后月视图保持当前可见月份(Codex 第一轮 D-1):CalendarView 按周首日给 MonthScroll 换 key 整块重挂,
 * 以前重挂一律滚回今天所在月。现在父组件持有 anchorRef(当前看的月),重挂后回到那个月。
 */
import React, { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MonthScroll, type MonthAnchor } from './CalendarView'
import { useWeekStartPref } from './calendar/dateUtils'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  if (!('ResizeObserver' in globalThis)) vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); useWeekStartPref.getState().setPref('auto') })

async function mount(anchorRef: { current: MonthAnchor | null }, key: string): Promise<HTMLSpanElement> {
  const titleRef = createRef<HTMLSpanElement>()
  const title = document.createElement('span')
  ;(titleRef as { current: HTMLSpanElement | null }).current = title
  await act(async () => root.render(React.createElement(MonthScroll, {
    key, anchorRef, titleRef, events: [], selectedKey: null, onPick: () => {}, onCreate: () => {},
  })))
  return title
}

it('周首日变化重挂后,仍停在重挂前看的那个月(不跳回今天)', async () => {
  const today = new Date()
  const target = new Date(today.getFullYear(), today.getMonth() + 5, 1) // 离今天 5 个月的某月
  const anchorRef: { current: MonthAnchor | null } = { current: null }
  useWeekStartPref.getState().setPref(1)
  await mount(anchorRef, 'dow1')
  expect(anchorRef.current).toEqual({ y: today.getFullYear(), m: today.getMonth() }) // 首挂 = 今天所在月
  // 用户翻到 target 月(模拟:锚点就是滚动时写入的那一份)
  anchorRef.current = { y: target.getFullYear(), m: target.getMonth() }
  useWeekStartPref.getState().setPref(0)
  const title = await mount(anchorRef, 'dow0') // CalendarView 按周首日换 key → 重挂
  expect(anchorRef.current).toEqual({ y: target.getFullYear(), m: target.getMonth() })
  expect(title.textContent).toBeTruthy()
})

it('没有锚点时照旧落在今天所在月', async () => {
  const today = new Date()
  const anchorRef: { current: MonthAnchor | null } = { current: null }
  await mount(anchorRef, 'dow-auto')
  expect(anchorRef.current).toEqual({ y: today.getFullYear(), m: today.getMonth() })
})
