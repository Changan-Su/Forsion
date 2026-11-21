// @vitest-environment happy-dom
/** `mountChatBox({ format })`: the same box with the trimmed Amadeus editor instead of the textarea.
 *  happy-dom has no real typing, so text goes in through the handle's insertText (a real transaction, same path as a
 *  keystroke for the box: onChange → suggest re-read). Input rules and IME are covered in Electron (instrument/verify-mentions.cjs). */
import { act } from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mountPluginChatBox } from './chatBoxSurface'
import { setLocaleGlobal } from '../../i18n'
import { useApp } from '../../stores/appStore'
import type { PluginChatBoxHandle } from '../../../../shared/chatBox'
import { Slice, Fragment } from '@milkdown/kit/prose/model'
import { flattenSlice } from '../../components/chatbox/ChatBoxEditor'
import '../../tangu/store/standalone' // the Chat Box reads agent defs from Tangu's store
import { usePluginStore } from './pluginStore'

let el: HTMLDivElement
let box: PluginChatBoxHandle | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setLocaleGlobal('zh')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  useApp.setState({ newChatModel: 'original', modelsResp: { directProviders: [], models: [{ id: 'original', name: 'Original', provider: 'test', source: 'direct' }], defaultModelId: 'original' } })
  el = document.createElement('div'); document.body.append(el)
})
afterEach(async () => {
  await act(async () => { box?.dispose() })
  box = undefined; el.remove(); vi.unstubAllGlobals()
})

const editor = () => el.querySelector<HTMLElement>('.t2c-ed')
/** Milkdown starts asynchronously: wait for the editor's DOM. */
async function ready(): Promise<HTMLElement> {
  for (let i = 0; i < 50 && !editor(); i++) await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  return editor()!
}
const type = async (text: string) => { await act(async () => { box!.insertText(text); await Promise.resolve() }) }
const press = async (key: string, init: KeyboardEventInit = {}) => {
  await act(async () => { editor()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}
const rows = () => [...document.querySelectorAll('.chat-box-suggest .wiki-item-name')].map(r => r.textContent)
const tags = { trigger: '#', items: (q: string) => ['产品', '产品/路线图', '设计'].filter(t => t.startsWith(q)).map(t => ({ label: `#${t}`, hint: '3', value: `#${t}` })) }
const mount = async (opts: Parameters<typeof mountPluginChatBox>[1]) => {
  await act(async () => { box = mountPluginChatBox(el, { modelPicker: false, format: 'inline', ...opts }) })
  return ready()
}

describe('format: inline', () => {
  it('shows the stored formatting, and neither mounting nor update({ value }) echoes onChange', async () => {
    const onChange = vi.fn()
    const ed = await mount({ value: '**会前材料**：设计 [[评审议程]]', onChange, onSubmit: () => false })
    expect(el.querySelector('textarea')).toBeNull()
    expect(ed.querySelector('strong')?.textContent).toBe('会前材料')
    expect(ed.textContent).toBe('会前材料：设计 [[评审议程]]')
    await act(async () => { box!.update({ value: 'snake_case 5*3' }) })
    expect(ed.textContent).toBe('snake_case 5*3')
    expect(ed.querySelector('strong')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('stores typed text as typed and submits what is on screen in the same tick', async () => {
    const onChange = vi.fn(), onSubmit = vi.fn(() => true)
    await mount({ submitOn: 'enter', onChange, onSubmit })
    await type('snake_case')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'snake_case' }))
    // Typed then Enter before React re-rendered: the submission is the new text, not the last render's.
    await act(async () => {
      box!.insertText(' https://a.b/x_y?p=1&q=2')
      editor()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: 'snake_case https://a.b/x_y?p=1&q=2' }))
    await act(async () => { await Promise.resolve() })
    expect(editor()!.textContent).toBe('') // accepted → cleared
  })
  it('one line: Shift+Enter does nothing, Enter in modifier mode does nothing, ⌘Enter submits', async () => {
    const onChange = vi.fn(), onSubmit = vi.fn(() => false)
    await mount({ value: 'a', onChange, onSubmit })
    await press('Enter', { shiftKey: true })
    await press('Enter')
    expect(onChange).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    await press('Enter', { metaKey: true })
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: 'a' }))
  })
  it('opens # suggestions at the caret; Enter picks without submitting', async () => {
    const onChange = vi.fn(), onSubmit = vi.fn(() => false)
    await mount({ submitOn: 'enter', suggest: tags, onChange, onSubmit })
    await type('回顾 #产')
    expect(rows()).toEqual(['#产品', '#产品/路线图'])
    await press('ArrowDown')
    await press('Enter')
    expect(rows()).toEqual([])
    expect(onSubmit).not.toHaveBeenCalled()
    expect(editor()!.textContent).toBe('回顾 #产品/路线图 ')
    // the space after a pick stays on screen (typing goes on after it); the value has no edge whitespace (11-21 acceptance)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: '回顾 #产品/路线图' }))
    await press('Enter')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
  it('the host @ panel: a date the plugin takes removes the typed @query', async () => {
    const onMention = vi.fn(() => true as const)
    await mount({ submitOn: 'enter', mentions: ['date'], onMention, onSubmit: () => false })
    await type('交周报 @明')
    expect(rows()).toEqual(['明天'])
    await press('Enter')
    expect(onMention).toHaveBeenCalledWith(expect.objectContaining({ kind: 'date' }))
    expect(editor()!.textContent).toBe('交周报 ')
  })
  it('does not write a stale pick over a draft the plugin replaced', async () => {
    await mount({ suggest: { trigger: '#', items: () => [{ label: 'alpha', value: '#alpha' }] }, onSubmit: () => false })
    await type('#a')
    expect(rows()).toEqual(['alpha'])
    await act(async () => { box!.update({ value: 'OK' }) })
    await press('Enter')
    expect(editor()!.textContent).toBe('OK')
  })
  it('a plugin disposing the box inside onMention: nothing is written afterwards', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onChange = vi.fn()
    await mount({ mentions: ['date'], onMention: () => { box!.dispose(); return false }, onChange, onSubmit: () => false })
    await type('@明')
    onChange.mockClear()
    await press('Enter')
    expect(onChange).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
  it('insertText before the editor is up lands in the value', async () => {
    const onChange = vi.fn()
    await act(async () => { box = mountPluginChatBox(el, { modelPicker: false, format: 'inline', value: 'a', onChange, onSubmit: () => false }); box.insertText('b') })
    const ed = await ready()
    expect(ed.textContent).toBe('ab')
  })
  it('a pasted multi-block slice becomes one line', async () => {
    await mount({ onSubmit: () => false })
    // A two-paragraph slice in the editor's schema, as pasting two lines gives.
    const { Editor, editorViewCtx, rootCtx } = await import('@milkdown/kit/core')
    const { chatBoxEditorPlugins } = await import('../../components/chatbox/editorPlugins')
    const root = document.createElement('div')
    const ed = await Editor.make().config((ctx) => { ctx.set(rootCtx, root) }).use(chatBoxEditorPlugins('basic')).create()
    const schema = ed.action((ctx) => ctx.get(editorViewCtx).state.schema)
    const slice = new Slice(Fragment.from([schema.nodes.paragraph.create(null, schema.text('第一行')), schema.nodes.paragraph.create(null, schema.text('第二行'))]), 0, 0)
    const flat = flattenSlice(slice, schema)
    expect(flat.content.childCount).toBe(1)
    expect(flat.content.firstChild!.textContent).toBe('第一行 第二行')
    await ed.destroy()
  })
})

describe('format: review 11-21', () => {
  it('update({ value }) shows at once: Enter in the same tick submits what is on screen, typing appends to it', async () => {
    const onSubmit = vi.fn(() => false)
    await mount({ submitOn: 'enter', value: 'A', onSubmit })
    await act(async () => {
      box!.update({ value: 'B' })
      expect(editor()!.textContent).toBe('B')
      editor()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: 'B' }))
    const onChange = vi.fn()
    await act(async () => { box!.update({ value: 'C', onChange }); box!.insertText('!') })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'C!' }))
  })
  it('a value with a hard break mounts (as one line)', async () => {
    const ed = await mount({ value: 'A  \nB', onSubmit: () => false })
    expect(ed.textContent).toBe('A B')
  })
  it('text inserted while the editor starts is text, not Markdown', async () => {
    const onChange = vi.fn()
    await act(async () => { box = mountPluginChatBox(el, { modelPicker: false, format: 'inline', onChange, onSubmit: () => false }); box.insertText('**x**') })
    const ed = await ready()
    expect(ed.querySelector('strong')).toBeNull()
    expect(ed.textContent).toBe('**x**')
  })
  it('a swapped value closes the menu: Enter does not write the pick into the old range (basic, two paragraphs)', async () => {
    const onSubmit = vi.fn(() => false)
    await mount({ format: 'basic', submitOn: 'enter', suggest: { trigger: '#', items: () => [{ label: 'xyz', value: '#xyz' }] }, onSubmit })
    await type('#x')
    expect(rows()).toEqual(['xyz'])
    await act(async () => { box!.update({ value: '#x\n\nNew draft' }) })
    expect(rows()).toEqual([])
    await press('Enter')
    expect(editor()!.textContent).not.toContain('#xyz')
  })
  it('rows that arrive after the caret left do not open a menu', async () => {
    let finish!: (v: Array<{ label: string; value: string }>) => void
    await mount({ suggest: { trigger: '#', items: () => new Promise(r => { finish = r }) }, onSubmit: () => false })
    await type('#a')
    await act(async () => { box!.update({ value: 'elsewhere' }) })
    await act(async () => { finish([{ label: 'alpha', value: '#alpha' }]); await Promise.resolve() })
    expect(rows()).toEqual([])
  })
  it('a second composition starting before the first one settles keeps its guard up', async () => {
    const ed = await mount({ suggest: tags, onSubmit: () => false })
    await act(async () => {
      ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      ed.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    await type('#产')
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    expect(rows()).toEqual([])
  })
})

describe('format: review 11-21 (second pass)', () => {
  it('a swapped value closes the menu even where the caret and the query line up again', async () => {
    const onSubmit = vi.fn(() => false)
    await mount({ submitOn: 'enter', suggest: { trigger: '#', items: () => [{ label: 'xyz', value: '#xyz' }] }, onSubmit })
    await type('one #x')
    expect(rows()).toEqual(['xyz'])
    await act(async () => { box!.update({ value: 'two #x' }) })
    expect(rows()).toEqual([])
    await press('Enter')
    expect(editor()!.textContent).toBe('two #x')
  })
  it('links draw a live href only for http(s) / mailto; the stored text keeps what was written', async () => {
    const onChange = vi.fn()
    const ed = await mount({ value: '[a](javascript:alert) [b](https://x.test/) [c](mailto:m@x.test)', onChange, onSubmit: () => false })
    const links = [...ed.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([null, 'https://x.test/', 'mailto:m@x.test'])
    await type('!')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('[a](javascript:alert)') }))
  })
  it('the public ctx handle: insertText before the mount lands is text, not Markdown', async () => {
    const onChange = vi.fn()
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    await act(async () => {
      usePluginStore.getState().init([{ id: 'chatbox-format-insert', name: 'Insert', version: '1', setup(ctx) {
        box = ctx.ui!.mountChatBox!(el, { modelPicker: false, format: 'inline', value: '**a** b', onChange, onSubmit: () => false })
        box.insertText('**x**')
      } }])
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    const ed = await ready()
    expect([...ed.querySelectorAll('strong')].map((b) => b.textContent)).toEqual(['a'])
    expect(ed.textContent).toBe('a b**x**')
  })
})

describe('format: basic', () => {
  it('holds lists; Enter in a list item does not submit, Shift+Enter is a line break', async () => {
    const onChange = vi.fn(), onSubmit = vi.fn(() => false)
    const ed = await mount({ format: 'basic', submitOn: 'enter', value: '- a\n- b', onChange, onSubmit })
    expect(ed.querySelectorAll('li')).toHaveLength(2)
    await press('Enter')
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => { box!.update({ value: 'x' }) })
    await press('Enter', { shiftKey: true })
    expect(ed.querySelector('br')).not.toBeNull()
    await press('Enter')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
  it('still writes no headings: `# x` is text', async () => {
    const ed = await mount({ format: 'basic', value: '# 标题\n\n> 引用', onSubmit: () => false })
    expect(ed.querySelector('h1')).toBeNull()
    expect(ed.querySelector('blockquote')?.textContent).toBe('引用')
    expect(ed.textContent).toContain('# 标题')
  })
})
