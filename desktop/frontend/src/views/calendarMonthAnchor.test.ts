// @vitest-environment happy-dom
/**
 * 改「一周开始于」后月视图保持当前可见月份(Codex 第一轮 D-1):CalendarView 按周首日给 MonthScroll 换 key 整块重挂,
 * 以前重挂一律滚回今天所在月。现在父组件持有 anchorRef(当前看的月),重挂后回到那个月。
 */
import React, { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MonthScroll, type CalApi, type MonthAnchor } from './CalendarView'
import { useWeekStartPref } from './calendar/dateUtils'

let host: HTMLDivElement
let root: Root
// happy-dom 不排版、尺寸全是 0;MonthScroll 把 0 尺寸当「摘下期间」不改行高(fix/calendar-tab-back),这里给容器一个排好版的尺寸
const sizes = { clientHeight: 720, clientWidth: 960 }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  if (!('ResizeObserver' in globalThis)) vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  for (const [k, v] of Object.entries(sizes)) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); useWeekStartPref.getState().setPref('auto')
  for (const k of Object.keys(sizes)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
})

async function mount(anchorRef: { current: MonthAnchor | null }, key: string): Promise<HTMLSpanElement> {
  const titleRef = createRef<HTMLSpanElement>()
  const title = document.createElement('span')
  ;(titleRef as { current: HTMLSpanElement | null }).current = title
  await act(async () => root.render(React.createElement(MonthScroll, {
    key, anchorRef, titleRef, events: [], selectedKey: null, onPick: () => {}, onCreate: () => {},
    canCreate: false, onDismiss: () => false, onDraft: () => {}, colorOf: () => '',
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

// 1 号落在一周后半段时,滚到月份那一行的同时标题也要是这个月(2026-11-01 周日、周一开始的一周:曾停在 10 月,「下个月」也卡住)
it('1 号落在周末:今天的那一行在顶上,标题是今天所在月,「下个月」能翻过去', async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 1, 12), toFake: ['Date'] })
  try {
    useWeekStartPref.getState().setPref(1)
    const anchorRef: { current: MonthAnchor | null } = { current: null }
    const api = createRef<CalApi>()
    const titleRef = { current: document.createElement('span') }
    await act(async () => root.render(React.createElement(MonthScroll, {
      ref: api, anchorRef, titleRef, events: [], selectedKey: null, onPick: () => {}, onCreate: () => {},
      canCreate: false, onDismiss: () => false, onDraft: () => {}, colorOf: () => '',
    })))
    const el = host.querySelector<HTMLElement>('.amx-cal-mscroll')!
    const rowH = (720 - 26) / 6
    expect(anchorRef.current).toEqual({ y: 2026, m: 10 })
    const top = el.scrollTop
    const dates = [...host.querySelectorAll('[data-date]')].map((c) => c.getAttribute('data-date'))
    expect(dates[Math.round(top / rowH) * 7 + 6]).toBe('2026-11-01') // 今天这一行就在顶上,没被滚出去
    const jumped: number[] = []
    el.scrollTo = ((o: ScrollToOptions) => { jumped.push(o.top!); el.scrollTop = o.top! }) as typeof el.scrollTo
    await act(async () => { api.current!.next(); el.dispatchEvent(new Event('scroll')) })
    expect(anchorRef.current).toEqual({ y: 2026, m: 11 })
  } finally { vi.useRealTimers() }
})
