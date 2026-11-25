// @vitest-environment happy-dom
/** One input event that inserts several characters (an IME committing a phrase, macOS text replacement, dictation, an
 *  automation tool's insertText) and closes a `**…**` / `*…*` / `_…_` / `~~…~~` / `` `…` `` must keep its text and still
 *  format. The mark input rules assume only the last typed character is missing from the doc (run() passes
 *  `start = from - (match[0].length - text.length)`), so before ./editorPlugins' multiCharInput the whole chunk was lost.
 *  Real Milkdown with the box's own parts; input goes through handleTextInput the way ProseMirror routes beforeinput. */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor, editorViewCtx, rootCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { undoInputRule } from '@milkdown/kit/prose/inputrules'
import { chatBoxEditorPlugins } from './editorPlugins'
import { storeMarkdown } from './ChatBoxEditor'
import type { ChatBoxFormat } from './chatBoxMarkdown'

interface Booted { view: EditorView; store(): string; destroy(): Promise<void> }
let live: Booted | null = null
afterEach(async () => { await live?.destroy(); live = null })

async function boot(format: ChatBoxFormat): Promise<Booted> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  // milkdown's ctx Timer never clears its 3s timeouts (see parseFidelity.testkit): collect and clear them on destroy.
  const timers: unknown[] = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => { const id = realSetTimeout(fn, ms, ...args); timers.push(id); return id }) as typeof setTimeout
  let ed: Editor
  try {
    ed = await Editor.make().config((ctx) => { ctx.set(rootCtx, root) }).use(chatBoxEditorPlugins(format)).create()
  } finally { globalThis.setTimeout = realSetTimeout }
  const view = ed.action((ctx) => ctx.get(editorViewCtx))
  live = {
    view,
    store: () => ed.action((ctx: Ctx) => storeMarkdown(ctx, view.state.doc)),
    destroy: async () => { await ed.destroy(); for (const t of timers) clearTimeout(t as number); root.remove() },
  }
  return live
}

/** One input event carrying `text` over the selection: input rules first, default insertion if nobody took it. */
function input(view: EditorView, text: string): void {
  const { from, to } = view.state.selection
  const deflt = () => view.state.tr.insertText(text, from, to)
  if (!view.someProp('handleTextInput', (f) => f(view, from, to, text, deflt))) view.dispatch(deflt())
}
/** Key-by-key typing, one event per character. */
function keys(view: EditorView, text: string): void { for (const ch of text) input(view, ch) }
/** First paragraph's text and its marked runs, `mark:text`. */
function para(view: EditorView): { text: string; marked: string[] } {
  let p = view.state.doc.firstChild!
  while (!p.isTextblock && p.firstChild) p = p.firstChild
  const marked: string[] = []
  p.forEach((n) => { if (n.isText && n.marks.length) marked.push(`${n.marks.map((m) => m.type.name).join('+')}:${n.text}`) })
  return { text: p.textContent, marked }
}

describe.each(['inline', 'basic'] as ChatBoxFormat[])('%s: one event inserting several characters', (format) => {
  it('chunk longer than the match: prefix kept, the closing run formatted (task repro)', async () => {
    const b = await boot(format)
    input(b.view, '看下 **重点**')
    expect(para(b.view)).toEqual({ text: '看下 重点', marked: ['strong:重点'] })
    expect(b.store()).toBe('看下 **重点**')
  })

  it.each([
    ['*斜*', 'emphasis:斜', '*斜*'],
    ['_斜_', 'emphasis:斜', '*斜*'],
    ['~~删~~', 'strike_through:删', '~~删~~'],
    ['`码`', 'inlineCode:码', '`码`'],
    ['**粗**', 'strong:粗', '**粗**'],
  ])('chunk equal to the match %s', async (chunk, mark, stored) => {
    const b = await boot(format)
    input(b.view, chunk)
    expect(para(b.view).marked).toEqual([mark])
    expect(b.store()).toBe(stored)
  })

  it('match straddling the doc and the chunk: `a **重` then `点**`', async () => {
    const b = await boot(format)
    keys(b.view, 'a **重')
    input(b.view, '点**')
    expect(para(b.view)).toEqual({ text: 'a 重点', marked: ['strong:重点'] })
    expect(b.store()).toBe('a **重点**')
  })

  it('a plain chunk is inserted once, untouched', async () => {
    const b = await boot(format)
    input(b.view, '今天下午三点开会')
    input(b.view, ' 5*3 and a_b')
    expect(para(b.view)).toEqual({ text: '今天下午三点开会 5*3 and a_b', marked: [] })
  })

  it('a chunk replacing a selection', async () => {
    const b = await boot(format)
    keys(b.view, '看下 旧词 吧')
    // select 旧词 (doc positions: paragraph opens at 0, text starts at 1)
    const start = 1 + '看下 '.length
    b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, start, start + 2)))
    input(b.view, '**重点**')
    expect(para(b.view)).toEqual({ text: '看下 重点 吧', marked: ['strong:重点'] })
  })

  it('undo right after the rule gives back the literal text', async () => {
    const b = await boot(format)
    input(b.view, '看下 **重点**')
    expect(undoInputRule(b.view.state, b.view.dispatch)).toBe(true)
    expect(para(b.view)).toEqual({ text: '看下 **重点**', marked: [] })
  })

  it('key-by-key typing still formats as before', async () => {
    const b = await boot(format)
    keys(b.view, '看下 **重点**')
    expect(para(b.view)).toEqual({ text: '看下 重点', marked: ['strong:重点'] })
    keys(b.view, ' ok')
    expect(b.store()).toBe('看下 **重点** ok')
  })
})

describe('basic: block rules from a chunk', () => {
  it.each(['- ', '* '])('`%s` as one event still makes a list item', async (chunk) => {
    const b = await boot('basic')
    input(b.view, chunk)
    expect(b.view.state.doc.firstChild!.type.name).toBe('bullet_list')
    expect(para(b.view).text).toBe('')
  })
})
