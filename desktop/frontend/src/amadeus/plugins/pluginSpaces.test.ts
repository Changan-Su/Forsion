// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRibbonStore, useSpaceStore, type SpaceDefinition } from '@lcl/engine'
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
