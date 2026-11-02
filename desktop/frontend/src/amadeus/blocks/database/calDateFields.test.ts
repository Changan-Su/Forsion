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
