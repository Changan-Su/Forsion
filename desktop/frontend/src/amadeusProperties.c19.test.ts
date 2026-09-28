// @vitest-environment happy-dom
/** 属性区 C-19(评审 2026-09-27)DOM 契约:
 *  ① 新增时先选类型,写盘为对应 YAML 类型(0 / false / 今天 / [] / "");tags / aliases 缺省列表;仍是行级提交 —— 别的键
 *     (`007`)逐字不动(D-20 不回退);
 *  ② 新增后焦点落到新行的值框;键名框的输入法选词回车不提交;
 *  ③ 展开状态按库记在本机:新实例(v4 换篇按路径重建)直接展开;
 *  ④ 值里的 `[[x]]` 渲染成双链,按下即开(按 notePath 就近解析),不进编辑态;列表项同样。
 *  负对照:addProp 固定写 ''(旧版)→ ① 红;展开态回到组件局部 state → ③ 红。createElement 而非 JSX(同 draft.test)。 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AmadeusPropertiesPanel, emptyValueFor } from './amadeusProperties'
import { usePageStore } from './amadeus/store/pageStore'

vi.mock('./amadeus/api', () => ({ amadeus: {} }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

type PanelProps = NonNullable<Parameters<typeof AmadeusPropertiesPanel>[0]>
const Panel = AmadeusPropertiesPanel as (p: PanelProps) => React.ReactElement | null

let root: Root | null = null
let host: HTMLDivElement
let fm = ''
let commits: string[] = []
/** 宿主:提交即回灌(同 UnifiedPage 的 onCommit → pipe.fm → 重渲)。 */
const onCommit = (y: string): void => { commits.push(y); fm = y; render() }
const render = (): void => {
  act(() => { root!.render(createElement(Panel, { fmExtra: fm, onCommit, notePath: 'dir/Here.md' })) })
}
const click = (sel: string): void => { act(() => { (host.querySelector(sel) as HTMLElement).click() }) }
const typeInto = (el: HTMLInputElement, v: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const selectType = (v: string): void => {
  const sel = host.querySelector<HTMLSelectElement>('.amx-prop-new select')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, v)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const enter = (el: HTMLElement, init: KeyboardEventInit = {}): void => {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })) })
}
/** 点 + → 新增行,填键名、(可选)选类型、回车。 */
const add = (key: string, type?: string): void => {
  click('.amx-props-add')
  const k = host.querySelector<HTMLInputElement>('.amx-prop-new input.amx-prop-key')!
  typeInto(k, key)
  if (type) selectType(type)
  enter(k)
}

beforeEach(() => {
  localStorage.clear()
  fm = ''
  commits = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
})

describe('属性区 C-19', () => {
  it('① 新增时选类型 → 写盘为对应 YAML 类型;别的键逐字不动', () => {
    fm = 'zip: 007\n'
    render()
    add('n', 'number')
    add('done', 'checkbox')
    add('due', 'date')
    add('tags') // 缺省列表
    add('note', 'text')
    expect(fm).toBe(`zip: 007\nn: 0\ndone: false\ndue: ${emptyValueFor('date') as string}\ntags: []\nnote: ""\n`)
    // 控件跟着类型走
    const row = (k: string): Element => host.querySelector(`.amx-prop-row[data-key="${k}"]`)!
    expect(row('n').querySelector('input.amx-prop-input')).not.toBeNull()
    expect(row('done').querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(row('due').querySelector('input[type="date"]')).not.toBeNull()
    expect(row('tags').querySelector('.amx-prop-chips')).not.toBeNull()
  })
  it('② 新增后焦点落到新行的值框;键名框输入法选词回车不提交', () => {
    render()
    click('.amx-props-add')
    const k = host.querySelector<HTMLInputElement>('.amx-prop-new input.amx-prop-key')!
    typeInto(k, 'status')
    enter(k, { isComposing: true })
    expect(commits).toEqual([])
    enter(k)
    expect(fm).toBe('status: ""\n')
    expect(document.activeElement).toBe(host.querySelector('.amx-prop-row[data-key="status"] input.amx-prop-input'))
    expect(host.querySelector('.amx-prop-new')).toBeNull()
  })
  it('③ 展开状态按库记在本机:新实例直接展开', () => {
    fm = 'a: 1\n'
    render()
    expect(host.querySelector('.amx-props-rows')).toBeNull() // 从没展开过 = 折叠(缺省不变)
    click('.amx-props-chip')
    act(() => root!.unmount())
    root = createRoot(host)
    render()
    expect(host.querySelector('.amx-props-rows')).not.toBeNull()
  })
  it('④ 值里的 [[x]] 渲染成双链,按下即开(按 notePath 就近解析),不进编辑态;列表项同样', () => {
    const open = vi.fn()
    usePageStore.setState({ openWikiLink: open })
    fm = 'related: "[[Alpha|甲]] 与 [[Beta]]"\nsee: ["[[Gamma]]", plain]\n'
    render()
    click('.amx-props-chip')
    const links = [...host.querySelectorAll<HTMLElement>('.amx-prop-link')]
    expect(links.map((l) => l.textContent)).toEqual(['甲', 'Beta', 'Gamma'])
    act(() => { links[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    act(() => { links[0].click() })
    expect(open).toHaveBeenCalledWith('Alpha', 'dir/Here.md')
    expect(host.querySelector('.amx-prop-row[data-key="related"] input.amx-prop-input')).toBeNull() // 没进编辑态
    act(() => { links[2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(open).toHaveBeenLastCalledWith('Gamma', 'dir/Here.md')
    // 点空白处 → 进编辑(原来的受控草稿框)
    click('.amx-prop-row[data-key="related"] .amx-prop-links')
    expect(host.querySelector<HTMLInputElement>('.amx-prop-row[data-key="related"] input.amx-prop-input')?.value).toBe('[[Alpha|甲]] 与 [[Beta]]')
  })
})
