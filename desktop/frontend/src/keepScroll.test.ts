// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { keepScroll } from '@lcl/engine/keepScroll'

/** happy-dom 没有布局:scrollHeight / clientHeight 恒 0,这里给个尺寸;scrollTop 本身是可读写的。 */
function scroller(root: HTMLElement, scrollHeight = 2000, clientHeight = 400): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  root.appendChild(el)
  return el
}
const scrollTo = (el: HTMLElement, top: number): void => {
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll')) // 不冒泡:面板根上要靠捕获期才收得到
}

describe('keepScroll', () => {
  it('摘下再挂回去(位置归零)之后,restore 把记下的位置写回', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const keeper = keepScroll(root)
    const a = scroller(root), b = scroller(root)
    scrollTo(a, 700)
    scrollTo(b, 120)
    a.scrollTop = 0; b.scrollTop = 0 // 重新入 DOM:不发 scroll 事件,位置直接没了
    keeper.restore()
    expect([a.scrollTop, b.scrollTop]).toEqual([700, 120])
    keeper.dispose()
  })

  it('停在末尾的容器回到现在的末尾,不回到离开时的偏移(隐藏期间内容长高了)', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const keeper = keepScroll(root)
    let height = 2000
    const el = scroller(root)
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height })
    scrollTo(el, 1600) // 2000 - 400:贴底
    height = 2600
    el.scrollTop = 0
    keeper.restore()
    expect(el.scrollTop).toBe(2200)
    keeper.dispose()
  })

  it('面板摘下期间的 scroll 不记(视图自己派发的合成事件,读到的位置是 0)', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const keeper = keepScroll(root)
    const el = scroller(root)
    scrollTo(el, 700)
    root.remove()
    scrollTo(el, 0) // PDF 阅读器装载完会在容器上派发一次 scroll
    document.body.appendChild(root)
    keeper.restore()
    expect(el.scrollTop).toBe(700)
    keeper.dispose()
  })

  it('挂回来时内容还没撑开、写回被夹住:下一帧按原来的位置补,不按被夹住的那个', async () => {
    const root = document.body.appendChild(document.createElement('div'))
    const keeper = keepScroll(root)
    let max = 300 // 夹住:此刻最多只能滚到 300
    const el = scroller(root)
    let top = 0
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = Math.min(v, max) } })
    max = 1600
    scrollTo(el, 700)
    max = 300
    top = 0
    keeper.restore()
    expect(el.scrollTop).toBe(300)
    el.dispatchEvent(new Event('scroll')) // 被夹住的那次写回自己发的 scroll:300 恰好是此刻的末尾(end)
    max = 1600 // 内容撑开了
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(el.scrollTop).toBe(700)
    keeper.dispose()
  })

  it('已经不在面板里的容器不再碰;dispose 之后不再记', () => {
    const root = document.body.appendChild(document.createElement('div'))
    const keeper = keepScroll(root)
    const gone = scroller(root), kept = scroller(root)
    scrollTo(gone, 300)
    gone.remove()
    gone.scrollTop = 0
    keeper.restore()
    expect(gone.scrollTop).toBe(0)
    keeper.dispose()
    scrollTo(kept, 500)
    kept.scrollTop = 0
    keeper.restore()
    expect(kept.scrollTop).toBe(0)
  })
})
