// @vitest-environment happy-dom
/** useItemSelect 的 DOM 接线:范围选取的顺序来自**容器里的 [data-sel-id] 文档序**,不是某个数据数组。
 *  纯函数那半在 itemSelect.test.ts;这里钉的是「树收起来的那些行不能进范围」——三棵树都是惰性展开的,
 *  拿数据数组算范围会把屏幕上根本看不见的行一起选走。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as React from 'react'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useItemSelect } from './itemSelect'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

let host: HTMLDivElement
let root: Root
const opened: string[] = []

/** 探针:一列行,每行带 data-sel-id;点击把 act.open 记进 opened,便于断言「开没开」。 */
function Probe({ items }: { items: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const sel = useItemSelect(ref)
  return createElement(
    'div',
    { ref },
    items.map((id) =>
      createElement('button', {
        key: id,
        'data-sel-id': id,
        className: sel.has(id) ? 'sel' : '',
        onClick: (e: React.MouseEvent) => { opened.push(`${id}:${sel.click(id, e).open}`) },
      }, id),
    ),
  )
}

const render = async (items: string[]): Promise<void> => {
  await act(async () => { root.render(createElement(Probe, { items })) })
}
const click = async (id: string, mods: MouseEventInit = {}): Promise<void> => {
  const el = host.querySelector<HTMLElement>(`[data-sel-id="${id}"]`)!
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods })) })
}
const selected = (): string[] => Array.from(host.querySelectorAll('.sel')).map((e) => (e as HTMLElement).dataset.selId!)

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  opened.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useItemSelect', () => {
  it('裸击 = 打开并只选它', async () => {
    await render(['a', 'b', 'c', 'd'])
    await click('b')
    expect(selected()).toEqual(['b'])
    expect(opened).toEqual(['b:same'])
  })

  it('shift = 按屏幕顺序选范围,且不打开', async () => {
    await render(['a', 'b', 'c', 'd'])
    await click('b')
    await click('d', { shiftKey: true })
    expect(selected()).toEqual(['b', 'c', 'd'])
    expect(opened[1]).toBe('d:none')
  })

  it('option/alt = 逐个加减,不打开', async () => {
    await render(['a', 'b', 'c', 'd'])
    await click('b')
    await click('d', { altKey: true })
    expect(selected()).toEqual(['b', 'd'])
    await click('b', { altKey: true })
    expect(selected()).toEqual(['d'])
    expect(opened.every((x) => !x.endsWith(':same'))).toBe(false) // 第一下是裸击
    expect(opened.slice(1).every((x) => x.endsWith(':none'))).toBe(true)
  })

  it('⌘/Ctrl = 新标签页(选中同裸击)', async () => {
    await render(['a', 'b', 'c'])
    await click('c', { metaKey: true })
    expect(opened).toEqual(['c:new'])
    expect(selected()).toEqual(['c'])
  })

  it('收起的行(没渲染出来)不进范围 —— 顺序取自 DOM 而非数据数组', async () => {
    await render(['a', 'b', 'd']) // 'c' 在收起的文件夹里,压根没渲染
    await click('a')
    await click('d', { shiftKey: true })
    expect(selected()).toEqual(['a', 'b', 'd'])
  })
})
