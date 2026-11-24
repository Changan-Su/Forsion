// @vitest-environment happy-dom
/** Debounced (non-immediate) PlainMarkdownEditor — the workspace `.md` tab's editor. Milkdown's listener emits 200ms after
 *  the last edit and cancels that call on destroy; unmount must hand the held edit over instead (flush, not cancel),
 *  and must not hand anything over when nothing is held. Real-app probe: scripts/wsfile-close-flush.check.cjs. */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Selection } from '@milkdown/kit/prose/state'
import { addEditorExtension, clearEditorExtensions } from '../../plugins/editorExtensions'
import { PlainMarkdownEditor } from './MarkdownBlock'

const EXTENSION = 'test-debounced-flush'
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

type Props = { readOnly?: boolean; flushRef?: { current: (() => void) | null } }
async function mount(onChange: (body: string) => void, initial = 'Start', props: Props = {}): Promise<EditorView> {
  await act(async () => {
    root!.render(React.createElement(PlainMarkdownEditor, { initial, onChange, ...props }))
  })
  await act(async () => { await vi.waitFor(() => expect(view).not.toBeNull()) })
  // MilkdownInner only emits once its `ready` frame has passed.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
  return view!
}
const unmount = async (): Promise<void> => { await act(async () => { root!.unmount(); root = null }) }
const listenerWindow = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })
const type = (editor: EditorView, text: string): void => {
  act(() => { editor.dispatch(editor.state.tr.insertText(text, editor.state.doc.content.size - 1)) })
}

describe('debounced PlainMarkdownEditor hands held edits over on unmount', () => {
  it('unmount inside the 200ms window hands the last keystrokes to onChange', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    type(editor, ' tail')
    expect(changed).not.toHaveBeenCalled() // still debounced
    await unmount()
    expect(changed).toHaveBeenCalledExactlyOnceWith('Start tail\n')
  })

  it('flushed bytes equal the listener’s bytes for the same document', async () => {
    const viaListener = vi.fn()
    const first = await mount(viaListener, 'Start *em*')
    type(first, ' 中文\tx')
    await listenerWindow()
    expect(viaListener).toHaveBeenCalledOnce()
    await unmount()
    expect(viaListener).toHaveBeenCalledOnce() // nothing held after the listener's emit

    view = null
    root = createRoot(host)
    const viaFlush = vi.fn()
    const second = await mount(viaFlush, 'Start *em*')
    type(second, ' 中文\tx')
    await unmount()
    expect(viaFlush).toHaveBeenCalledExactlyOnceWith(viaListener.mock.calls[0][0])
  })

  it('untouched document: caret moves only, unmount hands nothing over', async () => {
    const changed = vi.fn()
    const editor = await mount(changed, '* star\n*   spaced')
    act(() => { editor.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc))) })
    await unmount()
    expect(changed).not.toHaveBeenCalled()
  })

  it('a doc change marked addToHistory:false is not handed over (the listener ignores it too)', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    act(() => { editor.dispatch(editor.state.tr.insertText(' quiet', editor.state.doc.content.size - 1).setMeta('addToHistory', false)) })
    await unmount()
    expect(changed).not.toHaveBeenCalled()
  })

  it('typed and undone inside the window: unmount hands nothing over', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    const end = editor.state.doc.content.size - 1
    type(editor, 'x')
    act(() => { editor.dispatch(editor.state.tr.delete(end, end + 1)) })
    await unmount()
    expect(changed).not.toHaveBeenCalled()
  })

  it('typed and undone, then a change marked addToHistory:false: unmount hands nothing over', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    const end = editor.state.doc.content.size - 1
    type(editor, 'x')
    act(() => { editor.dispatch(editor.state.tr.delete(end, end + 1)) })
    act(() => { editor.dispatch(editor.state.tr.insertText(' quiet', editor.state.doc.content.size - 1).setMeta('addToHistory', false)) })
    await unmount()
    expect(changed).not.toHaveBeenCalled()
  })

  it('typed and undone in a file whose headings get ids after mount: unmount hands nothing over', async () => {
    const changed = vi.fn()
    const editor = await mount(changed, '###   Title   ###\n\nBody')
    const end = editor.state.doc.content.size - 1
    type(editor, 'x')
    act(() => { editor.dispatch(editor.state.tr.delete(end, end + 1)) })
    await unmount()
    expect(changed).not.toHaveBeenCalled()
  })

  it('hands over the last edit’s document, like the listener: a later addToHistory:false change is not included', async () => {
    const changed = vi.fn()
    const editor = await mount(changed)
    type(editor, ' tail')
    act(() => { editor.dispatch(editor.state.tr.insertText(' quiet', editor.state.doc.content.size - 1).setMeta('addToHistory', false)) })
    await unmount()
    expect(changed).toHaveBeenCalledExactlyOnceWith('Start tail\n')
  })

  it('read-only editor never hands anything over', async () => {
    const changed = vi.fn()
    const editor = await mount(changed, 'Start', { readOnly: true })
    type(editor, ' tail')
    await unmount()
    expect(changed).not.toHaveBeenCalled()
  })

  it('flushRef hands the held edit over synchronously while the editor lives on', async () => {
    const changed = vi.fn()
    const flushRef: { current: (() => void) | null } = { current: null }
    const editor = await mount(changed, 'Start', { flushRef })
    type(editor, ' tail')
    act(() => { flushRef.current?.() })
    expect(changed).toHaveBeenCalledExactlyOnceWith('Start tail\n')
    await listenerWindow() // the listener's still-pending emit of the same text is not delivered again
    expect(changed).toHaveBeenCalledExactlyOnceWith('Start tail\n')
    type(editor, '!')
    await unmount()
    expect(changed).toHaveBeenLastCalledWith('Start tail!\n')
  })
})
