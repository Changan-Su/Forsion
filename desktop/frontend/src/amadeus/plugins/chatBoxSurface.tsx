/** DOM plugin adapter for the same Chat Box used by first-party prompt Views. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatBox, useChatBoxSelection, type ChatBoxSelection, type ChatBoxSubmission } from '../../components/chatbox'
import { textareaCaretRect } from '../../components/chatbox/textareaCaret'
import ChatBoxEditor, { type ChatBoxCaretText, type ChatBoxEditorHandle } from '../../components/chatbox/ChatBoxEditor'
import { SuggestMenu } from '../lib/SuggestMenu'
import { HostLocaleProvider, registerMessages, translate, useI18n } from '../../i18n'
import { ChatBox as ChatBoxBase, mountHostReact, type ChatBoxProps as BaseChatBoxProps } from '@lcl/components'
import { matchChatBoxMention, matchChatBoxSuggest, type ChatBoxFormat, type ChatBoxMention, type ChatBoxMentionKind, type ChatBoxSuggestMatch, type PluginChatBoxHandle, type PluginChatBoxOptions, type PluginChatBoxSuggest } from '../../../../shared/chatBox'
import { dateCandidates } from '../blocks/markdown/dateQuery'
import { usePageStore } from '../store/pageStore'
import { getRecentPages } from '../lib/recents'

registerMessages({
  'chatbox.label': { zh: '输入内容', en: 'Message' },
  'chatbox.submitFailed': { zh: '提交失败，内容已保留，请重试。', en: 'Submission failed. Your draft is preserved; try again.' },
  // 同笔记 @ 面板的分组标签(WikiSuggest 'wiki.sec.date' / 'wiki.sec.page')
  'chatbox.mention.date': { zh: '日期', en: 'Date' },
  'chatbox.mention.page': { zh: '链接到页面', en: 'Link to page' },
})

const SUGGEST_LIMIT = 8

/** What the mount hands the tree, and what the tree hands back for the handle. */
interface Host {
  input: { current: HTMLTextAreaElement | null }
  editor: { current: ChatBoxEditorHandle | null }
  /** Set once the box has rendered. */
  insertText?(text: string): void
  focus?(): void
  /** `insertText` before the first render of a `format` box: text, so it can't go into the Markdown value. */
  early: string[]
}
interface BoxProps { options: PluginChatBoxOptions; revision: number; host: Host; isAlive(): boolean }

/** The one thing the suggest machinery needs from an input: plain text of the caret's block, and a way to replace part of it.
 *  The textarea is one block (`block` 0, the whole value); the `format` editor addresses its text blocks by start position. */
interface InputAdapter {
  read(): ChatBoxCaretText | null
  blockText(block: number): string | null
  replace(block: number, from: number, to: number, text: string): void
  rect(block: number, offset: number): { left: number; top: number; bottom: number } | null
  focus(): void
  focused(): boolean
}

const FORMATS: readonly ChatBoxFormat[] = ['inline', 'basic']
const formatOf = (options: PluginChatBoxOptions): ChatBoxFormat | null => (FORMATS.includes(options.format as ChatBoxFormat) ? options.format as ChatBoxFormat : null)
/** One menu row. `insert()` runs on pick and returns what replaces trigger + query ('' = just remove it). */
interface SuggestRow { key: string; label: string; hint?: string; section?: string; insert(): string }

interface SuggestMenuState {
  /** Which suggest produced `rows` ('mention' = the host's @ panel): rows from one source never act on another's range. */
  source: PluginChatBoxSuggest | 'mention'
  match: ChatBoxSuggestMatch
  /** The text block the range is in (always 0 in the textarea). */
  block: number
  trigger: string
  rows: SuggestRow[]
  left: number
  top: number
  anchorTop: number
}

const MENTION_KINDS: readonly ChatBoxMentionKind[] = ['date', 'page']
/** Plugin input: keep the known kinds once each, in the plugin's order. */
function mentionKinds(options: PluginChatBoxOptions): ChatBoxMentionKind[] {
  const out: ChatBoxMentionKind[] = []
  for (const k of Array.isArray(options.mentions) ? options.mentions : []) if (MENTION_KINDS.includes(k) && !out.includes(k)) out.push(k)
  return out
}
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '')

/** The host's `@` rows: dates first, then notes (same order and labels as the notes `@` panel). No「提醒我」/ `@todo` rows:
 *  those are note-line marks, a Chat Box consumer has nowhere to keep them. */
function mentionRows(query: string, kinds: ChatBoxMentionKind[], take: (m: ChatBoxMention) => boolean): SuggestRow[] {
  const rows: SuggestRow[] = []
  if (kinds.includes('date')) {
    for (const c of dateCandidates(query)) {
      if (c.insert.startsWith('@remind:') || c.insert === '@todo') continue
      const value = c.insert.slice(1)
      if (!DATE_VALUE.test(value)) continue // the contract is YYYY-MM-DD[THH:mm]; never hand a plugin anything else
      rows.push({ key: `date:${value}`, label: c.label, hint: c.hint, section: rows.length ? undefined : translate('chatbox.mention.date'),
        insert: () => (take({ kind: 'date', value }) ? '' : `${c.insert} `) })
    }
  }
  if (kinds.includes('page')) {
    const all = usePageStore.getState().pages
    const counts = new Map<string, number>()
    // Links resolve case-insensitively, so `Plan` and `plan` are the same name: count them together.
    for (const p of all) { const k = baseName(p).toLowerCase(); counts.set(k, (counts.get(k) ?? 0) + 1) }
    const inVault = new Set(all)
    const recent = getRecentPages().filter((p) => inVault.has(p))
    const ordered = [...new Set([...recent, ...all])]
    const q = query.toLowerCase()
    const first = rows.length
    for (const path of ordered) {
      if (rows.length >= SUGGEST_LIMIT) break
      const name = baseName(path)
      if (q && !name.toLowerCase().includes(q)) continue
      const link = (counts.get(name.toLowerCase()) ?? 0) > 1 ? path.replace(/\.md$/i, '') : name
      rows.push({ key: `page:${path}`, label: name, hint: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined,
        section: rows.length === first ? translate('chatbox.mention.page') : undefined,
        insert: () => (take({ kind: 'page', path, link }) ? '' : `[[${link}]] `) })
    }
  }
  return rows.slice(0, SUGGEST_LIMIT)
}

/** `suggest` / `@` over either input: when to open, what to show, where. Reads options live, so update() takes effect at once. */
function useChatBoxSuggest({ options, isAlive }: BoxProps, input: InputAdapter) {
  const [menu, setMenu] = useState<SuggestMenuState | null>(null)
  const request = useRef(0)
  /** Where the request in flight was made: a caret that leaves it drops the request (its rows would open a menu elsewhere). */
  const pendingAt = useRef<{ block: number; to: number } | null>(null)
  const composing = useRef(false)
  const dismissedAt = useRef<number | null>(null) // Esc holds for this trigger until the word ends, as in the editor
  const close = () => { request.current++; setMenu(null) }
  /** Only called when the user changed the text: moving the caret onto an old tag must not open the menu and trap ↑↓. */
  const evaluate = () => {
    const at = input.read() // null unless a collapsed caret (and, in the editor, not inside code)
    // Several triggers: the one nearest the caret wins (`#a [[b` → `[[`). Plugin input: skip malformed entries.
    // The host's `@` (mentions) takes the `@` trigger; a plugin's own `@` suggest steps aside while it is on.
    const kinds = mentionKinds(options)
    let picked: PluginChatBoxSuggest | 'mention' | undefined
    let match: ChatBoxSuggestMatch | null = null
    if (at && !composing.current && !options.disabled) {
      for (const s of ([] as PluginChatBoxSuggest[]).concat(options.suggest ?? [])) {
        if (!s || typeof s.trigger !== 'string' || typeof s.items !== 'function') continue
        if (kinds.length && s.trigger === '@') continue
        const m = matchChatBoxSuggest(at.text, at.caret, s.trigger, s.mention)
        if (m && (!match || m.from > match.from)) { match = m; picked = s }
      }
      const m = kinds.length ? matchChatBoxMention(at.text, at.caret) : null
      if (m && (!match || m.from > match.from)) { match = m; picked = 'mention' }
    }
    if (!at || !match || !picked) { dismissedAt.current = null; close(); return }
    if (dismissedAt.current === match.from) { close(); return }
    const suggest = picked, found0 = match, block = at.block, trigger = suggest === 'mention' ? '@' : suggest.trigger
    // Keep the range current while new items load, but only over rows from the same source (`@` rows must not eat a `#a`).
    setMenu(cur => (cur && cur.source === suggest && cur.block === block ? { ...cur, match: found0, trigger } : null))
    const id = ++request.current
    pendingAt.current = { block, to: found0.to }
    const take = (m: ChatBoxMention): boolean => {
      if (!isAlive() || typeof options.onMention !== 'function') return false
      try { return options.onMention(m) === true } catch (e) { console.error('[amadeus] plugin Chat Box onMention failed', e); return false }
    }
    void Promise.resolve().then(() => suggest === 'mention' ? mentionRows(found0.query, kinds, take) : Promise.resolve(suggest.items(found0.query)).then(found =>
      (Array.isArray(found) ? found : []).filter(i => typeof i?.label === 'string' && typeof i?.value === 'string').slice(0, SUGGEST_LIMIT)
        .map((i, k): SuggestRow => ({ key: `${k}:${i.value}`, label: i.label, hint: i.hint, insert: () => `${i.value} ` })),
    )).then(rows => {
      if (id !== request.current) return
      pendingAt.current = null
      const rect = rows.length ? input.rect(block, found0.to) : null
      if (!rect) { setMenu(null); return }
      setMenu({ source: suggest, match: found0, block, trigger, rows, left: rect.left, top: rect.bottom, anchorTop: rect.top })
    }).catch(e => {
      console.error('[amadeus] plugin Chat Box suggest failed', e)
      if (id === request.current) setMenu(null)
    })
  }
  const caretMoved = () => {
    const at = input.read()
    const away = (p: { block: number; to: number }) => !at || at.block !== p.block || at.caret !== p.to
    if (menu ? away({ block: menu.block, to: menu.match.to }) : pendingAt.current && away(pendingAt.current)) close()
  }
  const compositionStart = () => { composing.current = true; close() }
  // Chromium fires the last input before compositionend, so a finished `#产` has to be looked at here.
  const compositionEnd = () => { composing.current = false; evaluate() }
  return {
    evaluate,
    inputProps: {
      onCompositionStart: compositionStart,
      onCompositionEnd: compositionEnd,
      onBlur: close,
      onSelect: caretMoved,
    },
    editorProps: { onTextInput: evaluate, onCaretMove: caretMoved, onReplace: () => { pendingAt.current = null; close() }, onCompositionStart: compositionStart, onCompositionEnd: compositionEnd, onBlur: close },
    menu: menu && createPortal(
      // Outside the card: its container-type would capture position:fixed. The classes carry the menu's scoped styles.
      <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
        <SuggestMenu
          className="chat-box-suggest"
          resetKey={menu.match.query}
          items={menu.rows.map(r => ({ key: r.key, label: r.label, hint: r.hint, section: r.section }))}
          left={menu.left}
          top={menu.top}
          anchorTop={menu.anchorTop}
          // Prompt boxes usually sit at the bottom of a view: in the lower half the menu opens upward, over the list.
          prefer={menu.anchorTop > window.innerHeight / 2 ? 'above' : 'below'}
          onPick={i => {
            const m = menu.match, row = menu.rows[i]
            const typed = `${menu.trigger}${m.query}`
            close()
            // update({ value }) may have swapped the draft since the menu opened: the range no longer means anything.
            // The caret must still sit at the end of the typed query too (in that block), or the pick lands where no one is typing.
            const at = input.read()
            if (!row || !at || at.block !== menu.block || at.caret !== m.to || input.blockText(menu.block)?.slice(m.from, m.to) !== typed) return
            if (menu.source === 'mention' && !mentionKinds(options).length) return // update({ mentions: [] }) while open
            const before = options.value
            const text = row.insert() // may run the plugin's onMention, which can update({ value }) or dispose the box
            if (isAlive() && options.value === before) input.replace(menu.block, m.from, m.to, text)
          }}
          onClose={() => { dismissedAt.current = menu.match.from; close() }}
          focused={input.focused}
        />
      </div>,
      document.body,
    ),
  }
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

function PluginChatBox(props: BoxProps) {
  const { options, revision, host, isAlive } = props
  const { t } = useI18n()
  const [text, setText] = useState(options.value || '')
  // Always called: both forms share this state, so update({ modelPicker }) can't drop a draft or a pending submit lock.
  const [selection, setSelection] = useChatBoxSelection(options.agentSlug)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const sending = useRef(false)
  const caretAfter = useRef<number | null>(null)
  const picker = options.modelPicker !== false
  /** Read fresh: update() writes options before the next render, and a call in the same tick must see it. */
  const selected = (): ChatBoxSelection => ({
    modelId: options.modelId ?? (picker ? selection.modelId : ''),
    thinkingLevel: options.thinkingLevel ?? (picker ? selection.thinkingLevel : 'medium'),
  })
  const effective = selected()
  useEffect(() => { if (options.value !== undefined) setText(options.value) }, [options.value, revision])
  // A controlled value change sends the caret to the end; put it back where the edit ended.
  useLayoutEffect(() => {
    const el = host.input.current
    if (caretAfter.current === null || !el) return
    el.selectionStart = el.selectionEnd = caretAfter.current
    caretAfter.current = null
  })
  const change = (draft: ChatBoxSubmission) => {
    setText(draft.text); setError(false)
    // The mount retains the draft across update() calls that only change presentation.
    options.value = draft.text
    // Without a picker the draft's model is a placeholder, not a choice: remembering it would blank the pill if it returns.
    if (picker) { setSelection(draft); options.modelId = draft.modelId; options.thinkingLevel = draft.thinkingLevel }
    options.onChange?.(draft)
  }
  const format = formatOf(options)
  /** The textarea: replace a range of the whole value (the caret lands after it on the next render). */
  const replace = (match: { from: number; to: number }, inserted: string) => {
    const value = options.value ?? text
    const next = value.slice(0, match.from) + inserted + value.slice(match.to)
    const caret = match.from + inserted.length
    const el = host.input.current
    if (next === value) { if (el) el.selectionStart = el.selectionEnd = caret; return } // no render will come to do it
    caretAfter.current = caret
    change({ ...selected(), text: next })
  }
  const input: InputAdapter = format ? {
    read: () => host.editor.current?.read() ?? null,
    blockText: block => host.editor.current?.blockText(block) ?? null,
    replace: (block, from, to, inserted) => { host.editor.current?.replace(block, from, to, inserted) }, // emits through onChange
    rect: (block, offset) => host.editor.current?.rect(block, offset) ?? null,
    focus: () => host.editor.current?.focus(),
    focused: () => !!host.editor.current?.focused(),
  } : {
    read: () => {
      const el = host.input.current
      return el && el.selectionStart === el.selectionEnd ? { text: el.value, caret: el.selectionStart, block: 0 } : null
    },
    blockText: block => (block === 0 ? host.input.current?.value ?? null : null),
    replace: (_block, from, to, inserted) => replace({ from, to }, inserted),
    rect: (_block, offset) => { const el = host.input.current; return el ? textareaCaretRect(el, offset) : null },
    focus: () => host.input.current?.focus(),
    focused: () => !!host.input.current && document.activeElement === host.input.current,
  }
  const suggest = useChatBoxSuggest(props, input)
  // insertText calls made before this first render: text, through the editor (the textarea path put them in the value).
  useLayoutEffect(() => { if (format) for (const t of host.early.splice(0)) host.insertText?.(t) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  host.focus = input.focus
  host.insertText = inserted => {
    if (format) {
      // The editor queues it while starting (as text, at the end), and focuses when up.
      host.editor.current?.insertText(inserted)
      host.editor.current?.focus()
      return
    }
    const el = host.input.current
    const start = caretAfter.current ?? el?.selectionStart ?? text.length
    const end = caretAfter.current ?? el?.selectionEnd ?? text.length
    replace({ from: start, to: end }, inserted)
    el?.focus()
  }
  const box: Omit<BaseChatBoxProps, 'controls'> = {
    value: text,
    onValueChange: value => { change({ ...selected(), text: value }); suggest.evaluate() },
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
      // options.value, not the render's `text`: the editor emits inside the keystroke, before React has re-rendered.
      const now = options.value ?? text
      if (sending.current || !now.trim() || !isAlive()) return
      sending.current = true; setBusy(true); setError(false)
      const submitted = { ...effective, text: now }
      void Promise.resolve().then(() => options.onSubmit(submitted)).then(accepted => {
        if (isAlive() && accepted && options.value === submitted.text) change({
          modelId: options.modelId ?? effective.modelId,
          thinkingLevel: options.thinkingLevel ?? effective.thinkingLevel,
          text: '',
        })
      }).catch(() => { if (isAlive()) setError(true) }).finally(() => {
        sending.current = false
        if (isAlive()) setBusy(false)
      })
    },
  }
  if (format) box.input = <ChatBoxEditor
    key={format} format={format} value={text} handle={host.editor}
    onChange={md => change({ ...selected(), text: md })}
    onSubmit={() => box.onSubmit()}
    submitOn={options.submitOn} placeholder={options.placeholder} ariaLabel={options.label || t('chatbox.label')}
    disabled={options.disabled || busy}
    {...suggest.editorProps}
  />
  const toolbar = options.toolbar ? <ToolbarSlot toolbar={options.toolbar} /> : null
  return picker
    ? <ChatBox {...box} selection={effective} onSelectionChange={value => change({ ...value, text })} leadingControls={toolbar} />
    : <ChatBoxBase {...box} controls={toolbar} />
}

export function mountPluginChatBox(el: HTMLElement, initial: PluginChatBoxOptions): PluginChatBoxHandle {
  const options = { ...initial }
  const host: Host = { input: { current: null }, editor: { current: null }, early: [] }
  let alive = true, revision = 0
  const tree = () => <HostLocaleProvider><PluginChatBox options={options} revision={revision++} host={host} isAlive={() => alive} /></HostLocaleProvider>
  // alive 跟着这次挂载走:被后来的挂载收掉也算卸了,晚到的提交结果不再认
  const mounted = mountHostReact(el, tree(), () => { alive = false })
  return {
    update(patch) {
      if (!alive) return
      Object.assign(options, patch)
      // A `format` box shows a new value at once (React renders later): Enter in between must submit what is on screen.
      if (typeof patch.value === 'string' && formatOf(options)) host.editor.current?.setValue(patch.value)
      mounted.render(tree())
    },
    focus() { if (alive) (host.focus ?? (() => host.input.current?.focus()))() },
    insertText(text) {
      if (!alive) return
      if (host.insertText) { host.insertText(String(text)); return }
      if (formatOf(options)) { host.early.push(String(text)); return } // Markdown value: text must not be read as markup
      options.value = (options.value ?? '') + String(text) // first render still pending: it reads this
      requestAnimationFrame(() => { if (alive) (host.focus ?? (() => host.input.current?.focus()))() })
    },
    dispose: mounted.dispose,
  }
}
