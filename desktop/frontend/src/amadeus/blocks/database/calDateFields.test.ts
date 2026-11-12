// @vitest-environment happy-dom
// 事件卡 / 记录页的日期三件套:改开始时结束跟着平移(改之前只动开始,一小时的事挪三天就成了结束早于开始)。
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CalDateFields } from './propertyTypes.builtins'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => { await act(async () => root?.unmount()); root = undefined })

async function edit(value: string, input: number, next: string): Promise<string | undefined> {
  document.body.innerHTML = '<div id="t"></div>'
  const host = document.getElementById('t')!
  const onChange = vi.fn()
  root = createRoot(host)
  await act(async () => root!.render(createElement(CalDateFields, { value, onChange })))
  const el = host.querySelectorAll('input')[input] as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return onChange.mock.calls.at(-1)?.[0]
}

it('moving the start date carries the end along', async () => {
  expect(await edit('2026-11-02T11:00/2026-11-02T12:00', 0, '2026-11-05')).toBe('2026-11-05T11:00/2026-11-05T12:00')
})
it('moving the start time keeps the duration', async () => {
  expect(await edit('2026-11-02T11:00/2026-11-02T12:00', 1, '14:30')).toBe('2026-11-02T14:30/2026-11-02T15:30')
})
it('editing the end still sets only the end', async () => {
  expect(await edit('2026-11-02T11:00/2026-11-02T12:00', 2, '2026-11-04')).toBe('2026-11-02T11:00/2026-11-04T12:00')
})
it('a start without an end stays without one', async () => {
  expect(await edit('2026-11-02', 0, '2026-11-05')).toBe('2026-11-05')
})

async function toggleAllDay(value: string): Promise<string | undefined> {
  document.body.innerHTML = '<div id="t"></div>'
  const host = document.getElementById('t')!, onChange = vi.fn()
  root = createRoot(host)
  await act(async () => root!.render(createElement(CalDateFields, { value, onChange })))
  const el = host.querySelector<HTMLInputElement>('input[data-calendar-all-day]')
  expect(el).not.toBeNull()
  await act(async () => el!.click())
  return onChange.mock.calls.at(-1)?.[0]
}
it('all-day clears both times while retaining an inclusive multi-day range', async () => {
  expect(await toggleAllDay('2026-11-02T11:00/2026-11-04T12:00')).toBe('2026-11-02/2026-11-04')
})
it('all-day converts a one-day time range without adding a second date', async () => {
  expect(await toggleAllDay('2026-11-02T11:00/2026-11-02T12:00')).toBe('2026-11-02')
})
it('turning all-day off restores editable time fields with a one-hour default', async () => {
  expect(await toggleAllDay('2026-11-02')).toBe('2026-11-02T09:00/2026-11-02T10:00')
})
