// @vitest-environment happy-dom
// 主页插件卡的取数生命周期(评审 11-07):超时要自己结算、卡重新挂上要重拿。
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { providePluginWidget, resetPluginWidgetsForTest, usePluginWidgetData, type PluginWidgetData } from './pluginWidgets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let seen: PluginWidgetData = { status: 'none' }
function Probe() { seen = usePluginWidgetData('p', 'w'); return null }
const mount = () => act(() => root.render(h(Probe)))
const unmount = () => act(() => root.render(null))
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetPluginWidgetsForTest()
  vi.useRealTimers()
})

it('a provider that never settles and ignores the signal still ends as an error after 10 s', async () => {
  providePluginWidget('p', 'w', () => new Promise(() => {}))
  mount()
  await flush()
  expect(seen.status).toBe('loading')
  await act(async () => { vi.advanceTimersByTime(10_000) })
  await flush()
  expect(seen.status).toBe('error')
})

it('remounting the card refetches instead of showing the old rows forever', async () => {
  let n = 0
  const fn = vi.fn(() => [{ title: `v${++n}` }])
  providePluginWidget('p', 'w', fn)
  mount()
  await flush()
  expect(seen.status === 'ok' && seen.list.rows[0].title).toBe('v1')
  unmount()
  vi.advanceTimersByTime(6_000)
  mount()
  await flush()
  expect(fn).toHaveBeenCalledTimes(2)
  expect(seen.status === 'ok' && seen.list.rows[0].title).toBe('v2')
  // 几秒内反复挂卸(换断点)不重复拿
  unmount()
  mount()
  await flush()
  expect(fn).toHaveBeenCalledTimes(2)
})
