// @vitest-environment happy-dom
/** 属性面板受控草稿(评审 2026-09-27 C-01 P0)—— DOM 层契约,真浏览器版在 unified-page.check 的 PR 组。
 *
 *  旧病:值框/键名框/坏 YAML 原文框是 defaultValue,失焦拿挂载时的旧 DOM 值比新 prop → 外部改写后
 *  「白点一下」就把旧值写回(外部改动被静默回滚)。这里钉:
 *  ① 外部 prop 变了 → 框里即时显示新值,聚焦再失焦 onCommit 零次(值框、数字框、键名框、原文框);
 *  ② 真打字 → 失焦照常提交一次(修法不能是「一律不写」);
 *  ③ 打字中同字段被外部改了 → 草稿保留 + 冲突标记;Esc 放弃草稿 → 显示外部值,失焦零提交。
 *  **负对照**:把任一框改回 `defaultValue` + 失焦比 DOM 值 → ① 红。
 *  ponytail: createElement 而非 JSX,免为一个用例把 vitest include 扩到 .tsx。 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AmadeusPropertiesPanel } from './amadeusProperties'

vi.mock('./amadeus/api', () => ({ amadeus: {} }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React


// 组件形参带 `= {}` 缺省值 → createElement 的重载推不出 props 类型,收窄成必填签名再用。
type PanelProps = NonNullable<Parameters<typeof AmadeusPropertiesPanel>[0]>
const Panel = AmadeusPropertiesPanel as (p: PanelProps) => React.ReactElement | null

let root: Root | null = null
let host: HTMLDivElement
let commits: string[] = []
const onCommit = (y: string): void => { commits.push(y) }

const render = (fm: string): void => {
  act(() => { root!.render(createElement(Panel, { fmExtra: fm, onCommit })) })
}
const openPanel = (): void => {
  act(() => { (host.querySelector('.amx-props-chip') as HTMLButtonElement).click() })
}
/** React 受控框的 onChange 走 value tracker:必须用原型 setter 再派 input 事件。 */
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, v: string): void => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const focusBlur = (el: HTMLElement): void => {
  act(() => { el.focus() })
  act(() => { el.blur() })
}
const valueInputs = (): HTMLInputElement[] => [...host.querySelectorAll<HTMLInputElement>('.amx-prop-row .amx-prop-input')]
const keyInputs = (): HTMLInputElement[] => [...host.querySelectorAll<HTMLInputElement>('.amx-prop-row input.amx-prop-key')]

beforeEach(() => {
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

describe('属性面板受控草稿(C-01)', () => {
  it('外部改写后:值框/数字框/键名框显示新值,逐个白点一下零提交', () => {
    render('status: todo\ncount: 3')
    openPanel()
    render('status: done\ncount: 7')
    expect(valueInputs().map((i) => i.value)).toEqual(['done', '7'])
    for (const el of [...valueInputs(), ...keyInputs()]) focusBlur(el)
    expect(commits).toEqual([])
    expect(valueInputs().map((i) => i.value)).toEqual(['done', '7'])
  })

  it('坏 YAML 原文框:外部改写后显示新原文,白点一下零提交', () => {
    render('status: [未闭合\nnote: 旧A')
    openPanel()
    render('status: [未闭合\nnote: 外部B')
    const ta = host.querySelector<HTMLTextAreaElement>('.amx-props-raw')!
    expect(ta.value).toBe('status: [未闭合\nnote: 外部B')
    focusBlur(ta)
    expect(commits).toEqual([])
  })

  it('真打字 → 失焦提交一次,且只改这一键', () => {
    render('status: todo\ncount: 3')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'doing')
    act(() => { el.blur() })
    expect(commits).toEqual(['status: doing\ncount: 3'])
  })

  it('打了字又改回原值,期间外部改了同字段 → 零提交(只比当前值会把旧值写回)', () => {
    render('status: todo')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'todoX')
    render('status: done')
    typeInto(el, 'todo')
    act(() => { el.blur() })
    expect(commits).toEqual([])
    expect(valueInputs()[0].value).toBe('done')
  })

  it('打字中同字段被外部改了 → 草稿保留+冲突标记;Esc 放弃 → 显示外部值、失焦零提交', () => {
    render('status: todo')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'todoY')
    render('status: 外部改')
    expect(el.value).toBe('todoY')
    expect(el.classList.contains('amx-prop-conflict')).toBe(true)
    expect(el.title).toContain('外部改')
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(valueInputs()[0].value).toBe('外部改')
    expect(valueInputs()[0].classList.contains('amx-prop-conflict')).toBe(false)
    act(() => { el.blur() })
    expect(commits).toEqual([])
  })

  it('别处插入一个键(idx 平移)不丢正在打的草稿,提交落在对的键上', () => {
    render('status: todo\ncount: 3')
    openPanel()
    const el = valueInputs()[1] // count
    act(() => { el.focus() })
    typeInto(el, '9')
    render('added: x\nstatus: todo\ncount: 3')
    expect(valueInputs()[2].value).toBe('9')
    act(() => { valueInputs()[2].blur() })
    expect(commits).toEqual(['added: x\nstatus: todo\ncount: 9'])
  })
})
