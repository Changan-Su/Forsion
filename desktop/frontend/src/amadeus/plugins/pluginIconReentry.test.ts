// @vitest-environment happy-dom
// ctx.ui.icon 第一次用到某个名字时,宿主曾在调用方的栈里用 flushSync 现渲染一枚。flushSync 会把**所有根**上挂着的
// 同步更新一起提交 —— 其中可能正好是「主区换一个视图实例」:插件视图于是在自己的 draw() 中间被卸掉,draw 的后半截
// 对着一个死掉的视图接着跑(安卓真壳上它又认领了一次原生头部,系统返回的预览随后卡住)。
// 这里钉住:同一拍里挂着一次「换视图」的同步更新时,draw() 里第一次要图标不会把换视图提前提交;
// 图标照样是同一个元素,下一次绘制之前(微任务里)补上字形。
// 本文件单独成一个模块环境:词表图标的渲染结果是模块级缓存,别的用例先用过同名图标就测不到第一次。
import { createElement, useEffect, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ amadeus: undefined }))
const { usePluginStore } = await import('./pluginStore')
// 这里刻意不在 act() 里跑:要的就是生产里的时序(同步更新在微任务里提交),act 会把它收进自己的队列。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

const uiOf = (id: string) => {
  let ref: import('./types').PluginContext | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!.ui!
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const roots: Array<{ unmount(): void }> = []
afterEach(() => { for (const r of roots.splice(0)) r.unmount(); document.body.replaceChildren() })

describe('ctx.ui.icon 第一次用某个名字', () => {
  it('挂着一次「换视图」的同步更新时,draw() 中途不会被卸掉;图标在下一次绘制前补齐', async () => {
    const ui = uiOf('p-icon-reentry')
    const log: string[] = []
    const icons: SVGSVGElement[] = []
    // 宿主那半:主区按 gen 换一个视图实例(zustand → useSyncExternalStore → 同步车道,和宿主换主视图同一条路)。
    const main = create<{ gen: number }>(() => ({ gen: 1 }))
    const views: Record<number, { draw(): void }> = {}
    function ViewHost({ gen }: { gen: number }) {
      const ref = useRef<HTMLDivElement>(null)
      useEffect(() => {
        const el = ref.current!
        let alive = true
        views[gen] = {
          draw() {
            log.push(`draw ${gen} start`)
            const svg = ui.icon!('sticky-note', { size: 14 })!
            icons.push(svg)
            el.append(svg)
            log.push(`draw ${gen} end${alive ? '' : ' (view already disposed)'}`)
          },
        }
        log.push(`mount ${gen}`)
        return () => { alive = false; log.push(`dispose ${gen}`) }
      }, [gen])
      return createElement('div', { ref })
    }
    function Main() {
      const gen = main((s) => s.gen)
      return createElement(ViewHost, { key: gen, gen })
    }
    const box = document.createElement('div')
    document.body.append(box)
    const root = createRoot(box)
    roots.push(root)
    flushSync(() => root.render(createElement(Main)))
    await tick()
    expect(log).toEqual(['mount 1'])

    // 同一拍:宿主排上「换视图」,旧视图紧接着画一遍(真壳上是系统返回手势的那个事件)。
    main.setState({ gen: 2 })
    views[1].draw()
    // 修之前:['mount 1', 'draw 1 start', 'dispose 1', 'mount 2', 'draw 1 end (view already disposed)']
    expect(log).toEqual(['mount 1', 'draw 1 start', 'draw 1 end'])

    await tick()
    expect(log).toEqual(['mount 1', 'draw 1 start', 'draw 1 end', 'dispose 1', 'mount 2'])
    // 拿到的还是那一枚元素,尺寸当场就对,字形补上了。
    const [svg] = icons
    expect(svg.getAttribute('width')).toBe('14')
    expect(svg.getAttribute('height')).toBe('14')
    expect(svg.childElementCount).toBeGreaterThan(0)
  })

  it('字形在微任务里补齐(先于下一次绘制);同一拍里多次、多个名字都补;第二次起当场就有', async () => {
    const ui = uiOf('p-icon-fill')
    const a = ui.icon!('mouse-pointer-2', { size: 20 })!
    const b = ui.icon!('mouse-pointer-2')!
    const c = ui.icon!('pen-line')!
    expect(a).not.toBe(b)
    // 尺寸当场就在,不会因为字形晚到一拍挪位置。
    expect([a.getAttribute('width'), a.getAttribute('height'), b.getAttribute('width')]).toEqual(['20', '20', '16'])
    expect(a.getAttribute('viewBox')).toBe('0 0 24 24')
    await Promise.resolve()
    for (const svg of [a, b, c]) expect(svg.childElementCount).toBeGreaterThan(0)
    expect(a.innerHTML).toBe(b.innerHTML)
    const again = ui.icon!('mouse-pointer-2')!
    expect(again.innerHTML).toBe(a.innerHTML)
  })

  it('在宿主提交期间(插件 mount 跑在 layout effect 里)要图标:不报 flushSync 错,微任务里照样补齐', async () => {
    const ui = uiOf('p-icon-commit')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let svg: SVGSVGElement | null = null
    function Mounts() {
      useLayoutEffect(() => { svg = ui.icon!('server-cog') }, [])
      return null
    }
    const box = document.createElement('div')
    document.body.append(box)
    const root = createRoot(box)
    roots.push(root)
    flushSync(() => root.render(createElement(Mounts)))
    expect(svg).not.toBeNull()
    await Promise.resolve()
    expect(svg!.childElementCount).toBeGreaterThan(0)
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
