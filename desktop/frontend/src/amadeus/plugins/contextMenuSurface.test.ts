// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { openPluginContextMenu } from './contextMenuSurface'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const open = (items: Parameters<typeof openPluginContextMenu>[2], guard = (run: () => void) => run()) => {
  let close!: () => void
  act(() => { close = openPluginContextMenu(10, 20, items, guard) })
  return close
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')]

describe('ctx.ui.contextMenu(主页插件化 S7)', () => {
  it('宿主样式的 .ctx-menu;点一项 = 先关菜单再跑它', () => {
    const run = vi.fn()
    open([{ label: 'Rename', run }, { label: 'Dissolve', run: vi.fn(), danger: true }])
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Rename', 'Dissolve'])
    expect(buttons()[1]!.className).toBe('danger')
    act(() => buttons()[0]!.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })

  it('同一时刻只开一个;Esc、点菜单外都会关', () => {
    open([{ label: 'A', run() {} }])
    open([{ label: 'B', run() {} }])
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['B'])
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('.ctx-menu')).toBeNull()
    open([{ label: 'C', run() {} }])
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })

  it('插件停用之后点菜单项不再调它(guard 由宿主给)', () => {
    const run = vi.fn()
    open([{ label: 'A', run }], () => {})
    act(() => buttons()[0]!.click())
    expect(run).not.toHaveBeenCalled()
  })
})
