// @vitest-environment happy-dom
/** Plugin Markdown editor × IME composition: the editor holds edits while composing, so getValue() and
 *  dispose() must take them first — a plugin that submits right after the last word must still see it. */
import * as React from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@milkdown/kit/prose/view'
import { addEditorExtension, clearEditorExtensions } from './editorExtensions'
import { mountPluginMarkdownEditor } from './markdownEditorSurface'

const EXTENSION = 'test-plugin-editor-composition'
let view: EditorView | null
let el: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  view = null
  addEditorExtension(EXTENSION, ({ Plugin }) => [new Plugin({ view: (created) => { view = created; return {} } })])
  el = document.body.appendChild(document.createElement('div'))
})

afterEach(() => {
  clearEditorExtensions(EXTENSION)
  el.remove()
  vi.unstubAllGlobals()
})

async function mount(onChange: (md: string) => void) {
  let handle!: ReturnType<typeof mountPluginMarkdownEditor>
  await act(async () => { handle = mountPluginMarkdownEditor(el, { value: 'Start', modes: false, onChange }) })
  await act(async () => { await vi.waitFor(() => expect(view).not.toBeNull()) })
  return { handle, editor: view! }
}
const compose = (editor: EditorView, type: 'compositionstart' | 'compositionend'): void => {
  editor.dom.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: '' }))
}
const typeAtEnd = (editor: EditorView, text: string): void => {
  editor.dispatch(editor.state.tr.insertText(text, editor.state.doc.content.size - 1))
}

describe('插件 Markdown 编辑器 × 输入法组字', () => {
  it('组字中途 getValue() 拿到屏上的内容(含组字串)', async () => {
    const changed = vi.fn()
    const { handle, editor } = await mount(changed)
    act(() => { compose(editor, 'compositionstart'); typeAtEnd(editor, 'pin') })
    expect(changed).not.toHaveBeenCalled()
    let got = ''
    act(() => { got = handle.getValue() })
    expect(got).toBe('Startpin\n')
    expect(changed).toHaveBeenLastCalledWith('Startpin\n')
    await act(async () => { handle.dispose() })
  })

  it('提交后 40ms 内 getValue() 拿到提交后的字', async () => {
    const changed = vi.fn()
    const { handle, editor } = await mount(changed)
    act(() => { compose(editor, 'compositionstart'); typeAtEnd(editor, 'zhongwen') })
    act(() => {
      const at = editor.state.doc.content.size - 1
      editor.dispatch(editor.state.tr.insertText('中文', at - 'zhongwen'.length, at))
      compose(editor, 'compositionend')
    })
    let got = ''
    act(() => { got = handle.getValue() }) // before the 40ms post-composition send
    expect(got).toBe('Start中文\n')
    await act(async () => { handle.dispose() })
  })

  it('组字中途 dispose:之前收到一次含当时内容的 onChange,之后不再回调', async () => {
    const changed = vi.fn()
    const { handle, editor } = await mount(changed)
    act(() => { compose(editor, 'compositionstart'); typeAtEnd(editor, '한') })
    expect(changed).not.toHaveBeenCalled()
    await act(async () => { handle.dispose() })
    expect(changed).toHaveBeenCalledExactlyOnceWith('Start한\n')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
    expect(changed).toHaveBeenCalledOnce()
    expect(handle.getValue()).toBe('Start한\n')
  })
})
