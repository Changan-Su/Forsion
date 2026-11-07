// DOM-backed: happy-dom wired by hand, same as nativeSheetMenu.test.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'

type MenuMod = typeof import('./objectMenu')
type ObjMod = typeof import('./objects')
let m: MenuMod
let o: ObjMod
beforeAll(async () => {
  const win = new Window({ url: 'https://localhost/' })
  const g = globalThis as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in g) continue
    try { g[key] = (win as unknown as Record<string, unknown>)[key] } catch { /* accessor-only */ }
  }
  g.window = win
  g.document = win.document
  g.getComputedStyle = win.getComputedStyle.bind(win)
  g.IS_REACT_ACT_ENVIRONMENT = false
  m = await import('./objectMenu')
  o = await import('./objects')
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))
const menuEl = (): HTMLElement | null => document.querySelector('[data-lcl-menu]:not([data-lcl-exit])')
const labels = (): string[] => [...(menuEl()?.querySelectorAll('button') ?? [])].map((b) => b.textContent ?? '')

beforeEach(() => {
  o.__resetObjectsForTest()
  o.registerObjectType({ type: 'space', label: () => 'Space', isValidId: () => true, info: (r) => ({ title: r.id }), openModes: ['here'], open: () => {} })
})
afterEach(async () => { m.closeMenu(); await tick() })

describe('openMenu / MenuSurface', () => {
  it('分节画分隔线与节标题;标签是裸文本;点了先关再执行', async () => {
    const order: string[] = []
    m.openMenu({ x: 10, y: 10, onClose: () => order.push('closed'), menu: { sections: [
      { items: [{ id: 'a', label: 'Alpha', run: () => order.push('ran') }] },
      { title: 'Here', items: [{ id: 'b', label: 'Beta', checked: true, run: () => {} }, { id: 'c', label: 'Gamma' }] },
    ] } })
    await tick()
    expect(labels()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(menuEl()?.querySelectorAll('.ctx-separator').length).toBe(1)
    expect(menuEl()?.querySelector('.ctx-head')?.textContent).toBe('Here')
    const [alpha, beta, gamma] = [...menuEl()!.querySelectorAll('button')]
    expect(alpha.getAttribute('role')).toBe('menuitem')
    expect(beta.getAttribute('role')).toBe('menuitemradio')
    expect((gamma as HTMLButtonElement).disabled).toBe(true) // 没有 run 的是说明行
    expect(alpha.firstChild?.nodeType).toBe(3) // 没图标时第一个子节点就是文本
    alpha.click()
    expect(order).toEqual(['closed', 'ran'])
    await tick()
    expect(menuEl()).toBeNull()
  })

  it('按下菜单外面、Esc 都关;再开一个会先关掉上一个', async () => {
    const closed = vi.fn()
    m.openMenu({ x: 0, y: 0, onClose: closed, menu: { sections: [{ items: [{ id: 'a', label: 'A', run: () => {} }] }] } })
    await tick()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(closed).toHaveBeenCalledTimes(1)
    m.openMenu({ x: 0, y: 0, onClose: closed, menu: { sections: [{ items: [{ id: 'a', label: 'A', run: () => {} }] }] } })
    await tick()
    m.openMenu({ x: 0, y: 0, menu: { sections: [{ items: [{ id: 'b', label: 'B', run: () => {} }] }] } })
    expect(closed).toHaveBeenCalledTimes(2)
    await tick()
    expect(labels()).toEqual(['B'])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(m.menuIsOpen()).toBe(false)
  })

  it('没有条目不弹;对象菜单没有可列的项时不拦右键(让事件冒泡给外层)', async () => {
    m.openMenu({ x: 0, y: 0, menu: { sections: [{ items: [] }] } })
    expect(m.menuIsOpen()).toBe(false)
    const handler = m.objectContextMenuHandler(() => ({ refs: [{ type: 'space', id: 'tangu' }], place: { kind: 'test' } }))
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    handler(ev)
    expect(ev.defaultPrevented).toBe(false)
    o.registerObjectAction({ id: 'open', types: ['space'], title: () => 'Open', group: 'open', run: () => {} })
    const ev2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    handler(ev2)
    expect(ev2.defaultPrevented).toBe(true)
    await tick()
    expect(labels()).toEqual(['Open'])
  })

  it('别人已经 preventDefault 的右键不管', () => {
    o.registerObjectAction({ id: 'open', types: ['space'], title: () => 'Open', group: 'open', run: () => {} })
    const handler = m.objectContextMenuHandler(() => ({ refs: [{ type: 'space', id: 'tangu' }], place: { kind: 'test' } }))
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    ev.preventDefault()
    handler(ev)
    expect(m.menuIsOpen()).toBe(false)
  })
})
