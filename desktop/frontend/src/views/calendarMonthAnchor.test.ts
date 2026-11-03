// @vitest-environment happy-dom
/**
 * 月视图的落点与标题。一行算它最后一天所在的月(含 1 号的行 = 这个月的第一行),标题、锚点、翻页都认这一条;
 * 改「一周开始于」后保持当前可见月份(Codex 第一轮 D-1):CalendarView 按周首日给 MonthScroll 换 key 整块重挂,
 * 父组件持有 anchorRef(当前看的月),重挂后回到那个月。日期一律钉死,结果不随运行当天变化。
 */
import React, { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MonthScroll, type MonthAnchor } from './CalendarView'
import { monthLabel, useWeekStartPref, type WeekStartPref } from './calendar/dateUtils'

vi.setConfig({ testTimeout: 30_000 }) // 每次挂 81 行,高负载下单条要好几秒

type CalApi = React.ComponentRef<typeof MonthScroll>

let host: HTMLDivElement
let root: Root
// happy-dom 不排版、尺寸全是 0;MonthScroll 把 0 尺寸当「摘下期间」不改行高(fix/calendar-tab-back),这里给容器一个排好版的尺寸
const sizes = { clientHeight: 720, clientWidth: 960 }
const realScrollTo = HTMLElement.prototype.scrollTo
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // happy-dom 的平滑滚动不当场落定,这里让翻页立刻到位并发 scroll
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, o: ScrollToOptions) {
    this.scrollTop = o.top ?? 0
    this.dispatchEvent(new Event('scroll'))
  } as typeof HTMLElement.prototype.scrollTo
  if (!('ResizeObserver' in globalThis)) vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  for (const [k, v] of Object.entries(sizes)) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); useWeekStartPref.getState().setPref('auto')
  HTMLElement.prototype.scrollTo = realScrollTo
  vi.useRealTimers()
  for (const k of Object.keys(sizes)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
})

async function mount(anchorRef: { current: MonthAnchor | null }, key: string, api?: { current: CalApi | null }): Promise<HTMLSpanElement> {
  const titleRef = createRef<HTMLSpanElement>()
  const title = document.createElement('span')
  ;(titleRef as { current: HTMLSpanElement | null }).current = title
  await act(async () => root.render(React.createElement(MonthScroll, {
    key, anchorRef, titleRef, ref: api, events: [], selectedKey: null, onPick: () => {}, onCreate: () => {},
    canCreate: false, onDismiss: () => false, onDraft: () => {}, colorOf: () => '',
  })))
  return title
}

/** 当前顶行的日期 + 屏上 6 行内有没有今天。 */
function viewport(): { first: string; todayShown: boolean } {
  const scroller = host.querySelector<HTMLElement>('.amx-cal-mscroll')!
  const rows = [...host.querySelectorAll<HTMLElement>('.amx-cal-mweek')]
  const top = Math.round(scroller.scrollTop / parseFloat(rows[0].style.height))
  const todayRow = rows.findIndex((row) => row.querySelector('.amx-cal-mcell.today'))
  return { first: rows[top].querySelector<HTMLElement>('.amx-cal-mcell')!.dataset.date!, todayShown: todayRow >= top && todayRow < top + 6 }
}

it.each<[string, Date, WeekStartPref, MonthAnchor, string]>([
  ['月初周日,周一起始:1 号在行末', new Date(2026, 10, 1), 1, { y: 2026, m: 10 }, '2026-10-26'],
  ['月初周日,周日起始:1 号在行首', new Date(2026, 10, 1), 0, { y: 2026, m: 10 }, '2026-11-01'],
  ['月初周一,周一起始:1 号在行首', new Date(2026, 5, 1), 1, { y: 2026, m: 5 }, '2026-06-01'],
  ['月初周一,周日起始', new Date(2026, 5, 1), 0, { y: 2026, m: 5 }, '2026-05-31'],
  ['月中,周一起始:这个月 1 号在行末', new Date(2026, 10, 15), 1, { y: 2026, m: 10 }, '2026-10-26'],
  ['月末,周一起始:这个月 1 号在行末', new Date(2026, 10, 30), 1, { y: 2026, m: 10 }, '2026-10-26'],
  ['周六 1 号,周日起始:1 号在行末', new Date(2026, 7, 1), 0, { y: 2026, m: 7 }, '2026-07-26'],
  ['周六 1 号,周一起始:1 号在周后半段', new Date(2026, 7, 1), 1, { y: 2026, m: 7 }, '2026-07-27'],
  ['跨年那一周,周一起始', new Date(2027, 0, 1), 1, { y: 2027, m: 0 }, '2026-12-28'],
])('打开月视图停在今天所在月:%s', async (_, today, dow, month, first) => {
  vi.setSystemTime(today)
  useWeekStartPref.getState().setPref(dow)
  const anchorRef: { current: MonthAnchor | null } = { current: null }
  const title = await mount(anchorRef, 'open')
  expect(anchorRef.current).toEqual(month)
  expect(title.textContent).toBe(monthLabel(new Date(month.y, month.m, 1)))
  expect(viewport()).toEqual({ first, todayShown: true })
})

it.each<WeekStartPref>([0, 1])('上下月逐月走,不卡在 1 号落在周后半段的月份:周首日 %s', async (dow) => {
  vi.setSystemTime(new Date(2026, 10, 1))
  useWeekStartPref.getState().setPref(dow)
  const anchorRef: { current: MonthAnchor | null } = { current: null }
  const api: { current: CalApi | null } = { current: null }
  const title = await mount(anchorRef, 'jump', api)
  const months = Array.from({ length: 8 }, (_, i) => new Date(2026, 10 + i, 1))
  for (const month of months.slice(1)) {
    await act(async () => api.current?.next())
    expect(title.textContent).toBe(monthLabel(month))
  }
  for (const month of months.reverse().slice(1)) {
    await act(async () => api.current?.prev())
    expect(title.textContent).toBe(monthLabel(month))
  }
})

it.each<[WeekStartPref, WeekStartPref, MonthAnchor, string]>([
  [1, 0, { y: 2027, m: 3 }, '2027-03-28'], // 周日起始下 1 号在周后半段
  [0, 1, { y: 2027, m: 3 }, '2027-03-29'],
  [1, 0, { y: 2026, m: 7 }, '2026-07-26'], // 周日起始下 1 号在行末
  [0, 1, { y: 2026, m: 7 }, '2026-07-27'], // 周一起始下 1 号在周后半段
])('周首日 %s→%s 重挂后,仍停在重挂前看的那个月(不跳回今天)', async (from, to, target, first) => {
  vi.setSystemTime(new Date(2026, 10, 1))
  const anchorRef: { current: MonthAnchor | null } = { current: null }
  useWeekStartPref.getState().setPref(from)
  await mount(anchorRef, `dow${from}`)
  expect(anchorRef.current).toEqual({ y: 2026, m: 10 }) // 首挂 = 今天所在月
  // 用户翻到 target 月(模拟:锚点就是滚动时写入的那一份)
  anchorRef.current = { ...target }
  useWeekStartPref.getState().setPref(to)
  const title = await mount(anchorRef, `dow${to}`) // CalendarView 按周首日换 key → 重挂
  expect(anchorRef.current).toEqual(target)
  expect(title.textContent).toBe(monthLabel(new Date(target.y, target.m, 1)))
  expect(viewport().first).toBe(first)
})
