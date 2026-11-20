/** DOM plugin adapter for the same Chat Box used by first-party prompt Views. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatBox, useChatBoxSelection, type ChatBoxSelection, type ChatBoxSubmission } from '../../components/chatbox'
import { textareaCaretRect } from '../../components/chatbox/textareaCaret'
import { SuggestMenu } from '../lib/SuggestMenu'
import { HostLocaleProvider, registerMessages, translate, useI18n } from '../../i18n'
import { ChatBox as ChatBoxBase, mountHostReact, type ChatBoxProps as BaseChatBoxProps } from '@lcl/components'
import { matchChatBoxMention, matchChatBoxSuggest, type ChatBoxMention, type ChatBoxMentionKind, type ChatBoxSuggestMatch, type PluginChatBoxHandle, type PluginChatBoxOptions, type PluginChatBoxSuggest } from '../../../../shared/chatBox'
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
  /** Set once the box has rendered. */
  insertText?(text: string): void
}
interface BoxProps { options: PluginChatBoxOptions; revision: number; host: Host; isAlive(): boolean }

/** One menu row. `insert()` runs on pick and returns what replaces trigger + query ('' = just remove it). */
interface SuggestRow { key: string; label: string; hint?: string; section?: string; insert(): string }

interface SuggestMenuState {
  match: ChatBoxSuggestMatch
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
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '')

/** The host's `@` rows: dates first, then notes (same order and labels as the notes `@` panel). No「提醒我」/ `@todo` rows:
 *  those are note-line marks, a Chat Box consumer has nowhere to keep them. */
function mentionRows(query: string, kinds: ChatBoxMentionKind[], take: (m: ChatBoxMention) => boolean): SuggestRow[] {
  const rows: SuggestRow[] = []
  if (kinds.includes('date')) {
    for (const c of dateCandidates(query)) {
      if (c.insert.startsWith('@remind:') || c.insert === '@todo') continue
      const value = c.insert.slice(1)
      rows.push({ key: `date:${value}`, label: c.label, hint: c.hint, section: rows.length ? undefined : translate('chatbox.mention.date'),
        insert: () => (take({ kind: 'date', value }) ? '' : `${c.insert} `) })
    }
  }
  if (kinds.includes('page')) {
    const all = usePageStore.getState().pages
    const counts = new Map<string, number>()
    for (const p of all) counts.set(baseName(p), (counts.get(baseName(p)) ?? 0) + 1)
    const inVault = new Set(all)
    const recent = getRecentPages().filter((p) => inVault.has(p))
    const ordered = [...new Set([...recent, ...all])]
    const q = query.toLowerCase()
    const first = rows.length
    for (const path of ordered) {
      if (rows.length >= SUGGEST_LIMIT) break
      const name = baseName(path)
      if (q && !name.toLowerCase().includes(q)) continue
      const link = (counts.get(name) ?? 0) > 1 ? path.replace(/\.md$/i, '') : name
      rows.push({ key: `page:${path}`, label: name, hint: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined,
        section: rows.length === first ? translate('chatbox.mention.page') : undefined,
        insert: () => (take({ kind: 'page', path, link }) ? '' : `[[${link}]] `) })
    }
  }
  return rows.slice(0, SUGGEST_LIMIT)
}

/** The textarea side of `suggest`: when to open, what to show, where. Reads options live, so update() takes effect at once. */
function useChatBoxSuggest({ options, host, isAlive }: BoxProps, replace: (match: ChatBoxSuggestMatch, text: string) => void) {
  const [menu, setMenu] = useState<SuggestMenuState | null>(null)
  const request = useRef(0)
  const composing = useRef(false)
  const dismissedAt = useRef<number | null>(null) // Esc holds for this trigger until the word ends, as in the editor
  const close = () => { request.current++; setMenu(null) }
  /** Only called when the user changed the text: moving the caret onto an old tag must not open the menu and trap ↑↓. */
  const evaluate = (value: string) => {
    const el = host.input.current
    const collapsed = !!el && el.selectionStart === el.selectionEnd
    // Several triggers: the one nearest the caret wins (`#a [[b` → `[[`). Plugin input: skip malformed entries.
    // The host's `@` (mentions) takes the `@` trigger; a plugin's own `@` suggest steps aside while it is on.
    const kinds = mentionKinds(options)
    let picked: PluginChatBoxSuggest | 'mention' | undefined
    let match: ChatBoxSuggestMatch | null = null
    if (el && collapsed && !composing.current && !options.disabled) {
      for (const s of ([] as PluginChatBoxSuggest[]).concat(options.suggest ?? [])) {
        if (!s || typeof s.trigger !== 'string' || typeof s.items !== 'function') continue
        if (kinds.length && s.trigger === '@') continue
        const m = matchChatBoxSuggest(value, el.selectionStart, s.trigger, s.mention)
        if (m && (!match || m.from > match.from)) { match = m; picked = s }
      }
      const m = kinds.length ? matchChatBoxMention(value, el.selectionStart) : null
      if (m && (!match || m.from > match.from)) { match = m; picked = 'mention' }
    }
    if (!match || !picked) { dismissedAt.current = null; close(); return }
    if (dismissedAt.current === match.from) { close(); return }
    const suggest = picked, found0 = match, trigger = suggest === 'mention' ? '@' : suggest.trigger
    setMenu(cur => (cur ? { ...cur, match: found0, trigger } : null)) // keep the range current while new items load
    const id = ++request.current
    const take = (m: ChatBoxMention): boolean => {
      if (!isAlive() || typeof options.onMention !== 'function') return false
      try { return options.onMention(m) === true } catch (e) { console.error('[amadeus] plugin Chat Box onMention failed', e); return false }
    }
    void Promise.resolve().then(() => suggest === 'mention' ? mentionRows(found0.query, kinds, take) : Promise.resolve(suggest.items(found0.query)).then(found =>
      (Array.isArray(found) ? found : []).filter(i => typeof i?.label === 'string' && typeof i?.value === 'string').slice(0, SUGGEST_LIMIT)
        .map((i, k): SuggestRow => ({ key: `${k}:${i.value}`, label: i.label, hint: i.hint, insert: () => `${i.value} ` })),
    )).then(rows => {
      if (id !== request.current) return
      if (!rows.length || !el) { setMenu(null); return }
      const at = textareaCaretRect(el, found0.to)
      setMenu({ match: found0, trigger, rows, left: at.left, top: at.bottom, anchorTop: at.top })
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
          items={menu.rows.map(r => ({ key: r.key, label: r.label, hint: r.hint, section: r.section }))}
          left={menu.left}
          top={menu.top}
          anchorTop={menu.anchorTop}
          // Prompt boxes usually sit at the bottom of a view: in the lower half the menu opens upward, over the list.
          prefer={menu.anchorTop > window.innerHeight / 2 ? 'above' : 'below'}
          onPick={i => {
            const m = menu.match
            const typed = `${menu.trigger}${m.query}`
            close()
            // update({ value }) may have swapped the draft since the menu opened: the range no longer means anything.
            if (host.input.current?.value.slice(m.from, m.to) === typed) replace(m, menu.rows[i].insert())
          }}
          onClose={() => { dismissedAt.current = menu.match.from; close() }}
          focused={() => document.activeElement === host.input.current}
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
  const replace = (match: { from: number; to: number }, inserted: string) => {
    const value = options.value ?? text
    const next = value.slice(0, match.from) + inserted + value.slice(match.to)
    const caret = match.from + inserted.length
    const el = host.input.current
    if (next === value) { if (el) el.selectionStart = el.selectionEnd = caret; return } // no render will come to do it
    caretAfter.current = caret
    change({ ...selected(), text: next })
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
    onValueChange: value => { change({ ...selected(), text: value }); suggest.evaluate(value) },
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
      const submitted = { ...effective, text }
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
  const toolbar = options.toolbar ? <ToolbarSlot toolbar={options.toolbar} /> : null
  return picker
    ? <ChatBox {...box} selection={effective} onSelectionChange={value => change({ ...value, text })} leadingControls={toolbar} />
    : <ChatBoxBase {...box} controls={toolbar} />
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
