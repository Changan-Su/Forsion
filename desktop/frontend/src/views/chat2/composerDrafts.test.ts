// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NEW_CHAT_DRAFT, clearDraft, moveDraft, setDraftField, useComposerDrafts, useDraftField } from './composerDrafts'

// 用户报的:在一个会话里打了没发的字,切到别的会话被带了过去。草稿按会话存,输入框只是它的视图。
let host: HTMLDivElement
let root: Root
let setText: (v: string | ((d: string) => string)) => void
const Box = ({ sessionId }: { sessionId: string | null }): React.ReactElement => {
  const [text, set] = useDraftField(sessionId ?? NEW_CHAT_DRAFT, 'text')
  setText = set
  return React.createElement('textarea', { value: text, readOnly: true })
}
const show = (sessionId: string | null) => act(async () => { root.render(React.createElement(Box, { sessionId })) })
const shown = (): string => host.querySelector('textarea')!.value

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  useComposerDrafts.setState({}, true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

describe('草稿按会话存', () => {
  it('切到别的会话不带过去,切回来还在;新对话同理', async () => {
    await show('A')
    await act(async () => { setText('写给 A 的半句') })
    await show('B')
    expect(shown()).toBe('')
    await act(async () => { setText('B 的') })
    await show(null)
    expect(shown()).toBe('')
    await act(async () => { setText('新对话的') })
    await show('A')
    expect(shown()).toBe('写给 A 的半句')
    await show('B')
    expect(shown()).toBe('B 的')
    await show(null)
    expect(shown()).toBe('新对话的')
  })

  it('输入框卸载再挂回来(关标签 / 换 Space)草稿还在', async () => {
    await show('A')
    await act(async () => { setText('没发的') })
    await act(async () => { root.unmount() })
    root = createRoot(host)
    await show('A')
    expect(shown()).toBe('没发的')
  })

  it('setter 写的是此刻对着的会话(函数式更新读的也是它)', async () => {
    await show('A')
    const first = setText
    await show('B')
    expect(setText).toBe(first) // 身份稳定:带缓存的命令项闭包里捏着的还是它
    await act(async () => { first((d) => d + 'x') })
    expect(useComposerDrafts.getState().A).toBeUndefined()
    expect(shown()).toBe('x')
  })
})

describe('发送后的收尾', () => {
  it('新对话的第一句:发出时是「新对话」,回来时输入框已在新会话上 —— 清的是新对话那份', () => {
    setDraftField(NEW_CHAT_DRAFT, 'text', '第一句')
    setDraftField('created', 'text', '') // 输入框换到刚建的会话上
    clearDraft(NEW_CHAT_DRAFT)
    expect(useComposerDrafts.getState()[NEW_CHAT_DRAFT]).toBeUndefined()
  })

  it('发送途中切到别的会话:那边的草稿不受影响', () => {
    setDraftField('A', 'text', '发出去的')
    setDraftField('B', 'text', 'B 没发的')
    clearDraft('A')
    expect(useComposerDrafts.getState().B.text).toBe('B 没发的')
  })

  it('keepText:发的不是输入框里的字(实时转写)→ 字留着,附件 / 引用 / @ 绑定清掉', () => {
    setDraftField('A', 'text', '还在写')
    setDraftField('A', 'mentionAgents', ['alice'])
    setDraftField('A', 'refChips', [{ token: '[[x]]', name: 'x', kind: 'file' }])
    clearDraft('A', true)
    expect(useComposerDrafts.getState().A).toMatchObject({ text: '还在写', mentionAgents: [], refChips: [] })
  })

  it('没发出去:新对话那份跟到刚建的会话;那边已有草稿就不动', () => {
    setDraftField(NEW_CHAT_DRAFT, 'text', '第一句')
    setDraftField(NEW_CHAT_DRAFT, 'mentionAgents', ['alice'])
    moveDraft(NEW_CHAT_DRAFT, 'created')
    expect(useComposerDrafts.getState().created).toMatchObject({ text: '第一句', mentionAgents: ['alice'] })
    expect(useComposerDrafts.getState()[NEW_CHAT_DRAFT]).toBeUndefined()

    setDraftField(NEW_CHAT_DRAFT, 'text', '又一句')
    moveDraft(NEW_CHAT_DRAFT, 'created')
    expect(useComposerDrafts.getState().created.text).toBe('第一句')
    expect(useComposerDrafts.getState()[NEW_CHAT_DRAFT].text).toBe('又一句')
    moveDraft(NEW_CHAT_DRAFT, NEW_CHAT_DRAFT) // 主页:输入框一直对着新对话
    expect(useComposerDrafts.getState()[NEW_CHAT_DRAFT].text).toBe('又一句')
  })
})
