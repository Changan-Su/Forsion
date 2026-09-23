// @vitest-environment happy-dom
import * as React from 'react'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RowPeek } from './RowPeek'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('记录预览关闭时的属性草稿', () => {
  it('点击居中预览背景时,先同步提交属性再卸载记录', async () => {
    const events: string[] = []
    function Fixture() {
      const [open, setOpen] = useState(true)
      return open ? React.createElement(RowPeek, {
        title: 'Record', databaseName: 'Database', bodyKey: 'row', mode: 'center', onModeChange: () => {},
        onClose: () => { events.push('close'); setOpen(false) },
        children: React.createElement('input', { defaultValue: '尚未提交的属性', onBlur: (event: React.FocusEvent<HTMLInputElement>) => events.push(event.currentTarget.value) }),
      }) : null
    }
    await act(async () => root.render(React.createElement(Fixture)))
    const input = document.querySelector<HTMLInputElement>('.amx-db-peek input')!
    act(() => input.focus())
    act(() => document.querySelector('.amx-db-peek-shade')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(events).toEqual(['尚未提交的属性', 'close'])
    expect(document.querySelector('.amx-db-peek')).toBeNull()
  })

  it('已消费的 Escape 保留记录,不把取消属性草稿变成关闭记录', async () => {
    const close = vi.fn(), commit = vi.fn()
    await act(async () => root.render(React.createElement(RowPeek, {
      title: 'Record', databaseName: 'Database', bodyKey: 'row', mode: 'side', onModeChange: () => {}, onClose: close,
      children: React.createElement('input', { onBlur: commit, onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => event.preventDefault() }),
    })))
    const input = document.querySelector<HTMLInputElement>('.amx-db-peek input')!
    act(() => input.focus())
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(close).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it.each(['calendarDate', 'relation', 'person'])('%s 属性选择器的 Escape 只关闭选择器并保留焦点', async (type) => {
    await import('./propertyTypes.builtins')
    const { getPropertyType } = await import('./propertyTypes')
    const Cell = getPropertyType(type)!.Cell!
    const close = vi.fn()
    await act(async () => root.render(React.createElement(RowPeek, {
      title: 'Record', databaseName: 'Database', bodyKey: 'row', mode: 'center', onModeChange: () => {}, onClose: close,
      children: React.createElement(Cell, { value: '', onChange: () => {} }),
    })))
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    const trigger = document.querySelector<HTMLElement>(type === 'person' ? '.amx-db-personin' : '.amx-db-cellbtn')!
    act(() => {
      trigger.focus()
      if (type !== 'person') trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = document.querySelector<HTMLInputElement>('.amx-db-peek input')!
    expect(document.activeElement).toBe(input)
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(close).not.toHaveBeenCalled()
    expect(document.querySelector('.amx-db-popwrap')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
