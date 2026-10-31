// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mountPluginChatBox } from './chatBoxSurface'
import { usePluginStore } from './pluginStore'
import { setLocaleGlobal } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { matchChatBoxSuggest, type PluginChatBoxHandle } from '../../../../shared/chatBox'
import type { PluginContext } from './types'
import { installModelPickerPresenter, type ModelPickerValues } from '../../components/modelPickerHost'
import '../../tangu/store/standalone' // 测试不走 activateTangu:自己装 Tangu 的 store 半身(界面热更新 3c)

let el: HTMLDivElement
let box: PluginChatBoxHandle | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setLocaleGlobal('zh')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  useApp.setState({ newChatModel: 'original', modelsResp: { directProviders: [], models: [{ id: 'original', name: 'Original', provider: 'test', source: 'direct' }], defaultModelId: 'original' } })
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  el = document.createElement('div'); document.body.append(el)
})
afterEach(async () => {
  await act(async () => { box?.dispose() })
  box = undefined; el.remove(); vi.unstubAllGlobals()
})
const input = () => el.querySelector('textarea')!
const submit = async () => { await act(async () => { (el.querySelector('.t2c-send') as HTMLButtonElement).click() }) }

describe('public Chat Box mount', () => {
  it('commits native model and effort together without overwriting the plugin draft or global model', async () => {
    useApp.setState({ modelsResp: { directProviders: [], models: [
      { id: 'original', name: 'Original', provider: 'test', source: 'direct' },
      { id: 'other', name: 'Other', provider: 'test', source: 'direct' },
    ], defaultModelId: 'original' } })
    const remove = installModelPickerPresenter(async () => ({ model: 'other', thinking: 'high' }))
    const onChange = vi.fn(), onSubmit = vi.fn(() => false)
    try {
      await act(async () => { box = mountPluginChatBox(el, { value: 'Keep my text', modelId: 'original', thinkingLevel: 'medium', onChange, onSubmit }) })
      await act(async () => { (el.querySelector('.model-pill-btn') as HTMLButtonElement).click() })
      expect(onChange).toHaveBeenLastCalledWith({ text: 'Keep my text', modelId: 'other', thinkingLevel: 'high' })
      await submit()
      expect(onSubmit).toHaveBeenLastCalledWith({ text: 'Keep my text', modelId: 'other', thinkingLevel: 'high' })
      expect(useApp.getState().newChatModel).toBe('original')
    } finally { remove() }
  })
  it('aborts the native presenter on plugin disposal and ignores a late result', async () => {
    let finish!: (value: ModelPickerValues) => void
    let signal!: AbortSignal
    const remove = installModelPickerPresenter((_request, s) => { signal = s; return new Promise(resolve => { finish = resolve }) })
    const onChange = vi.fn()
    try {
      await act(async () => { box = mountPluginChatBox(el, { onChange, onSubmit: () => false }) })
      await act(async () => { (el.querySelector('.model-pill-btn') as HTMLButtonElement).click() })
      expect(signal.aborted).toBe(false)
      await act(async () => { box!.dispose() })
      expect(signal.aborted).toBe(true)
      await act(async () => { finish({ model: 'original', thinking: 'high' }) })
      expect(onChange).not.toHaveBeenCalled()
    } finally { remove() }
  })
  it('falls back to the Web menu when the native host rejects', async () => {
    const remove = installModelPickerPresenter(async () => { throw new Error('older host') })
    try {
      await act(async () => { box = mountPluginChatBox(el, { onSubmit: () => false }) })
      await act(async () => { (el.querySelector('.model-pill-btn') as HTMLButtonElement).click() })
      expect(document.querySelector('.composer-menu--portal')).not.toBeNull()
    } finally { remove() }
  })
  it('updates in place, submits explicit model/effort, and preserves rejected drafts', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await act(async () => { box = mountPluginChatBox(el, { value: 'Keep this idea', modelId: 'chosen', thinkingLevel: 'high', onSubmit }) })
    const originalInput = input()
    await act(async () => { box!.update({ placeholder: 'Changed label' }); box!.focus() })
    expect(input()).toBe(originalInput)
    expect(document.activeElement).toBe(originalInput)
    await submit()
    expect(onSubmit).toHaveBeenCalledWith({ text: 'Keep this idea', modelId: 'chosen', thinkingLevel: 'high' })
    expect(input().value).toBe('Keep this idea')
    expect(useApp.getState().newChatModel).toBe('original')
    await submit()
    expect(input().value).toBe('')
  })
  it('locks duplicate submissions and ignores late acceptance after disposal', async () => {
    let done!: (accepted: boolean) => void
    const onChange = vi.fn()
    const onSubmit = vi.fn(() => new Promise<boolean>(resolve => { done = resolve }))
    await act(async () => { box = mountPluginChatBox(el, { value: 'Pending', onSubmit, onChange }) })
    await submit(); await submit()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await act(async () => { box!.dispose(); box!.dispose(); done(true) })
    expect(el.querySelector('textarea')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('keeps replacement drafts when an older submission completes', async () => {
    let done!: (accepted: boolean) => void
    await act(async () => { box = mountPluginChatBox(el, { value: 'Old', onSubmit: () => new Promise(resolve => { done = resolve }) }) })
    await submit()
    await act(async () => { box!.update({ value: 'New' }); done(true) })
    expect(input().value).toBe('New')
  })
  it('does not interpret IME confirmation or plain Enter as form submission', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false)
    await act(async () => { box = mountPluginChatBox(el, { value: 'Draft', onSubmit }) })
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, ctrlKey: true, bubbles: true }))
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
  it('follows the host locale in its separate React root', async () => {
    await act(async () => { box = mountPluginChatBox(el, { onSubmit: () => false }) })
    expect(input().getAttribute('aria-label')).toBe('输入内容')
    await act(async () => { setLocaleGlobal('en') })
    expect(input().getAttribute('aria-label')).toBe('Message')
  })
  it('host disables an already-mounted plugin without relying on its disposer', async () => {
    await act(async () => {
      usePluginStore.getState().init([{ id: 'chatbox-mounted', name: 'Mounted', version: '1', setup(ctx) {
        box = ctx.ui!.mountChatBox!(el, { value: 'Draft', onSubmit: () => false })
      } }])
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    expect(input()).not.toBeNull()
    await act(async () => { (el.querySelector('.model-pill-btn') as HTMLButtonElement).click() })
    expect(document.querySelector('.composer-menu--portal')).not.toBeNull()
    await act(async () => { usePluginStore.getState().disable('chatbox-mounted') })
    expect(el.querySelector('textarea')).toBeNull()
    expect(document.querySelector('.composer-menu--portal')).toBeNull()
  })
  it('host revokes mounts even when plugins forget cleanup, including pending imports', async () => {
    let ctx!: PluginContext
    await act(async () => {
      usePluginStore.getState().init([{ id: 'chatbox-test', name: 'Chat Box test', version: '1', setup(c) {
        ctx = c; box = c.ui!.mountChatBox!(el, { value: 'Plugin draft', onSubmit: () => false })
      } }])
      // Disable before the dynamic import can finish.
      usePluginStore.getState().disable('chatbox-test')
    })
    expect(el.querySelector('textarea')).toBeNull()
    await act(async () => { ctx.ui!.mountChatBox!(el, { value: 'Must stay revoked', onSubmit: () => false }); box!.update({ value: 'Too late' }) })
    expect(el.querySelector('textarea')).toBeNull()
  })
})

describe('public Chat Box slots', () => {
  const typeText = async (value: string, caret = value.length) => {
    const el = input()
    await act(async () => {
      el.focus()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
      el.selectionStart = el.selectionEnd = caret
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
  }
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
  }
  const rows = () => [...document.querySelectorAll('.chat-box-suggest .wiki-item')].map(r => r.textContent)
  const tags = { trigger: '#', items: (q: string) => ['产品', '产品/路线图', '设计'].filter(t => t.startsWith(q)).map(t => ({ label: `#${t}`, hint: '3', value: `#${t}` })) }

  it('modelPicker false hides the pill and reports the given selection, not a resolved default', async () => {
    const onSubmit = vi.fn(() => false)
    await act(async () => { box = mountPluginChatBox(el, { value: 'Memo', modelPicker: false, onSubmit }) })
    expect(el.querySelector('.model-pill-btn')).toBeNull()
    await submit()
    expect(onSubmit).toHaveBeenCalledWith({ text: 'Memo', modelId: '', thinkingLevel: 'medium' })
  })
  it('mounts the toolbar before the pill, cleans up on dispose and contains exceptions', async () => {
    const cleanup = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { box = mountPluginChatBox(el, { onSubmit: () => false, toolbar: slot => { slot.textContent = 'tools'; return cleanup } }) })
    const slot = el.querySelector('.t2c-plugin-toolbar')!
    expect(slot.textContent).toBe('tools')
    expect(slot.compareDocumentPosition(el.querySelector('.model-pill-btn')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => { box!.update({ placeholder: 'Same toolbar' }) })
    expect(cleanup).not.toHaveBeenCalled()
    await act(async () => { box!.dispose() })
    expect(cleanup).toHaveBeenCalledTimes(1)

    await act(async () => { box = mountPluginChatBox(el, { onSubmit: () => false, toolbar: () => { throw new Error('toolbar') } }) })
    expect(input()).not.toBeNull()
    await act(async () => { box!.dispose() })
    await act(async () => { box = mountPluginChatBox(el, { onSubmit: () => false, toolbar: () => () => { throw new Error('cleanup') } }) })
    await act(async () => { box!.dispose() })
    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
  it('opens on trigger + query, picks with Enter without submitting, and appends a space', async () => {
    const onSubmit = vi.fn(() => false)
    await act(async () => { box = mountPluginChatBox(el, { submitOn: 'enter', suggest: tags, onSubmit }) })
    await typeText('回顾 #产')
    expect(rows()).toEqual(['#产品3', '#产品/路线图3'])
    await press('ArrowDown')
    await press('Enter')
    expect(input().value).toBe('回顾 #产品/路线图 ')
    expect(input().selectionStart).toBe(input().value.length)
    expect(rows()).toEqual([])
    expect(onSubmit).not.toHaveBeenCalled()
    await press('Enter')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
  it('replaces only the query when the caret is mid-text', async () => {
    await act(async () => { box = mountPluginChatBox(el, { suggest: tags, onSubmit: () => false }) })
    await typeText('a #设 b', 4)
    await press('Tab')
    expect(input().value).toBe('a #设计  b')
  })
  it('stays closed mid-word, after a word character, and on an empty query', async () => {
    await act(async () => { box = mountPluginChatBox(el, { suggest: tags, onSubmit: () => false }) })
    await typeText('a#产')
    expect(rows()).toEqual([])
    await typeText('#')
    expect(rows()).toEqual([])
    await typeText('#产品后面', 2)
    expect(rows()).toEqual([])
  })
  it('Esc holds for this word and comes back for the next one', async () => {
    await act(async () => { box = mountPluginChatBox(el, { suggest: tags, onSubmit: () => false }) })
    await typeText('#产')
    await press('Escape')
    expect(rows()).toEqual([])
    await typeText('#产品')
    expect(rows()).toEqual([])
    await typeText('#产品 #设')
    expect(rows()).toEqual(['#设计3'])
  })
  it('waits for IME composition and looks at the finished text', async () => {
    await act(async () => { box = mountPluginChatBox(el, { suggest: tags, onSubmit: () => false }) })
    await act(async () => { input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    await typeText('#产')
    expect(rows()).toEqual([])
    await act(async () => { input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await Promise.resolve() })
    expect(rows()).toEqual(['#产品3', '#产品/路线图3'])
  })
  it('leaves keys alone during composition', async () => {
    const onSubmit = vi.fn(() => false)
    await act(async () => { box = mountPluginChatBox(el, { suggest: tags, onSubmit }) })
    await typeText('#产')
    await press('Enter', { isComposing: true })
    expect(input().value).toBe('#产')
    expect(rows()).toHaveLength(2)
  })
  it('drops stale async items and survives a rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const waiting: Array<(v: Array<{ label: string; value: string }>) => void> = []
    const items = vi.fn((q: string) => (q === 'boom' ? Promise.reject(new Error('boom')) : new Promise<Array<{ label: string; value: string }>>(r => { waiting.push(r) })))
    await act(async () => { box = mountPluginChatBox(el, { suggest: { trigger: '#', items }, onSubmit: () => false }) })
    await typeText('#a')
    await typeText('#ab')
    await act(async () => { waiting[1]([{ label: 'new', value: '#new' }]); await Promise.resolve() })
    await act(async () => { waiting[0]([{ label: 'old', value: '#old' }]); await Promise.resolve() })
    expect(rows()).toEqual(['new'])
    await typeText('#boom')
    await act(async () => { await Promise.resolve() })
    expect(rows()).toEqual([])
    error.mockRestore()
  })
  it('insertText replaces the selection, places the caret after it and focuses', async () => {
    const onChange = vi.fn()
    await act(async () => { box = mountPluginChatBox(el, { value: 'abcd', onChange, onSubmit: () => false }) })
    input().selectionStart = 1; input().selectionEnd = 3
    await act(async () => { box!.insertText('#') })
    expect(input().value).toBe('a#d')
    expect(input().selectionStart).toBe(2)
    expect(document.activeElement).toBe(input())
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'a#d' }))
    await act(async () => { box!.insertText('x'); box!.insertText('y') })
    expect(input().value).toBe('a#xyd')
  })
  it('the public ctx handle queues insertText until the mount lands', async () => {
    await act(async () => {
      usePluginStore.getState().init([{ id: 'chatbox-insert', name: 'Insert', version: '1', setup(ctx) {
        box = ctx.ui!.mountChatBox!(el, { value: 'Hello ', onSubmit: () => false })
        box.insertText('world')
      } }])
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    expect(input().value).toBe('Hello world')
  })
})

describe('matchChatBoxSuggest', () => {
  it('finds the query before the caret', () => {
    expect(matchChatBoxSuggest('hi #产品', 6, '#')).toEqual({ query: '产品', from: 3, to: 6 })
    expect(matchChatBoxSuggest('#a/b-c_1', 8, '#')).toEqual({ query: 'a/b-c_1', from: 0, to: 8 })
    expect(matchChatBoxSuggest('line\n#a', 7, '#')).toEqual({ query: 'a', from: 5, to: 7 })
  })
  it('escapes the trigger', () => {
    expect(matchChatBoxSuggest('x $a', 4, '$')).toEqual({ query: 'a', from: 2, to: 4 })
    expect(matchChatBoxSuggest('x /a', 4, '/')).toEqual({ query: 'a', from: 2, to: 4 })
    expect(matchChatBoxSuggest('x ::a', 5, '::')).toEqual({ query: 'a', from: 2, to: 5 })
  })
  it('refuses an empty query, a mid-word trigger, a caret inside a word and an empty trigger', () => {
    expect(matchChatBoxSuggest('#', 1, '#')).toBeNull()
    expect(matchChatBoxSuggest('a#b', 3, '#')).toBeNull()
    expect(matchChatBoxSuggest('#abc', 2, '#')).toBeNull()
    expect(matchChatBoxSuggest('#a', 2, '')).toBeNull()
  })
})
