/** DOM plugin adapter for the same Chat Box used by first-party prompt Views. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChatBox, useChatBoxSelection, type ChatBoxSelection, type ChatBoxSubmission } from '../../components/chatbox'
import { textareaCaretRect } from '../../components/chatbox/textareaCaret'
import { SuggestMenu } from '../lib/SuggestMenu'
import { HostLocaleProvider, registerMessages, useI18n } from '../../i18n'
import { ChatBox as ChatBoxBase, mountHostReact, type ChatBoxProps as BaseChatBoxProps } from '@lcl/components'
import { matchChatBoxSuggest, type ChatBoxSuggestMatch, type PluginChatBoxHandle, type PluginChatBoxOptions, type PluginChatBoxSuggestItem } from '../../../../shared/chatBox'

registerMessages({
  'chatbox.label': { zh: '输入内容', en: 'Message' },
  'chatbox.submitFailed': { zh: '提交失败，内容已保留，请重试。', en: 'Submission failed. Your draft is preserved; try again.' },
})

const SUGGEST_LIMIT = 8

/** What the mount hands the tree, and what the tree hands back for the handle. */
interface Host {
  input: { current: HTMLTextAreaElement | null }
  /** Set once the box has rendered. */
  insertText?(text: string): void
}
interface BoxProps { options: PluginChatBoxOptions; revision: number; host: Host; isAlive(): boolean }

interface SuggestMenuState {
  match: ChatBoxSuggestMatch
  items: PluginChatBoxSuggestItem[]
  left: number
  top: number
  anchorTop: number
}

/** The textarea side of `suggest`: when to open, what to show, where. Reads options live, so update() takes effect at once. */
function useChatBoxSuggest({ options, host }: BoxProps, replace: (match: ChatBoxSuggestMatch, text: string) => void) {
  const [menu, setMenu] = useState<SuggestMenuState | null>(null)
  const request = useRef(0)
  const composing = useRef(false)
  const dismissedAt = useRef<number | null>(null) // Esc holds for this trigger until the word ends, as in the editor
  const close = () => { request.current++; setMenu(null) }
  /** Only called when the user changed the text: moving the caret onto an old tag must not open the menu and trap ↑↓. */
  const evaluate = (value: string) => {
    const suggest = options.suggest
    const el = host.input.current
    const collapsed = !!el && el.selectionStart === el.selectionEnd
    const match = suggest && el && collapsed && !composing.current && !options.disabled
      ? matchChatBoxSuggest(value, el.selectionStart, suggest.trigger)
      : null
    if (!match) { dismissedAt.current = null; close(); return }
    if (dismissedAt.current === match.from) { close(); return }
    setMenu(cur => (cur ? { ...cur, match } : null)) // keep the range current while new items load
    const id = ++request.current
    void Promise.resolve().then(() => suggest!.items(match.query)).then(found => {
      if (id !== request.current) return
      const items = (Array.isArray(found) ? found : []).filter(i => typeof i?.label === 'string' && typeof i?.value === 'string').slice(0, SUGGEST_LIMIT)
      if (!items.length || !el) { setMenu(null); return }
      const at = textareaCaretRect(el, match.to)
      setMenu({ match, items, left: at.left, top: at.bottom, anchorTop: at.top })
    }).catch(e => {
      console.error('[amadeus] plugin Chat Box suggest failed', e)
      if (id === request.current) setMenu(null)
    })
  }
  return {
    evaluate,
    inputProps: {
      onCompositionStart: () => { composing.current = true; close() },
      // Chromium fires the last input before compositionend, so a finished `#产` has to be looked at here.
      onCompositionEnd: (e: { currentTarget: HTMLTextAreaElement }) => { composing.current = false; evaluate(e.currentTarget.value) },
      onBlur: close,
      onSelect: (e: { currentTarget: HTMLTextAreaElement }) => { if (menu && e.currentTarget.selectionStart !== menu.match.to) close() },
    },
    menu: menu && createPortal(
      // Outside the card: its container-type would capture position:fixed. The classes carry the menu's scoped styles.
      <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
        <SuggestMenu
          className="chat-box-suggest"
          resetKey={menu.match.query}
          items={menu.items.map((i, k) => ({ key: `${k}:${i.value}`, label: i.label, hint: i.hint }))}
          left={menu.left}
          top={menu.top}
          anchorTop={menu.anchorTop}
          onPick={i => { const m = menu.match; close(); replace(m, `${menu.items[i].value} `) }}
          onClose={() => { dismissedAt.current = menu.match.from; close() }}
          focused={() => document.activeElement === host.input.current}
        />
      </div>,
      document.body,
    ),
  }
}

/** Draft, submit and suggest behaviour, independent of whether a model pill is drawn. */
function usePluginDraft(props: BoxProps, selection: ChatBoxSelection, setSelection: (next: ChatBoxSelection) => void) {
  const { options, revision, host, isAlive } = props
  const { t } = useI18n()
  const [text, setText] = useState(options.value || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const sending = useRef(false)
  const caretAfter = useRef<number | null>(null)
  useEffect(() => { if (options.value !== undefined) setText(options.value) }, [options.value, revision])
  // A controlled value change sends the caret to the end; put it back where the edit ended.
  useLayoutEffect(() => {
    const el = host.input.current
    if (caretAfter.current === null || !el) return
    el.selectionStart = el.selectionEnd = caretAfter.current
    caretAfter.current = null
  })
  const change = (draft: ChatBoxSubmission) => {
    setText(draft.text); setSelection(draft); setError(false)
    // The mount retains the draft across update() calls that only change presentation.
    options.value = draft.text; options.modelId = draft.modelId; options.thinkingLevel = draft.thinkingLevel
    options.onChange?.(draft)
  }
  const replace = (match: { from: number; to: number }, inserted: string) => {
    const value = options.value ?? text
    caretAfter.current = match.from + inserted.length
    change({ ...selection, text: value.slice(0, match.from) + inserted + value.slice(match.to) })
  }
  const suggest = useChatBoxSuggest(props, replace)
  host.insertText = inserted => {
    const el = host.input.current
    const start = caretAfter.current ?? el?.selectionStart ?? text.length
    const end = caretAfter.current ?? el?.selectionEnd ?? text.length
    replace({ from: start, to: end }, inserted)
    el?.focus()
  }
  const box: Omit<BaseChatBoxProps, 'controls'> = {
    value: text,
    onValueChange: value => { change({ ...selection, text: value }); suggest.evaluate(value) },
    inputRef: host.input,
    inputProps: { ...suggest.inputProps, 'aria-label': options.label || t('chatbox.label'), placeholder: options.placeholder },
    disabled: options.disabled || busy,
    submitDisabled: !text.trim(),
    submitOn: options.submitOn,
    submitLabel: options.submitLabel || t('input.send'),
    afterInput: <>
      {error ? <p role="alert">{t('chatbox.submitFailed')}</p> : undefined}
      {suggest.menu}
    </>,
    onSubmit: () => {
      if (sending.current || !text.trim() || !isAlive()) return
      sending.current = true; setBusy(true); setError(false)
      const submitted = { ...selection, text }
      void Promise.resolve().then(() => options.onSubmit(submitted)).then(accepted => {
        if (isAlive() && accepted && options.value === submitted.text) change({
          modelId: options.modelId ?? selection.modelId,
          thinkingLevel: options.thinkingLevel ?? selection.thinkingLevel,
          text: '',
        })
      }).catch(() => { if (isAlive()) setError(true) }).finally(() => {
        sending.current = false
        if (isAlive()) setBusy(false)
      })
    },
  }
  return { box, change, text }
}

/** Plugin DOM inside the card. React only owns the slot element, so it never touches what the plugin put in it. */
function ToolbarSlot({ toolbar }: { toolbar: NonNullable<PluginChatBoxOptions['toolbar']> }) {
  const slot = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = slot.current!
    let cleanup: void | (() => void)
    try { cleanup = toolbar(el) } catch (e) { console.error('[amadeus] plugin Chat Box toolbar failed', e) }
    return () => {
      try { if (typeof cleanup === 'function') cleanup() } catch (e) { console.error('[amadeus] plugin Chat Box toolbar cleanup failed', e) }
      el.replaceChildren()
    }
  }, [toolbar])
  return <span ref={slot} className="t2c-plugin-toolbar" />
}

function PickerChatBox(props: BoxProps) {
  const { options } = props
  const [selection, setSelection] = useChatBoxSelection(options.agentSlug)
  const effective = {
    modelId: options.modelId ?? selection.modelId,
    thinkingLevel: options.thinkingLevel ?? selection.thinkingLevel,
  }
  const { box, change, text } = usePluginDraft(props, effective, setSelection)
  return <ChatBox {...box} selection={effective} onSelectionChange={value => change({ ...value, text })} leadingControls={toolbarOf(options)} />
}

function BareChatBox(props: BoxProps) {
  const { options } = props
  const selection: ChatBoxSelection = { modelId: options.modelId ?? '', thinkingLevel: options.thinkingLevel ?? 'medium' }
  const { box } = usePluginDraft(props, selection, () => {})
  return <ChatBoxBase {...box} controls={toolbarOf(options)} />
}

const toolbarOf = (options: PluginChatBoxOptions): ReactNode => (options.toolbar ? <ToolbarSlot toolbar={options.toolbar} /> : null)

function PluginChatBox(props: BoxProps) {
  return props.options.modelPicker === false ? <BareChatBox {...props} /> : <PickerChatBox {...props} />
}

export function mountPluginChatBox(el: HTMLElement, initial: PluginChatBoxOptions): PluginChatBoxHandle {
  const options = { ...initial }
  const host: Host = { input: { current: null } }
  let alive = true, revision = 0
  const tree = () => <HostLocaleProvider><PluginChatBox options={options} revision={revision++} host={host} isAlive={() => alive} /></HostLocaleProvider>
  // alive 跟着这次挂载走:被后来的挂载收掉也算卸了,晚到的提交结果不再认
  const mounted = mountHostReact(el, tree(), () => { alive = false })
  return {
    update(patch) { if (alive) { Object.assign(options, patch); mounted.render(tree()) } },
    focus() { if (alive) host.input.current?.focus() },
    insertText(text) {
      if (!alive) return
      if (host.insertText) { host.insertText(String(text)); return }
      options.value = (options.value ?? '') + String(text) // first render still pending: it reads this
      requestAnimationFrame(() => { if (alive) host.input.current?.focus() })
    },
    dispose: mounted.dispose,
  }
}
