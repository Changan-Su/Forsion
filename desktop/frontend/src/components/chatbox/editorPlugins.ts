/** The Chat Box editor's Milkdown parts, per format profile (see ./chatBoxMarkdown for the grammar).
 *
 *  Picked from the commonmark / gfm presets instead of trimming them: a node that is not in the schema can never be
 *  produced (a pasted `<h1>` becomes paragraph text), so "what the box can hold" and "what it writes" are the same list.
 *  The notes' anchored mark input rules, `~~`-only strikethrough, CJK-friendly parse and attention serializer come along,
 *  so `**注意：**后面` and `今天好累~ 明天继续~` behave as they do in a note.
 *  Not here, on purpose: autolinkSerializer (bare URLs are text in this grammar, so a bare spelling would not round-trip;
 *  a url-text link is written `<url>`), the notes' paragraph / list extensions (indent, block colour, verbatim). */
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { $node, $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey, Selection, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  blockquoteAttr, blockquoteKeymap, blockquoteSchema, bulletListAttr, bulletListKeymap, bulletListSchema, codeBlockAttr,
  codeBlockKeymap, codeBlockSchema, createCodeBlockCommand, createCodeBlockInputRule, docSchema, emphasisAttr,
  emphasisKeymap, emphasisSchema, hardbreakAttr, hardbreakFilterNodes, hardbreakFilterPlugin, hardbreakSchema,
  inlineCodeAttr, inlineCodeKeymap, inlineCodeSchema, insertHardbreakCommand, liftFirstListItemCommand,
  liftListItemCommand, linkAttr, linkSchema, listItemAttr, listItemKeymap, listItemSchema, orderedListAttr,
  orderedListKeymap, orderedListSchema, paragraphAttr, paragraphSchema, remarkAddOrderInListPlugin, remarkMarker,
  sinkListItemCommand, splitListItemCommand, strongAttr, strongKeymap, strongSchema, syncListOrderPlugin, textSchema,
  toggleEmphasisCommand, toggleInlineCodeCommand, toggleStrongCommand, wrapInBlockquoteCommand,
  wrapInBlockquoteInputRule, wrapInBulletListCommand, wrapInBulletListInputRule, wrapInOrderedListCommand,
  wrapInOrderedListInputRule,
} from '@milkdown/kit/preset/commonmark'
import {
  extendListItemSchemaForTask, remarkGFMPlugin, strikethroughAttr, strikethroughKeymap, strikethroughSchema,
  toggleStrikethroughCommand, wrapInTaskListInputRule,
} from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { anchoredMarkInputRules, gfmDoubleTildeOnly } from '../../amadeus/blocks/markdown/anchoredMarkRules'
import { cjkFriendlyRemark } from '../../amadeus/blocks/markdown/cjkFriendly'
import { attentionSerializer } from '../../amadeus/blocks/markdown/attentionFlanking'
import { remarkChatBoxSyntax, type ChatBoxFormat } from './chatBoxMarkdown'

interface MdRoot { type: string; children?: Array<{ type: string; children?: unknown[] }> }
/** Several paragraphs (a value set with blank lines) read as one: joined by a space, nothing dropped. */
function oneParagraph(root: MdRoot): MdRoot {
  const blocks = root.children ?? []
  if (blocks.length <= 1) return root
  const children: unknown[] = []
  blocks.forEach((b, i) => { if (i) children.push({ type: 'text', value: ' ' }); children.push(...(b.children ?? [])) })
  return { ...root, children: [{ type: 'paragraph', children }] }
}
/** `inline` is one paragraph: the doc can't hold a second one (Enter submits, paste joins lines). */
const inlineDocSchema = $node('doc', () => ({
  content: 'paragraph',
  parseMarkdown: {
    match: ({ type }) => type === 'root',
    runner: (state, node, type) => { state.injectRoot(oneParagraph(node as MdRoot) as typeof node, type) },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'doc',
    runner: (state, node) => { state.openNode('root'); state.next(node.content) },
  },
}))

type SyntaxPlugin = Parameters<typeof $remark<'chatBoxSyntaxInline', ChatBoxFormat>>[1] extends (ctx: never) => infer R ? R : never
const syntaxRemark = {
  inline: $remark('chatBoxSyntaxInline', () => remarkChatBoxSyntax as unknown as SyntaxPlugin, 'inline' as ChatBoxFormat),
  basic: $remark('chatBoxSyntaxBasic', () => remarkChatBoxSyntax as unknown as SyntaxPlugin, 'basic' as ChatBoxFormat),
}

const r = anchoredMarkInputRules

/** Links draw an `href` only for http(s) / mailto: a stored `[x](javascript:…)` stays in the Markdown as typed, but the
 *  editor's anchor carries no live target (the same allowlist as the readers that render these values). */
const SAFE_HREF = /^(https?:|mailto:)/i
const safeLinkSchema = linkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return { ...base, toDOM: (mark) => ['a', { ...ctx.get(linkAttr.key)(mark), ...mark.attrs, href: SAFE_HREF.test(String(mark.attrs.href ?? '').trim()) ? mark.attrs.href : null }] }
})

/** One input event that inserts several characters (an IME committing a phrase, macOS text replacement, dictation, a tool's
 *  insertText) is put in the doc first, then the input rules run over it with an empty string, the way they already do
 *  after compositionend. The mark rules assume only the last typed character is missing from the doc (the runner passes
 *  `start = from - (match[0].length - text.length)`), so a chunk that itself closes `**…**` / `*…*` / `~~…~~` / `` `…` ``
 *  was dropped whole (or threw a RangeError) instead of being formatted. Only chunks carrying a mark delimiter are taken;
 *  everything else goes the default way. A `$prose` plugin sits before the input rules plugin, so it is asked first.
 *  ⚠️ One dispatch: the rules run against the inserted state through a view that captures their transaction, and both
 *  go out as one (two dispatches let an onChange write-back see the half-done draft and reset history, review 11-25).
 *  The replay runs only when the caret sits right after the inserted text (a range replaced elsewhere must not format
 *  text at the caret) and inside the runner's 500-character window (one character later than key-by-key typing would
 *  read a different window). The notes editor uses the same rules and runner (amadeus/blocks/markdown/anchoredMarkRules)
 *  and is not covered here. */
const MARK_DELIMITER = /[*_~`]/
const RULE_WINDOW = 500
function withRulesReplayed(view: EditorView, tr: Transaction): Transaction {
  const after = view.state.apply(tr)
  const { empty, $head } = after.selection
  if (!empty || $head.parentOffset > RULE_WINDOW) return tr
  let ruled: Transaction | null = null
  const probe = Object.create(view, {
    state: { value: after },
    dispatch: { value: (t: Transaction) => { ruled = t } },
  }) as EditorView
  probe.someProp('handleTextInput', (f) => f(probe, $head.pos, $head.pos, '', () => after.tr))
  const r = ruled as Transaction | null
  if (!r || !r.docChanged) return tr
  for (const step of r.steps) tr.step(step)
  if (r.selectionSet) tr.setSelection(Selection.fromJSON(tr.doc, r.selection.toJSON()))
  if (r.storedMarksSet) tr.setStoredMarks(r.storedMarks)
  // the input rules plugin's undo record (Backspace right after gives back the literal text) rides on meta
  const meta = (r as unknown as { meta: Record<string, unknown> }).meta
  for (const k of Object.keys(meta)) tr.setMeta(k, meta[k])
  return tr
}
const multiCharInput = $prose(() => new Plugin({
  key: new PluginKey('chatBoxMultiCharInput'),
  props: {
    handleTextInput(view, from, to, text, deflt) {
      if (view.composing || text.length < 2 || !MARK_DELIMITER.test(text)) return false
      const tr = deflt ? deflt() : view.state.tr.insertText(text, from, to)
      const end = tr.mapping.map(to)
      view.dispatch((tr.selection.empty && tr.selection.head === end ? withRulesReplayed(view, tr) : tr).scrollIntoView())
      return true
    },
  },
}))

function inlineParts(format: ChatBoxFormat): MilkdownPlugin[] {
  return [
    // Schema. ⚠️ paragraph before any other block: the first block type is the default one (a trimmed preset that
    // put heading first made every new block an H1 in the notes editor).
    format === 'inline' ? inlineDocSchema : docSchema,
    paragraphAttr, paragraphSchema,
    emphasisAttr, emphasisSchema, strongAttr, strongSchema, inlineCodeAttr, inlineCodeSchema, linkAttr, safeLinkSchema,
    strikethroughAttr, strikethroughSchema,
    textSchema,
    // Grammar: gfm with `~~` only, CJK-friendly attention after it, the profile's switched-off syntax.
    gfmDoubleTildeOnly.options, remarkGFMPlugin.plugin, gfmDoubleTildeOnly.afterPlugin,
    cjkFriendlyRemark,
    syntaxRemark[format],
    remarkMarker,
    attentionSerializer,
    // Typing: `**x**` / `*x*` / `_x_` / `` `x` `` / `~~x~~` turn into marks, ⌘B ⌘I ⌘E and the strikethrough key.
    r.emphasisStar, r.emphasisUnderscore, r.inlineCode, r.strong, r.strikethrough, multiCharInput,
    toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand, toggleStrikethroughCommand,
    strongKeymap, emphasisKeymap, inlineCodeKeymap, strikethroughKeymap,
  ].flat()
}

function blockParts(): MilkdownPlugin[] {
  return [
    hardbreakAttr, hardbreakSchema, hardbreakFilterNodes, hardbreakFilterPlugin, insertHardbreakCommand,
    blockquoteAttr, blockquoteSchema, codeBlockAttr, codeBlockSchema,
    bulletListAttr, bulletListSchema, orderedListAttr, orderedListSchema, listItemAttr, listItemSchema,
    extendListItemSchemaForTask,
    remarkAddOrderInListPlugin, syncListOrderPlugin,
    wrapInBlockquoteInputRule, wrapInBulletListInputRule, wrapInOrderedListInputRule, createCodeBlockInputRule,
    wrapInTaskListInputRule,
    wrapInBlockquoteCommand, createCodeBlockCommand, wrapInBulletListCommand, wrapInOrderedListCommand,
    sinkListItemCommand, splitListItemCommand, liftListItemCommand, liftFirstListItemCommand,
    listItemKeymap, bulletListKeymap, orderedListKeymap, blockquoteKeymap, codeBlockKeymap,
  ].flat()
}

/** Everything a Chat Box editor of this profile `.use()`s, history and clipboard included. */
export function chatBoxEditorPlugins(format: ChatBoxFormat): MilkdownPlugin[] {
  return [...inlineParts(format), ...(format === 'basic' ? blockParts() : []), history, clipboard].flat()
}
