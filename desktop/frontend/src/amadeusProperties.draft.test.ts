// @vitest-environment happy-dom
/** 属性面板受控草稿(评审 2026-09-27 C-01 P0)—— DOM 层契约,真浏览器版在 unified-page.check 的 PR 组。
 *
 *  旧病:值框/键名框/坏 YAML 原文框是 defaultValue,失焦拿挂载时的旧 DOM 值比新 prop → 外部改写后
 *  「白点一下」就把旧值写回(外部改动被静默回滚)。这里钉:
 *  ① 外部 prop 变了 → 框里即时显示新值,聚焦再失焦 onCommit 零次(值框、数字框、键名框、原文框);
 *  ② 真打字 → 失焦照常提交一次(修法不能是「一律不写」);
 *  ③ 打字中同字段被外部改了 → 草稿保留 + 冲突标记;Esc 放弃草稿 → 显示外部值,失焦零提交;输入法组合中的 Esc(取消候选)不算放弃,草稿保留;
 *  ④ 没冲突的 Esc、原文框的 Esc 一律不放弃草稿(放弃不进撤销栈,收口 N-3)。
 *  **负对照**:把任一框改回 `defaultValue` + 失焦比 DOM 值 → ① 红。
 *  ponytail: createElement 而非 JSX,免为一个用例把 vitest include 扩到 .tsx。 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AmadeusPropertiesPanel, PropsDraftFlushContext } from './amadeusProperties'

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
  localStorage.clear() // 展开状态按库记在本机(C-19):上一条用例点开的状态不许漏进下一条
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
    expect(el.classList.contains('amx-prop-conflict')).toBe(true)
    typeInto(el, 'todo')
    // 收口 N-6 / E5:改回原值 = 失焦零写入、外部值胜出 —— 不许再挂冲突样式与「失焦后以你的输入为准」的提示
    expect(el.classList.contains('amx-prop-conflict')).toBe(false)
    expect(el.title).toBe('')
    act(() => { el.blur() })
    expect(commits).toEqual([])
    expect(valueInputs()[0].value).toBe('done')
  })

  it('数字框按归一判冲突:改回原值(带空白)不标冲突、失焦零提交(E5)', () => {
    render('count: 3')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, '39')
    render('count: 7')
    expect(el.classList.contains('amx-prop-conflict')).toBe(true)
    typeInto(el, ' 3 ')
    expect(el.classList.contains('amx-prop-conflict')).toBe(false)
    act(() => { el.blur() })
    expect(commits).toEqual([])
    expect(valueInputs()[0].value).toBe('7')
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

  // 收口 N-3:放弃草稿不进撤销栈 —— 没有冲突时 Esc 清草稿 = 手滑一下、Cmd+Z 也找不回。只在单行框标着冲突时才放弃;
  // 其余情况 Esc 不处理、原样冒泡(不吞)。负对照:onEscape 的 `!conflict` 改回 `draft === null` → 本例红。
  it('没有冲突时 Esc 不放弃草稿、原样冒泡;失焦照常提交(值框/键名框)', () => {
    const seen: Array<{ prevented: boolean }> = []
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') seen.push({ prevented: e.defaultPrevented }) }
    document.addEventListener('keydown', onKey)
    try {
      render('status: todo\ncount: 3')
      openPanel()
      const val = valueInputs()[0]
      act(() => { val.focus() })
      typeInto(val, 'todoABC')
      act(() => { val.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      expect(valueInputs()[0].value).toBe('todoABC')
      act(() => { val.blur() })
      expect(commits).toEqual(['status: todoABC\ncount: 3'])

      commits = []
      render('status: todo\ncount: 3')
      const key = keyInputs()[1]
      act(() => { key.focus() })
      typeInto(key, 'countX')
      act(() => { key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      expect(keyInputs()[1].value).toBe('countX')
      act(() => { key.blur() })
      expect(commits).toEqual(['status: todo\ncountX: 3'])
      expect(seen).toEqual([{ prevented: false }, { prevented: false }]) // 两次都冒泡到 document,没被吞
    } finally {
      document.removeEventListener('keydown', onKey)
    }
  })

  it('坏 YAML 原文框:冲突时 Esc 也不放弃多行草稿;撤销回原样再失焦 → 零提交、采用别处的版本', () => {
    render('status: [未闭合\nnote: 旧A')
    openPanel()
    const ta = host.querySelector<HTMLTextAreaElement>('.amx-props-raw')!
    act(() => { ta.focus() })
    typeInto(ta, 'status: [未闭合\nnote: 旧A\nextra: 修复中的一大段\nmore: 1')
    render('status: [未闭合\nnote: 外部B')
    expect(ta.classList.contains('amx-prop-conflict')).toBe(true)
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(ta.value).toBe('status: [未闭合\nnote: 旧A\nextra: 修复中的一大段\nmore: 1') // 一段修复没被一键清掉
    typeInto(ta, 'status: [未闭合\nnote: 旧A') // = Cmd+Z 撤回到开始编辑时的原样
    act(() => { ta.blur() })
    expect(commits).toEqual([])
    expect(host.querySelector<HTMLTextAreaElement>('.amx-props-raw')!.value).toBe('status: [未闭合\nnote: 外部B')
  })

  // 输入法组合中按 Esc = 取消候选,不是放弃草稿(评审返修 C-01-ime-esc)。三框共用 useFieldDraft,逐个钉。
  // 负对照:onEscape 摘掉 isComposing/229 判断 → 草稿被清、零提交,本例红。真组合版见 unified-page.check PR5。
  it('输入法组合中按 Esc(isComposing / keyCode 229)不丢草稿,失焦照常提交一次(值框/键名框/原文框)', () => {
    const composingEsc = (el: HTMLElement, init: KeyboardEventInit): void => {
      act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...init })) })
    }
    render('status: todo\ncount: 3')
    openPanel()
    const val = valueInputs()[0]
    act(() => { val.focus() })
    typeInto(val, 'todo项目')
    composingEsc(val, { isComposing: true })
    expect(valueInputs()[0].value).toBe('todo项目')
    act(() => { val.blur() })
    expect(commits).toEqual(['status: todo项目\ncount: 3'])

    commits = []
    render('status: todo\ncount: 3')
    const key = keyInputs()[1]
    act(() => { key.focus() })
    typeInto(key, 'count数')
    composingEsc(key, { keyCode: 229 })
    expect(keyInputs()[1].value).toBe('count数')
    act(() => { key.blur() })
    expect(commits).toEqual(['status: todo\ncount数: 3'])

    commits = []
    render('status: [未闭合\nnote: 旧A')
    const ta = host.querySelector<HTMLTextAreaElement>('.amx-props-raw')!
    act(() => { ta.focus() })
    typeInto(ta, 'status: [未闭合\nnote: 旧A项目')
    composingEsc(ta, { isComposing: true })
    expect(host.querySelector<HTMLTextAreaElement>('.amx-props-raw')!.value).toBe('status: [未闭合\nnote: 旧A项目')
    act(() => { ta.blur() })
    expect(commits).toEqual(['status: [未闭合\nnote: 旧A项目'])
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

// D-20(评审 2026-09-27):提交是行级的 —— 只改被编辑的那一个键的行,别的键原文逐字;多行值用多行框,换行不被压扁。
// 负对照:面板 commit 改回 fmEntriesToYaml 整块重建 → 前两例红。真浏览器版:评审探针 verify-integrity-4/props.cjs。
describe('属性面板行级提交(D-20)', () => {
  const FM = 'title: "Hello: world"\n# 注释\ntags: [alpha, beta]\ndesc: |\n  multi\n  line\nzip: 007\nversion: 1.10\nquoted: \'single\''

  it('改一个值:别的键(注释、007、1.10、flow、多行块)逐字', () => {
    render(FM)
    openPanel()
    const el = valueInputs().find((i) => i.value === 'single')!
    act(() => { el.focus() })
    typeInto(el, 'changed')
    act(() => { el.blur() })
    expect(commits).toEqual([FM.replace("quoted: 'single'", 'quoted: changed')])
  })

  it('改键名:只换键,值原文逐字', () => {
    render(FM)
    openPanel()
    const key = keyInputs().find((i) => i.value === 'zip')!
    act(() => { key.focus() })
    typeInto(key, 'postcode')
    act(() => { key.blur() })
    expect(commits).toEqual([FM.replace('zip: 007', 'postcode: 007')])
  })

  it('多行字符串是多行框:白点零写;改一行换行照留', () => {
    render(FM)
    openPanel()
    const ta = host.querySelector<HTMLTextAreaElement>('.amx-prop-row textarea.amx-prop-input')!
    expect(ta.value).toBe('multi\nline\n')
    focusBlur(ta)
    expect(commits).toEqual([])
    act(() => { ta.focus() })
    typeInto(ta, 'multi\nline 2\n')
    act(() => { ta.blur() })
    expect(commits).toEqual([FM.replace('  line\n', '  line 2\n')])
  })
})

// C-02(评审 2026-09-27 P1):值框/键名框只在失焦时提交 —— 键盘导航换篇(卸载:React 不给已脱离的节点派 onBlur)、
// beforeunload / 换库 / 退出握手时正在打的字丢了。宿主(UnifiedPage)提供 PropsDraftFlushContext:卸载与宿主冲洗都提交草稿。
// 负对照:useFieldDraft 的 useLayoutEffect 冲洗摘掉 → 「卸载」「宿主冲洗」两例红。真浏览器版:unified-page.check PR7。
describe('草稿冲洗(C-02)', () => {
  let flushers: Set<() => void>
  const renderHosted = (fm: string): void => {
    act(() => { root!.render(createElement(PropsDraftFlushContext.Provider, { value: flushers }, createElement(Panel, { fmExtra: fm, onCommit }))) })
  }
  const unmountAll = (): void => { act(() => { root!.render(createElement('div')) }) }
  beforeEach(() => { flushers = new Set() })

  it('聚焦打字中被卸载(换篇 / 关标签)→ 草稿提交一次', () => {
    renderHosted('status: todo\ncount: 3')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'todo卸载前')
    unmountAll()
    expect(commits).toEqual(['status: todo卸载前\ncount: 3'])
    expect(flushers.size).toBe(0)
  })

  it('卸载冲洗基于此刻的 fm:别处刚改的别的键不被旧快照改回去', () => {
    renderHosted('status: todo\ncount: 3')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'doing')
    renderHosted('count: 9') // 别处删了 status、改了 count → 本行卸载
    expect(commits).toEqual(['count: 9\nstatus: doing'])
  })

  it('宿主冲洗(beforeunload / 换库):提交但草稿留在框里;再失焦不重复写;改回原值还能再提交', () => {
    renderHosted('status: todo\ncount: 3')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'todoX')
    act(() => { for (const f of flushers) f() })
    expect(commits).toEqual(['status: todoX\ncount: 3'])
    renderHosted('status: todoX\ncount: 3') // 宿主写盘后 prop 跟上
    expect(valueInputs()[0].value).toBe('todoX')
    expect(valueInputs()[0].classList.contains('amx-prop-conflict')).toBe(false)
    act(() => { valueInputs()[0].blur() })
    expect(commits).toHaveLength(1)
    // 冲洗后改回最初的值:基线已挪到冲洗值,照样提交
    commits = []
    act(() => { valueInputs()[0].focus() })
    typeInto(valueInputs()[0], 'todoX2')
    act(() => { for (const f of flushers) f() })
    renderHosted('status: todoX2\ncount: 3')
    typeInto(valueInputs()[0], 'todoX')
    act(() => { valueInputs()[0].blur() })
    expect(commits).toEqual(['status: todoX2\ncount: 3', 'status: todoX\ncount: 3'])
  })

  it('失焦提交后紧跟卸载 → 只提交一次', () => {
    renderHosted('status: todo')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'done')
    act(() => { el.blur() })
    unmountAll()
    expect(commits).toEqual(['status: done'])
  })

  it('键名框同样冲洗;没打字的框卸载零提交', () => {
    renderHosted('status: todo\ncount: 3')
    openPanel()
    const key = keyInputs()[1]
    act(() => { key.focus() })
    typeInto(key, 'total')
    unmountAll()
    expect(commits).toEqual(['status: todo\ntotal: 3'])
  })

  it('不提供登记处(v3 PageView:store 先换篇后卸载行)→ 卸载不冲洗', () => {
    render('status: todo')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'done')
    unmountAll()
    expect(commits).toEqual([])
  })

  it('单行框回车 = 失焦提交(键盘离开);输入法组合中的回车(选词)不算;多行框回车照常换行', () => {
    render('status: todo\ndesc: |\n  a\n  b')
    openPanel()
    const el = valueInputs()[0]
    act(() => { el.focus() })
    typeInto(el, 'todo选')
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })) })
    expect(commits).toEqual([])
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { el.dispatchEvent(enter) })
    expect(commits).toEqual(['status: todo选\ndesc: |\n  a\n  b'])
    expect(enter.defaultPrevented).toBe(true)
    const ta = host.querySelector<HTMLTextAreaElement>('.amx-prop-row textarea.amx-prop-input')!
    const enterTa = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { ta.dispatchEvent(enterTa) })
    expect(enterTa.defaultPrevented).toBe(false)
  })
})
