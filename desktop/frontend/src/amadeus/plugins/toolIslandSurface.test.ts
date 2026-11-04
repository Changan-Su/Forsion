// @vitest-environment happy-dom
/** ctx.ui.mountToolIsland 的宿主那半(toolIslandSurface.tsx)。钉五件:窄了停底部、选中受控、换工具 / update 后键盘焦点
 *  还在同一颗按钮(Better PDF 0.1.2:整条重画后焦点掉到 body,按键没人听)、插件自己的 row / 四角元素原样摆进去、
 *  dispose 还原 root。 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountPluginToolIsland, TOOL_ISLAND_NARROW } from './toolIslandSurface'
import type { PluginToolIslandHandle, PluginToolIslandOptions } from './types'

let root: HTMLDivElement
let isle: PluginToolIslandHandle | undefined
let resize: (() => void) | undefined

const tools = (): PluginToolIslandOptions['tools'] => [
  { id: 'hand', icon: 'hand', title: '抓手' },
  'separator',
  { id: 'select', icon: 'mouse-pointer-2', title: '选择', key: 'V' },
  { id: 'highlight', icon: 'highlighter', title: '高亮', key: 'H' },
]
const btn = (id: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>(`.lcl-isle-btn[data-tool="${id}"]`)!
const layer = (): HTMLElement => root.querySelector<HTMLElement>('.lcl-isle-layer')!
const mount = (o: Partial<PluginToolIslandOptions> = {}, row = document.createElement('div')): PluginToolIslandHandle =>
  (isle = mountPluginToolIsland(root, 'test', row, { tools: tools(), onPick() {}, ...o }))
const width = (w: number): void => { Object.defineProperty(root, 'clientWidth', { configurable: true, value: w }) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resize = cb } observe() {} disconnect() { resize = undefined } })
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(async () => {
  await act(async () => { isle?.dispose() })
  isle = undefined
  root.remove()
  vi.unstubAllGlobals()
})

describe('ctx.ui.mountToolIsland', () => {
  it('宽的时候顶部,root 窄于 520 停到底部,跟着 ResizeObserver 翻', () => {
    width(900)
    mount()
    expect(layer().dataset.dock).toBe('top')
    width(TOOL_ISLAND_NARROW - 1)
    resize?.()
    expect(layer().dataset.dock).toBe('bottom')
    width(TOOL_ISLAND_NARROW)
    resize?.()
    expect(layer().dataset.dock).toBe('top')
  })

  it('画按钮、分隔线、图标词表里的图标、右下角快捷键字母', () => {
    mount({ active: 'select' })
    expect(root.querySelectorAll('.lcl-isle-btn')).toHaveLength(3)
    expect(root.querySelectorAll('.lcl-isle-sep[role="separator"]')).toHaveLength(1)
    for (const id of ['hand', 'select', 'highlight']) expect(btn(id).querySelector('svg'), id).not.toBeNull()
    expect(btn('select').querySelector('i')?.textContent).toBe('V')
    expect(btn('select').getAttribute('aria-keyshortcuts')).toBe('V')
    expect(btn('hand').querySelector('i')).toBeNull()
    expect(btn('select').getAttribute('aria-pressed')).toBe('true')
  })

  it('选中受控:点按钮只调 onPick,setActive 之后才换', () => {
    const picked: string[] = []
    const h = mount({ active: 'select', onPick: (id) => picked.push(id) })
    act(() => { btn('highlight').click() })
    expect(picked).toEqual(['highlight'])
    expect(btn('select').hasAttribute('data-on'), '宿主不擅自换').toBe(true)
    h.setActive('highlight')
    expect(btn('highlight').hasAttribute('data-on')).toBe(true)
    expect(btn('select').hasAttribute('data-on')).toBe(false)
  })

  it('鼠标按下不抢焦点(焦点留在视图里,视图的快捷键照样有人听)', () => {
    mount()
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    btn('select').dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })

  it('换工具 / update(整份新 tools)后键盘焦点还在同一颗按钮;那颗被拿掉了就给当前工具', () => {
    const h = mount({ active: 'select' })
    const b = btn('highlight')
    b.focus()
    h.setActive('highlight')
    expect(document.activeElement).toBe(b)
    h.update({ tools: tools(), active: 'highlight' })
    expect(document.activeElement, '同 id 的按钮 DOM 不换').toBe(b)
    btn('hand').focus()
    h.update({ tools: tools().filter((t) => t === 'separator' || t.id !== 'hand') })
    expect(document.activeElement).toBe(btn('highlight'))
  })

  it('row:同一个元素摆在岛下,showRow 开合;slots 包进四角,update 能换;onPick 抛错不连累宿主', () => {
    const row = document.createElement('div')
    const dots = row.appendChild(document.createElement('span'))
    const tl = document.createElement('button')
    const h = mount({ slots: { topLeft: tl }, onPick: () => { throw new Error('boom') } }, row)
    expect(h.row).toBe(row)
    expect(row.parentElement?.className).toBe('lcl-isle-main')
    expect(dots.isConnected).toBe(true)
    expect(row.hasAttribute('data-open')).toBe(false)
    h.showRow(true)
    expect(row.hasAttribute('data-open')).toBe(true)
    h.showRow(false)
    expect(row.hasAttribute('data-open')).toBe(false)

    const corner = (at: string): HTMLElement => root.querySelector<HTMLElement>(`.lcl-isle-slot[data-at="${at}"]`)!
    expect(tl.parentElement).toBe(corner('top-left'))
    expect(corner('top-left').hidden).toBe(false)
    expect(corner('bottom-right').hidden).toBe(true)
    const br = document.createElement('div')
    h.update({ slots: { bottomRight: br } })
    expect(br.parentElement).toBe(corner('bottom-right'))
    expect(tl.isConnected, '不再给的那格清掉').toBe(false)
    expect(corner('top-left').hidden).toBe(true)

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => { btn('hand').click() })
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('dispose:同步摘掉那一层、还原 root 的 position,插件放进 root 的东西不动;幂等', async () => {
    const own = root.appendChild(document.createElement('p'))
    const h = mount()
    expect(root.style.position).toBe('relative')
    await act(async () => { h.dispose() })
    expect(root.querySelector('.lcl-isle-layer')).toBeNull()
    expect(root.style.position).toBe('')
    expect(own.isConnected).toBe(true)
    expect(() => { h.dispose(); h.update({ active: 'x' }); h.showRow(true) }).not.toThrow()
    isle = undefined
  })
})
