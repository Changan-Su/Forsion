// @vitest-environment happy-dom
/**
 * 悬停提示的键盘入口(Codex 第一轮 B2-4):Orbit 一级行把原生 title 换成了自绘提示,提示里的「类型 · 相对时间」
 * 只有鼠标能看到。tipProps(load, { focus: true }) 让键盘聚焦(:focus-visible)也弹,鼠标点击带来的焦点不弹。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tipProps, disarmTip } from './hoverTip'

vi.mock('./stores/appStore', () => ({ useApp: { getState: () => ({ tr: (k: string) => k }) } }))

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { disarmTip(); vi.useRealTimers() })

const focusEvent = (visible: boolean) => {
  const el = document.createElement('button')
  el.matches = ((sel: string) => sel === ':focus-visible' ? visible : false) as typeof el.matches
  return { currentTarget: el } as unknown as React.FocusEvent<HTMLElement>
}

it('键盘聚焦弹提示,失焦收起', async () => {
  const load = vi.fn(() => ['Name', 'Direct chat · 3 min ago'])
  const p = tipProps(load, { focus: true })
  p.onFocus!(focusEvent(true))
  await vi.advanceTimersByTimeAsync(1000)
  expect(load).toHaveBeenCalledTimes(1)
  p.onBlur!()
})

it('鼠标点击带来的焦点(非 :focus-visible)不弹', async () => {
  const load = vi.fn(() => ['Name'])
  tipProps(load, { focus: true }).onFocus!(focusEvent(false))
  await vi.advanceTimersByTimeAsync(1500)
  expect(load).not.toHaveBeenCalled()
})

it('不声明 focus 的调用方保持原样:只有鼠标', () => {
  const p = tipProps(() => ['x'])
  expect(p.onFocus).toBeUndefined()
  expect(p.onBlur).toBeUndefined()
})
