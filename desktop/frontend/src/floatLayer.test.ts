// @vitest-environment happy-dom
/** 浮层宿主(floatLayer.ts):三档作用域落在哪一层、通知叠放、切 Space 按 id 藏、锚点记忆、关掉收干净。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFloat, nearestAnchor, registerSpaceFloatLayer, resetFloatsForTest, savedAnchor } from '@lcl/engine/floatLayer'
import { useSpaceStore } from '@lcl/engine/spaceRegistry'

beforeEach(() => {
  resetFloatsForTest()
  document.body.innerHTML = ''
  localStorage.clear()
  useSpaceStore.setState({ activeSpaceId: 'cloud' })
})
afterEach(() => resetFloatsForTest())

describe('nearestAnchor', () => {
  it('上下按一半、左右按三等分', () => {
    expect(nearestAnchor(0.1, 0.1)).toBe('top-start')
    expect(nearestAnchor(0.5, 0.2)).toBe('top-center')
    expect(nearestAnchor(0.9, 0.9)).toBe('bottom-end')
    expect(nearestAnchor(0.2, 0.7)).toBe('bottom-start')
  })
})

describe('openFloat', () => {
  it('窗口作用域挂在 body 那一层,缺省右下、面板、卡面', () => {
    const h = openFloat({ scope: 'window' })
    const layer = h.el.parentElement!
    expect(layer.matches('.lcl-float-layer[data-scope="window"]')).toBe(true)
    expect(layer.parentElement).toBe(document.body)
    expect(h.anchor).toBe('bottom-end')
    expect(h.el.dataset.role).toBe('panel')
    expect(h.el.getAttribute('role')).toBe('region')
    expect('bare' in h.el.dataset).toBe(false)
  })

  it('通知进同一锚点的叠放列,读屏会念;面板不进', () => {
    const a = openFloat({ scope: 'window', role: 'notice' })
    const b = openFloat({ scope: 'window', role: 'notice' })
    const p = openFloat({ scope: 'window' })
    expect(a.el.parentElement).toBe(b.el.parentElement)
    expect(a.el.parentElement!.matches('.lcl-float-stack[data-anchor="bottom-end"]')).toBe(true)
    expect([...a.el.parentElement!.children]).toEqual([a.el, b.el]) // 先开的贴角
    expect(a.el.getAttribute('role')).toBe('status')
    expect(p.el.parentElement!.matches('.lcl-float-layer')).toBe(true)
  })

  it('Space 作用域进 Space 层;切走那个 Space 就藏,回来再出', () => {
    const layer = document.createElement('div')
    layer.className = 'lcl-float-layer'
    document.body.appendChild(layer)
    const off = registerSpaceFloatLayer(layer)
    const h = openFloat({ scope: 'space', role: 'notice' })
    expect(layer.contains(h.el)).toBe(true)
    expect(h.el.hidden).toBe(false)
    useSpaceStore.setState({ activeSpaceId: 'chat' })
    expect(h.el.hidden).toBe(true)
    useSpaceStore.setState({ activeSpaceId: 'cloud' })
    expect(h.el.hidden).toBe(false)
    off()
    expect(layer.contains(h.el)).toBe(false) // 层要卸了:先搬到窗口层
    expect(h.el.closest('[data-scope="window"]')).not.toBeNull()
  })

  it('没有 Space 层的窗口:Space 作用域退到窗口层,照样按 Space id 藏', () => {
    const h = openFloat({ scope: 'space', space: 'chat' })
    expect(h.el.closest('[data-scope="window"]')).not.toBeNull()
    expect(h.el.hidden).toBe(true)
  })

  it('View 作用域挂进宿主元素;宿主是 static 就设成 relative;最后一块关掉、退场替身走了连层一起收', async () => {
    const host = document.createElement('section')
    document.body.appendChild(host)
    const h = openFloat({ scope: 'view', host, anchor: 'top-start' })
    expect(host.style.position).toBe('relative')
    expect(h.el.parentElement!.matches('.lcl-float-layer[data-scope="view"]')).toBe(true)
    expect(h.el.parentElement!.parentElement).toBe(host)
    h.close()
    expect(h.closed).toBe(true)
    await new Promise((r) => setTimeout(r, 0)) // 退场替身摘掉之后才收空层(Codex 11-07:同步收会被替身挡住、空层留下)
    expect(host.querySelector('.lcl-float-layer')).toBeNull()
  })

  it('View 浮层的宿主被摘下来后 move:留在宿主里,不退到窗口层盖住整个窗口', () => {
    const host = document.createElement('section')
    document.body.appendChild(host)
    const h = openFloat({ scope: 'view', host })
    host.remove()
    h.move('top-start')
    expect(h.el.closest('.lcl-float-layer')!.parentElement).toBe(host)
    expect(document.querySelector('body > .lcl-float-layer[data-scope="window"] .lcl-float')).toBeNull()
  })

  it('拖到一半关掉:窗口上的拖动监听一起撤掉,之后的指针移动不再动它', () => {
    const h = openFloat({ scope: 'window' })
    const handle = document.createElement('div'); handle.dataset.floatDrag = ''
    h.el.appendChild(handle)
    const ev = (type: string, x: number, y: number) => new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1 })
    handle.dispatchEvent(ev('pointerdown', 100, 100))
    window.dispatchEvent(ev('pointermove', 140, 100))
    expect(h.el.style.transform).not.toBe('')
    h.close()
    expect(h.el.style.transform).toBe('')
    window.dispatchEvent(ev('pointermove', 200, 160))
    expect(h.el.style.transform).toBe('')
    expect('dragging' in h.el.dataset).toBe(false)
  })

  it('move 换锚点;给了 id 时只记用户拖的(move 不记),下次按记住的开', () => {
    const h = openFloat({ scope: 'window', id: 'penzor.transfer' })
    h.move('top-start')
    expect(h.anchor).toBe('top-start')
    expect(h.el.dataset.anchor).toBe('top-start')
    expect(savedAnchor('penzor.transfer')).toBeNull()
    localStorage.setItem('lcl.float.anchor.penzor.transfer', 'bottom-start')
    expect(openFloat({ scope: 'window', id: 'penzor.transfer' }).anchor).toBe('bottom-start')
    localStorage.setItem('lcl.float.anchor.penzor.transfer', 'nowhere')
    expect(openFloat({ scope: 'window', id: 'penzor.transfer', anchor: 'top-end' }).anchor).toBe('top-end') // 坏值 = 不知道
  })

  it('参数不对同步抛', () => {
    expect(() => openFloat({ scope: 'desktop' as never })).toThrow(TypeError)
    expect(() => openFloat({ scope: 'view' })).toThrow(/host/)
    expect(() => openFloat({ scope: 'window', anchor: 'middle' as never })).toThrow(TypeError)
    expect(() => openFloat({ scope: 'window', role: 'dialog' as never })).toThrow(TypeError)
  })
})
