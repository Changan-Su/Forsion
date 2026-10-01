// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mountPluginChatBox } from './chatBoxSurface'
import { usePluginStore } from './pluginStore'
import { setLocaleGlobal } from '../../i18n'
import { useApp } from '../../stores/appStore'
import type { PluginChatBoxHandle } from '../../../../shared/chatBox'
import type { PluginContext } from './types'
import { installModelPickerPresenter, type ModelPickerValues } from '../../components/modelPickerHost'

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
