// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { openPluginContextMenu } from './contextMenuSurface'

vi.mock('../api', () => ({ amadeus: undefined }))
const { usePluginStore } = await import('./pluginStore')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
type Row = { label: string; run(): void; checked?: boolean; danger?: boolean }
const K = (list: Row[]) => list.map((o) => ({ kind: 'item' as const, ...o }))
const open = (items: Row[], guard = (run: () => void) => run(), opts?: Parameters<typeof openPluginContextMenu>[4]) => {
  let menu!: ReturnType<typeof openPluginContextMenu>
  act(() => { menu = openPluginContextMenu({ x: 10, y: 20 }, K(items), guard, undefined, opts) })
  return { close: () => menu(), update: (next: Row[]) => menu.update(K(next)) }
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')]
const ticks = () => buttons().map((b) => b.querySelector('svg')?.style.opacity)

describe('ctx.ui.contextMenu(主页插件化 S7)', () => {
  it('宿主样式的 .ctx-menu,限高自己滚;点一项 = 先关菜单再跑它', () => {
    const run = vi.fn()
    open([{ label: 'Rename', run }, { label: 'Dissolve', run: vi.fn(), danger: true }])
    expect(document.querySelector('.ctx-menu')!.classList.contains('ctx-menu-scroll')).toBe(true)
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Rename', 'Dissolve'])
    expect(buttons()[1]!.className).toBe('danger')
    expect(buttons()[0]!.getAttribute('role')).toBe('menuitem')
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

  it('keepOpen:点了不关,update 换一份行(勾和 run 都换新的);关了之后 update 是空操作', () => {
    const first = vi.fn(), second = vi.fn()
    const menu = open([{ label: 'A', checked: false, run: first }, { label: 'B', checked: true, run() {} }], undefined, { keepOpen: true })
    expect(ticks()).toEqual(['0', '1'])
    act(() => buttons()[0]!.click())
    expect(first).toHaveBeenCalledTimes(1)
    expect(buttons()).toHaveLength(2) // 没关
    act(() => menu.update([{ label: 'A', checked: true, run: second }, { label: 'B', checked: true, run() {} }]))
    expect(ticks()).toEqual(['1', '1'])
    act(() => buttons()[0]!.click())
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1) // 旧 run 不再被调
    act(() => menu.close())
    act(() => menu.update([{ label: 'Z', run() {} }]))
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })
})

describe('ctx.ui.contextMenu 经插件上下文', () => {
  const ctxOf = (id: string) => {
    let ref: import('./types').PluginContext | null = null
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
    return { ctx: ref!, disable: () => usePluginStore.getState().disable(id) }
  }
  const shown = async () => {
    await act(async () => { await import('./contextMenuSurface'); await new Promise((r) => setTimeout(r, 0)) }) // 等宿主那次动态 import 落地
    expect(document.querySelector('.ctx-menu')).not.toBeNull()
  }

  it('返回的关闭函数带 update;菜单还没画出来就 update 也算数;空列表 = 关;200 项封顶', async () => {
    const { ctx } = ctxOf('p-menu')
    const close = ctx.ui!.contextMenu!(5, 5, [{ label: 'old', run() {} }], { keepOpen: true })
    close.update!(Array.from({ length: 250 }, (_, i) => ({ label: `n${i}`, run() {} })))
    await shown()
    expect(buttons()).toHaveLength(200)
    expect(buttons()[0]!.textContent?.trim()).toBe('n0')
    act(() => close.update!([]))
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })

  it('keepOpen 只认 true;插件停用后菜单关掉、update 不再画', async () => {
    const { ctx, disable } = ctxOf('p-menu2')
    const run = vi.fn()
    const close = ctx.ui!.contextMenu!(5, 5, [{ label: 'A', run }], { keepOpen: 'yes' as never })
    await shown()
    act(() => buttons()[0]!.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.ctx-menu')).toBeNull()
    const again = ctx.ui!.contextMenu!(5, 5, [{ label: 'A', run }], { keepOpen: true })
    await shown()
    act(() => disable())
    expect(document.querySelector('.ctx-menu')).toBeNull()
    act(() => again.update!([{ label: 'B', run }]))
    expect(document.querySelector('.ctx-menu')).toBeNull()
    expect(() => close()).not.toThrow()
  })
})
