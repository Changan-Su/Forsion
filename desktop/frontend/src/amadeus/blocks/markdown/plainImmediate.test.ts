// @vitest-environment happy-dom
/** 真 Milkdown 装配验证：记录正文必须在关闭前同步交给 store，不能等 200ms listener。 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@milkdown/kit/prose/view'
import { addEditorExtension, clearEditorExtensions } from '../../plugins/editorExtensions'
import { PlainMarkdownEditor } from './MarkdownBlock'

const EXTENSION = 'test-record-immediate-save'
let host: HTMLDivElement
let root: Root | null
let view: EditorView | null

beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  view = null
  addEditorExtension(EXTENSION, ({ Plugin }) => [new Plugin({
    view: (created) => { view = created; return {} },
  })])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  clearEditorExtensions(EXTENSION)
  host.remove()
  vi.unstubAllGlobals()
})

async function mount(onChange: (body: string) => void, immediate = true): Promise<EditorView> {
  await act(async () => {
    root!.render(React.createElement(PlainMarkdownEditor, { initial: 'Start', immediate, onChange }))
  })
  await act(async () => { await vi.waitFor(() => expect(view).not.toBeNull()) })
  return view!
}

describe('记录正文即时保存', () => {
  it('最后一次输入事务返回时已回调，马上卸载也不丢尾字', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    changed.mockClear()
    act(() => {
      editor.dispatch(editor.state.tr.insertText('最后一个字', editor.state.doc.content.size - 1))
      expect(changed).toHaveBeenLastCalledWith('Start最后一个字\n')
    })
    const calls = changed.mock.calls.length
    await act(async () => { root!.unmount(); root = null })
    expect(changed).toHaveBeenCalledTimes(calls)
    expect(changed).toHaveBeenLastCalledWith('Start最后一个字\n')
  })

  it('重渲染后使用最新写回函数，延迟 listener 不重复提交同一内容', async () => {
    const first = vi.fn(), second = vi.fn()
    const editor = await mount(first)
    first.mockClear()
    await act(async () => {
      root!.render(React.createElement(PlainMarkdownEditor, { initial: 'Start', immediate: true, onChange: second }))
    })
    act(() => { editor.dispatch(editor.state.tr.insertText(' new', editor.state.doc.content.size - 1)) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith('Start new\n')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(second).toHaveBeenCalledExactlyOnceWith('Start new\n')
  })

  it('同一记录的外部正文原位回灌,同步及延迟 listener 都不回写', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    const dom = editor.dom
    changed.mockClear()
    await act(async () => {
      root!.render(React.createElement(PlainMarkdownEditor, {
        initial: '# External\n\n来自另一处的 **正文**。\n', immediate: true, onChange: changed,
      }))
    })
    expect(view).toBe(editor)
    expect(view!.dom).toBe(dom)
    expect(editor.state.doc.textContent).toBe('External来自另一处的 正文。')
    expect(dom.querySelector('h1')?.textContent).toBe('External')
    expect(dom.querySelector('strong')?.textContent).toBe('正文')
    expect(changed).not.toHaveBeenCalled()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(changed).not.toHaveBeenCalled()
    act(() => { editor.dispatch(editor.state.tr.insertText('继续编辑', editor.state.doc.content.size - 1)) })
    expect(changed).toHaveBeenCalledOnce()
    expect(changed.mock.calls[0][0]).toContain('继续编辑')
  })

  it('自身输入经父组件回传后保持编辑器实例和光标,不产生循环', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    const dom = editor.dom
    changed.mockClear()
    act(() => { editor.dispatch(editor.state.tr.insertText('中间', 3)) })
    expect(changed).toHaveBeenCalledExactlyOnceWith('St中间art\n')
    const selection = editor.state.selection
    await act(async () => {
      root!.render(React.createElement(PlainMarkdownEditor, {
        initial: changed.mock.calls[0][0], immediate: true, onChange: changed,
      }))
    })
    expect(view).toBe(editor)
    expect(view!.dom).toBe(dom)
    expect(editor.state.selection.eq(selection)).toBe(true)
    expect(changed).toHaveBeenCalledOnce()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(changed).toHaveBeenCalledOnce()
  })

  it('外部修改赶在本地 listener 防抖结束前到达,不回写旧正文或外部正文', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    act(() => { editor.dispatch(editor.state.tr.insertText(' local', editor.state.doc.content.size - 1)) })
    expect(changed).toHaveBeenCalledExactlyOnceWith('Start local\n')
    await act(async () => {
      root!.render(React.createElement(PlainMarkdownEditor, {
        initial: 'Latest external', immediate: true, onChange: changed,
      }))
    })
    expect(editor.state.doc.textContent).toBe('Latest external')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(changed).toHaveBeenCalledExactlyOnceWith('Start local\n')
  })

  it('普通模式仍只使用初始值,不受即时模式的回灌契约影响', async () => {
    const changed = vi.fn()
    const editor = await mount(changed, false)
    await act(async () => {
      root!.render(React.createElement(PlainMarkdownEditor, { initial: 'External', onChange: changed }))
    })
    expect(editor.state.doc.textContent).toBe('Start')
    expect(changed).not.toHaveBeenCalled()
  })
})
