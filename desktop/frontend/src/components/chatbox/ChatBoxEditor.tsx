/** Chat Box input with formatting (`format: 'inline' | 'basic'`): a trimmed Amadeus editor that reads and writes Markdown.
 *  The value is Markdown in the profile's grammar (./chatBoxMarkdown); what it emits re-parses to what the user sees.
 *
 *  Contract with the box around it:
 *  - `onChange(md)` fires only for the user's edits, synchronously inside the transaction (no debounce: type then Enter
 *    submits the text that is on screen). A `value` set from outside replaces the document and starts a fresh undo history;
 *    it never echoes back as `onChange`.
 *  - Enter: `inline` submits (with `submitOn: 'enter'`) or does nothing — it is one line; Shift+Enter does nothing. `basic`
 *    continues a list / adds a line in a code block, else submits or (modifier mode) starts a new paragraph; Shift+Enter is a
 *    line break; ⌘/Ctrl+Enter always submits. A suggest menu that is open takes Enter first (it stops the event).
 *  - The handle speaks plain text of the caret's block, so the suggest machinery that works on a textarea works here too. */
import { useEffect, useRef, type MutableRefObject } from 'react'
import { Editor, commandsCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, rootAttrsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { $prose } from '@milkdown/kit/utils'
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Fragment, Slice, type Node as PMNode, type Schema } from '@milkdown/kit/prose/model'
import { insertHardbreakCommand } from '@milkdown/kit/preset/commonmark'
import { chatBoxEditorPlugins } from './editorPlugins'
import { minimizeEscapes, type ChatBoxFormat } from './chatBoxMarkdown'
import './chatBoxEditor.css'

/** Plain-text view of the caret's text block: one character per position (inline leaves read as U+FFFC). */
export interface ChatBoxCaretText { text: string; caret: number; block: number }
export interface ChatBoxEditorHandle {
  focus(): void
  focused(): boolean
  /** The caret's block and offset; null when the selection isn't a caret, or the caret is in code (no suggestions there). */
  read(): ChatBoxCaretText | null
  /** Text of the block that started at `block`; null when no block starts there any more. */
  blockText(block: number): string | null
  /** Replace `[from, to)` of that block's text with plain `text` and put the caret after it. */
  replace(block: number, from: number, to: number, text: string): boolean
  rect(block: number, offset: number): { left: number; top: number; bottom: number } | null
  /** Insert plain text at the selection (queued while the editor is starting: it is text, never parsed as Markdown). */
  insertText(text: string): void
  /** Show this value now (the box's `update({ value })`), without waiting for React: what Enter submits is what is on screen. */
  setValue(markdown: string): void
}

export interface ChatBoxEditorProps {
  format: ChatBoxFormat
  value: string
  onChange(markdown: string): void
  onSubmit(): void
  submitOn?: 'enter' | 'modifier-enter'
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  handle: MutableRefObject<ChatBoxEditorHandle | null>
  /** After the user changed the text (the suggest menu re-reads). */
  onTextInput?(): void
  /** The caret moved without a text change. */
  onCaretMove?(): void
  /** A value from outside replaced the document: any open or pending suggestion belonged to the old one. */
  onReplace?(): void
  onCompositionStart?(): void
  onCompositionEnd?(): void
  onBlur?(): void
}

const LEAF = '￼'

/** Serialize the way the box stores it: the profile serializer, no trailing newline, then every escape the parse doesn't need dropped. */
export function storeMarkdown(ctx: Ctx, doc: PMNode): string {
  const raw = ctx.get(serializerCtx)(doc).replace(/\n+$/, '')
  const parse = ctx.get(parserCtx)
  let base: PMNode | undefined
  try { base = parse(raw) as PMNode } catch { return raw }
  return minimizeEscapes(raw, (c) => (parse(c) as PMNode).eq(base!))
}

/** `inline` holds one paragraph: a pasted slice becomes its inline content, blocks joined by a space. */
export function flattenSlice(slice: Slice, schema: Schema): Slice {
  const inlines: PMNode[] = []
  const space = (): void => { if (inlines.length) inlines.push(schema.text(' ')) }
  let first = true
  slice.content.descendants((node) => {
    if (!node.isTextblock) return true
    if (!first) space()
    first = false
    node.content.forEach((child) => { if (child.isText || child.isInline) inlines.push(child) })
    return false
  })
  if (first) slice.content.forEach((n) => { if (n.isInline) inlines.push(n) }) // a bare inline slice
  const para = schema.nodes.paragraph.create(null, inlines.length ? Fragment.fromArray(inlines) : undefined)
  return new Slice(Fragment.from(para), 1, 1)
}

export default function ChatBoxEditor(props: ChatBoxEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const live = useRef(props)
  live.current = props
  const editor = useRef<{ view: EditorView; ctx: Ctx; ed: Editor } | null>(null)
  /** What the document stands for: the last value emitted or applied. A `value` prop equal to it is no news. */
  const shown = useRef<string | null>(null) // null until the first value is in
  const applying = useRef(false)
  const queued = useRef<string[]>([])
  const focusQueued = useRef(false)
  const composition = useRef(0)
  /** Replace the document with `value` (a fresh undo history; no onChange). A value the grammar can't read shows as text. */
  const applyValue = (value: string): void => {
    const e = editor.current
    if (!e || value === shown.current) return
    const schema = e.view.state.schema
    let doc: PMNode
    try { doc = e.ctx.get(parserCtx)((value || '').replace(/\r\n?/g, '\n')) as PMNode } catch (err) {
      console.error('[chatbox] could not read value; showing it as text', err)
      const line = (value || '').replace(/\s*\n\s*/g, ' ')
      doc = schema.node('doc', null, [schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined)])
    }
    const state = EditorState.create({ doc, plugins: e.view.state.plugins, selection: TextSelection.atEnd(doc) })
    shown.current = value
    applying.current = true
    try { e.view.updateState(state) } finally { applying.current = false }
    live.current.onReplace?.() // an open suggest menu's range belonged to the old document, even where caret and query match
  }

  useEffect(() => {
    const root = host.current!
    let cancelled = false
    let made: Editor | null = null
    const { format } = live.current
    const behaviour = $prose((ctx) => new Plugin({
      view: () => ({
        update: (view, prev) => {
          if (view.state.doc.eq(prev.doc)) {
            if (!view.state.selection.eq(prev.selection)) live.current.onCaretMove?.()
            return
          }
          if (applying.current) return
          const md = storeMarkdown(ctx, view.state.doc)
          shown.current = md
          live.current.onChange(md)
          live.current.onTextInput?.()
        },
      }),
      props: {
        attributes: () => ({
          class: 't2c-ed',
          'aria-label': live.current.ariaLabel ?? '',
          'aria-multiline': format === 'basic' ? 'true' : 'false',
          ...(live.current.disabled ? { 'aria-disabled': 'true' } : {}),
        }),
        decorations: (state) => {
          const doc = state.doc, only = doc.childCount === 1 ? doc.firstChild : null
          const text = live.current.placeholder
          if (!text || !only || !only.isTextblock || only.content.size) return null
          return DecorationSet.create(doc, [Decoration.node(0, only.nodeSize, { class: 't2c-ed-empty', 'data-placeholder': text })])
        },
        transformPasted: (slice, view) => (format === 'inline' ? flattenSlice(slice, view.state.schema) : slice),
        handleKeyDown: (view, e) => {
          if (e.key !== 'Enter' || e.isComposing || view.composing) return false
          if (e.defaultPrevented) return true // an open suggest menu took it
          const p = live.current
          const submit = (): true => { if (!p.disabled) p.onSubmit(); return true }
          if (e.metaKey || e.ctrlKey) return submit()
          const $from = view.state.selection.$from
          const inCode = !!$from.parent.type.spec.code
          let inList = false
          for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'list_item') { inList = true; break }
          if (e.shiftKey) {
            if (format === 'inline') return true
            if (inCode) return false
            return ctx.get(commandsCtx).call(insertHardbreakCommand.key)
          }
          if (format === 'basic' && (inList || inCode)) return false // list item split / code line: the presets' keymaps
          if ((p.submitOn ?? 'modifier-enter') === 'enter') return submit()
          return format === 'inline' // modifier mode: inline has no second line; basic starts a paragraph
        },
        handleDOMEvents: {
          compositionstart: () => { composition.current++; live.current.onCompositionStart?.(); return false },
          compositionend: () => {
            // The last composed text lands in a transaction around this event: read after it — unless a new
            // composition has started by then (its guard must stay up).
            const n = composition.current
            setTimeout(() => { if (composition.current === n) live.current.onCompositionEnd?.() }, 0)
            return false
          },
          blur: () => { live.current.onBlur?.(); return false },
        },
      },
    }))
    void Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        // Not "milkdown": the notes' typography (`.milkdown .ProseMirror p` …) must not reach a Chat Box.
        ctx.set(rootAttrsCtx, { class: 't2c-ed-shell' })
        ctx.set(defaultValueCtx, '') // the value goes in below, where a value the grammar can't read falls back to text
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => !live.current.disabled }))
      })
      .use(behaviour) // first: its Enter / paste handling runs before the presets' keymaps
      .use(chatBoxEditorPlugins(format))
      .create()
      .then((ed) => {
        made = ed
        if (cancelled) { void ed.destroy(); return }
        ed.action((ctx) => { editor.current = { view: ctx.get(editorViewCtx), ctx, ed } })
        applyValue(live.current.value || '')
        const view = editor.current!.view
        // Text inserted while starting goes in as text, at the end of the value.
        for (const text of queued.current.splice(0)) view.dispatch(view.state.tr.insertText(text).scrollIntoView())
        if (focusQueued.current) { focusQueued.current = false; view.focus() }
      })
      .catch((e) => console.error('[chatbox] editor failed to start', e))
    return () => {
      cancelled = true
      editor.current = null
      if (made) void made.destroy()
    }
  }, [props.format]) // eslint-disable-line react-hooks/exhaustive-deps

  // A value from outside (cleared after submit, set by update({ value }), restored draft): new document, fresh history.
  useEffect(() => { applyValue(props.value) }, [props.value]) // eslint-disable-line react-hooks/exhaustive-deps

  // Placeholder / disabled / label changes: let the view re-read its props.
  useEffect(() => {
    const e = editor.current
    if (e) e.view.dispatch(e.view.state.tr.setMeta('chatBoxProps', true))
  }, [props.placeholder, props.disabled, props.ariaLabel])

  props.handle.current = {
    focus: () => { const e = editor.current; if (e) e.view.focus(); else focusQueued.current = true },
    focused: () => !!editor.current?.view.hasFocus(),
    read: () => {
      const view = editor.current?.view
      if (!view) return null
      const sel = view.state.selection
      if (!sel.empty) return null
      const $p = sel.$from
      if (!$p.parent.isTextblock || $p.parent.type.spec.code || $p.marks().some((m) => m.type.spec.code)) return null
      return { text: $p.parent.textBetween(0, $p.parent.content.size, '\n', LEAF), caret: $p.parentOffset, block: $p.start() }
    },
    blockText: (block) => {
      const view = editor.current?.view
      if (!view || block < 0 || block > view.state.doc.content.size) return null
      try {
        const $b = view.state.doc.resolve(block)
        if (!$b.parent.isTextblock || $b.start() !== block) return null
        return $b.parent.textBetween(0, $b.parent.content.size, '\n', LEAF)
      } catch { return null }
    },
    replace: (block, from, to, text) => {
      const view = editor.current?.view
      if (!view) return false
      const a = block + from, b = block + to
      if (a < block || b < a || b > view.state.doc.content.size) return false
      const tr = text ? view.state.tr.insertText(text, a, b) : view.state.tr.delete(a, b)
      tr.setSelection(TextSelection.create(tr.doc, a + text.length))
      view.dispatch(tr.scrollIntoView())
      return true
    },
    rect: (block, offset) => {
      const view = editor.current?.view
      if (!view) return null
      try { const c = view.coordsAtPos(Math.min(block + offset, view.state.doc.content.size)); return { left: c.left, top: c.top, bottom: c.bottom } } catch {
        const r = view.dom.getBoundingClientRect() // no layout for that position (hidden, detached): anchor on the box
        return { left: r.left, top: r.top, bottom: r.bottom }
      }
    },
    insertText: (text) => {
      const view = editor.current?.view
      if (!text) return
      if (!view) { queued.current.push(text); return }
      view.dispatch(view.state.tr.insertText(text).scrollIntoView())
    },
    setValue: (markdown) => applyValue(markdown),
  }

  return <div ref={host} className="t2c-ed-host" data-format={props.format} />
}
