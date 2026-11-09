// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRibbonStore, useSpaceStore, type SpaceDefinition } from '@lcl/engine'

// 对象菜单打桩成「弹得出来」:测试环境里没有菜单宿主,不打桩时永远 false,判不出事件校验那一层
const menu = vi.hoisted(() => ({ open: vi.fn((_o: unknown) => true) }))
vi.mock('@lcl/engine', async (orig) => ({ ...(await orig<typeof import('@lcl/engine')>()), openObjectMenu: menu.open }))
import { createSpacesApi } from './pluginSpaces'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let aRenders = 0
const Glyph = () => { aRenders++; return 'A' }
const GlyphB = () => 'B'
const sp = (id: string, icon: unknown = Glyph): SpaceDefinition => ({ id, name: () => `name:${id}`, icon, build() {} } as unknown as SpaceDefinition)

let alive = true
const api = () => createSpacesApi({ alive: () => alive, own: (off) => off })

beforeEach(() => {
  alive = true
  useSpaceStore.setState({ spaces: ['home', 'tangu'].map((id) => sp(id)) })
  useRibbonStore.setState({ items: [{ id: 'rb-market', side: 'top', tooltip: '商店', onClick: vi.fn() } as never], order: ['space:home', 'space:tangu'], bottomOrder: [], folders: [], commandItems: [], commandIcons: {} })
})

describe('ctx.spaces(主页插件化 S3 / S4)', () => {
  it('名字按当前语言求值成字符串;收纳架按 Ribbon 顺序、含插件自己的 Space', () => {
    expect(api().list()).toEqual([{ id: 'home', name: 'name:home' }, { id: 'tangu', name: 'name:tangu' }])
    expect(api().shelf.items().map((i) => i.id)).toEqual(['space:home', 'space:tangu'])
  })

  it('打开不认识的 Space → false,不切', async () => {
    expect(await api().open('nope')).toBe(false)
  })

  it('商店 / 成就两格只给 Ribbon 上真有的;插件停用后 run 不再动', () => {
    const [market] = api().actions()
    expect(market).toMatchObject({ id: 'rb-market', name: '商店' })
    alive = false
    market!.run()
    expect((useRibbonStore.getState().items[0] as { onClick: () => void }).onClick).not.toHaveBeenCalled()
  })

  it('插件停用后写不了 Ribbon', () => {
    alive = false
    api().shelf.move('space:tangu', 'space:home')
    api().shelf.addFolder('Work')
    expect(useRibbonStore.getState().order).toEqual(['space:home', 'space:tangu'])
    expect(useRibbonStore.getState().folders).toEqual([])
  })

  it('图标:认识的 id 由宿主画进 el;不认识的先空着', () => {
    const el = document.createElement('div')
    act(() => { api().mountIcon(el, 'nope') })
    expect(el.textContent).toBe('')
    expect(() => api().mountIcon(null as never, 'home')).toThrow(TypeError)
  })

  it('图标跟着 store 走:同 id 重注册换了图标就原地重画,晚注册的也补上;卸载后不再画', async () => {
    const el = document.createElement('div'), late = document.createElement('div')
    let off!: () => void
    act(() => { off = api().mountIcon(el, 'home'); api().mountIcon(late, 'later') })
    expect(el.textContent).toBe('A')
    expect(late.textContent).toBe('')
    act(() => useSpaceStore.setState({ spaces: [sp('home', GlyphB), sp('tangu'), sp('later', GlyphB)] }))
    expect(el.textContent).toBe('B')
    expect(late.textContent).toBe('B')
    act(() => off())
    await act(async () => { await Promise.resolve() }) // 卸载在下一个 microtask
    const renders = aRenders
    act(() => useSpaceStore.setState({ spaces: [sp('home'), sp('tangu')] })) // 换回 A:还挂着的话会再画一次
    expect(el.textContent).toBe('')
    expect(aRenders).toBe(renders)
  })
})

describe('ctx.spaces 主页插件化收尾(H6 / H7,2026-11-09)', () => {
  it('actions 带上首方 Ribbon 动作(rb-plugin-*),排在商店 / 成就后面;别的 Ribbon 条目不带', () => {
    const run = vi.fn()
    useRibbonStore.setState({ items: [
      { id: 'rb-plugin-activity', side: 'top', tooltip: '活动', onClick: run } as never,
      { id: 'rb-market', side: 'top', tooltip: '商店', onClick: vi.fn() } as never,
      { id: 'rb-settings', side: 'bottom', tooltip: '设置', onClick: vi.fn() } as never,
    ] })
    const ids = api().actions().map((a) => a.id)
    expect(ids).toEqual(['rb-market', 'rb-plugin-activity'])
    api().actions()[1]!.run()
    expect(run).toHaveBeenCalledOnce()
  })

  it('contextMenu:不认识的 Space / 停用后 / 不是事件 → false,不 preventDefault', () => {
    const ev = new MouseEvent('contextmenu', { clientX: 10, clientY: 10, cancelable: true })
    expect(api().contextMenu!(ev, 'nope')).toBe(false)
    expect(ev.defaultPrevented).toBe(false)
    expect(api().contextMenu!(null as never, 'home')).toBe(false)
    alive = false
    expect(api().contextMenu!(ev, 'home')).toBe(false)
  })

  it('contextMenu:坐标不是有限数 / 缺 preventDefault 的像事件对象,在任何动作之前就退(菜单不弹)', () => {
    menu.open.mockClear()
    const stop = vi.fn()
    expect(api().contextMenu!({ clientX: NaN, clientY: 1, preventDefault: vi.fn(), stopPropagation: stop }, 'home')).toBe(false)
    expect(() => api().contextMenu!({ clientX: 1, clientY: 1, stopPropagation: stop } as never, 'home')).not.toThrow()
    expect(api().contextMenu!({ clientX: 1, clientY: 1, stopPropagation: stop } as never, 'home')).toBe(false)
    expect(api().contextMenu!({ clientX: 1, clientY: 1, preventDefault: vi.fn() } as never, 'home')).toBe(false)
    expect(menu.open).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('contextMenu:React 合成事件那样的对象也收;弹出后替插件 preventDefault + stopPropagation,插件那几项排在最后一节', () => {
    menu.open.mockClear()
    const ev = { clientX: 12, clientY: 34, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: null, target: null }
    const run = vi.fn()
    expect(api().contextMenu!(ev, 'home', [{ label: '固定', run }, { label: '', run }, { label: 'x' } as never])).toBe(true)
    expect(ev.preventDefault).toHaveBeenCalledOnce()
    expect(ev.stopPropagation).toHaveBeenCalledOnce()
    const o = menu.open.mock.calls[0]![0] as { x: number; y: number; refs: unknown; placeSections: { items: { label: string; run(): void }[] }[] }
    expect(o).toMatchObject({ x: 12, y: 34, refs: [{ type: 'space', id: 'home' }] })
    expect(o.placeSections[0]!.items.map((i) => i.label)).toEqual(['固定'])
    alive = false
    o.placeSections[0]!.items[0]!.run()
    expect(run).not.toHaveBeenCalled()
  })

  it('opensElsewhere:普通窗口里点 Space 是就地切(false)', () => {
    expect(api().opensElsewhere!('home')).toBe(false)
  })
})
