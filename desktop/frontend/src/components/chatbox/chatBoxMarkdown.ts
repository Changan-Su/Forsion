/** Chat Box format profiles (`mountChatBox({ format })`): one Markdown grammar for the input editor and for every
 *  place that shows what it wrote (a todo title in the list, the calendar, the table view).
 *
 *  - The grammar is CommonMark + `~~` strikethrough with the profile's missing constructs switched off in micromark,
 *    so `# x`, `1. x`, `> x`, `<b>`, tables, footnotes and bare URLs are plain text, never "a heading the box can't show".
 *  - `minimizeEscapes` drops every backslash the serializer added that the parse doesn't need: `snake_case`, a URL with
 *    `_` / `&`, `5*3` are stored as typed. Only text that would otherwise become markup keeps its `\`.
 *    (Same principle as the notes' autolinkSerializer: if the plain spelling re-parses to the same tree, write it plain.)
 *  - Wiki links `[[…]]` stay text in the grammar; readers turn them into links (as the todo list always has). */
import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'

import type { ChatBoxFormat, ChatBoxInlineToken } from '../../../../shared/chatBox'
export type { ChatBoxFormat, ChatBoxInlineToken }
export const CHAT_BOX_FORMATS: readonly ChatBoxFormat[] = ['inline', 'basic']

/** micromark construct names neither profile has (no heading / rule / html / table / footnote / image / bare-URL link). */
const OFF_BOTH = [
  'headingAtx', 'setextUnderline', 'thematicBreak', 'htmlFlow', 'htmlText', 'definition', 'codeIndented',
  'labelStartImage', 'table', 'gfmFootnoteDefinition', 'gfmFootnoteCall', 'gfmPotentialFootnoteCall',
  'wwwAutolink', 'protocolAutolink', 'emailAutolink', // `<https://…>` stays a link: the serializer writes url-text links that way
]
/** `inline` is one line of text: no lists, quotes or code blocks either. */
const OFF: Record<ChatBoxFormat, string[]> = {
  inline: [...OFF_BOTH, 'blockQuote', 'list', 'codeFenced', 'tasklistCheck'],
  basic: OFF_BOTH,
}

/** remark plugin: switch the profile's missing syntax off (it parses as literal text). Must come after remark-gfm:
 *  bare URLs are found by a tree transform of gfm's, not only by the micromark constructs, so that transform goes too. */
export function remarkChatBoxSyntax(this: Processor, format: ChatBoxFormat = 'inline'): void {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] }
  ;(data.micromarkExtensions ??= []).push({ disable: { null: OFF[format] ?? OFF.inline } })
  const walk = (ext: unknown): void => {
    if (Array.isArray(ext)) { ext.forEach(walk); return }
    const e = ext as { enter?: Record<string, unknown>; transforms?: unknown[] } | null
    if (e && typeof e === 'object' && e.enter && 'literalAutolink' in e.enter) e.transforms = [] // a fresh object per processor
  }
  walk(data.fromMarkdownExtensions ?? [])
}

const processors = new Map<ChatBoxFormat, Processor>()
function processor(format: ChatBoxFormat): Processor {
  let p = processors.get(format)
  if (!p) {
    // Same grammar as the box's editor (./editorPlugins, the notes' cjkFriendlyRemark): gfm with `~~` only, then the
    // CJK-friendly attention / strikethrough (must follow gfm), then the profile's switched-off syntax.
    p = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })
      .use(remarkCjkFriendly).use(remarkCjkFriendlyStrikethrough, { singleTilde: false })
      .use(remarkChatBoxSyntax, format) as unknown as Processor
    processors.set(format, p)
  }
  return p
}

interface MdNode { type: string; value?: string; url?: string; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }
type Marks = Pick<ChatBoxInlineToken, 'strong' | 'em' | 'strike' | 'code' | 'href'>

const WIKI_RE = /\[\[[^\]\n]+\]\]/g
const WIKI_OPEN = '', WIKI_CLOSE = '', WIKI_FILL = ''
/** Same-length mask: offsets stay valid, and nothing inside a wiki link is read as markup (`[[a_b_c]]`, `[[*x*]]`). */
function maskWiki(md: string): { masked: string; links: string[] } {
  const links: string[] = []
  const masked = md.replace(WIKI_RE, (m) => { links.push(m); return WIKI_OPEN + WIKI_FILL.repeat(m.length - 2) + WIKI_CLOSE })
  return { masked, links }
}

/** Parse an inline-profile value (a todo title) into runs of text. Never throws; anything unexpected reads as text. */
export function parseInlineMarkdown(md: string): ChatBoxInlineToken[] {
  const src = String(md ?? '')
  if (!src) return []
  const { masked, links } = maskWiki(src)
  let tree: MdNode
  try { tree = processor('inline').parse(masked) as MdNode } catch { return [{ text: src, from: 0, to: src.length }] }
  const out: ChatBoxInlineToken[] = []
  let wikiIndex = 0
  const push = (value: string, node: MdNode, marks: Marks): void => {
    const from = node.position?.start.offset ?? 0, to = node.position?.end.offset ?? from
    // Split masked wiki links back out of the text, in order of appearance.
    let rest = value, at = from
    while (rest) {
      const open = rest.indexOf(WIKI_OPEN)
      if (open < 0) { out.push({ text: rest, ...marks, from: at, to }); break }
      if (open > 0) out.push({ text: rest.slice(0, open), ...marks, from: at, to: at + open })
      const close = rest.indexOf(WIKI_CLOSE, open)
      const end = close < 0 ? rest.length : close + 1
      const raw = links[wikiIndex++] ?? ''
      const inner = raw.slice(2, -2)
      const shown = (inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner).trim() || inner
      out.push({ text: shown, ...marks, wiki: inner, from: at + open, to: at + end })
      rest = rest.slice(end); at += end
    }
  }
  const walk = (node: MdNode, marks: Marks): void => {
    switch (node.type) {
      case 'text': push(node.value ?? '', node, marks); return
      case 'inlineCode': push(node.value ?? '', node, { ...marks, code: true }); return
      case 'break': out.push({ text: ' ', ...marks, from: node.position?.start.offset ?? 0, to: node.position?.end.offset ?? 0 }); return
      case 'strong': for (const c of node.children ?? []) walk(c, { ...marks, strong: true }); return
      case 'emphasis': for (const c of node.children ?? []) walk(c, { ...marks, em: true }); return
      case 'delete': for (const c of node.children ?? []) walk(c, { ...marks, strike: true }); return
      case 'link': for (const c of node.children ?? []) walk(c, { ...marks, href: node.url ?? '' }); return
      default:
        if (node.children) for (const c of node.children) walk(c, marks)
        else if (typeof node.value === 'string') push(node.value, node, marks)
    }
  }
  const blocks = tree.children ?? []
  blocks.forEach((b, i) => {
    if (i > 0) out.push({ text: ' ', from: b.position?.start.offset ?? 0, to: b.position?.start.offset ?? 0 })
    walk(b, {})
  })
  return out.filter((t) => t.text)
}

/** What an inline value reads as without formatting: for aria labels, tooltips, notifications, sorting, ICS, clipboard. */
export function inlineMarkdownToPlain(md: string): string {
  return parseInlineMarkdown(md).map((t) => t.text).join('')
}

const ESCAPABLE = /[!-/:-@[-`{-~]/
const CHAR_REF = /^&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/i
/** Drop each `\` before ASCII punctuation, and spell out each `&#x…;` reference, when `same(candidate)` stays true
 *  (the candidate parses to the same document). Left to right, greedy; every accepted step re-parses equal, so the
 *  result always does too. Long values skip it (each test is a parse): correct, just more backslashes. */
export function minimizeEscapes(md: string, same: (candidate: string) => boolean, limit = 4000): string {
  if (md.length > limit || !/[\\&]/.test(md)) return md
  let out = md, tries = 0
  const attempt = (candidate: string): boolean => {
    if (++tries > 200) return false
    try { return same(candidate) } catch { return false }
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '\\' && ESCAPABLE.test(out[i + 1] ?? '')) {
      const candidate = out.slice(0, i) + out.slice(i + 1)
      if (attempt(candidate)) out = candidate // the punctuation now sits at i; the loop's i++ steps past it
      else i++ // keep `\X`: skip X too
    } else if (out[i] === '&') {
      // The notes' attention serializer spells a CJK neighbour of `**` as `&#x540E;` for plain CommonMark readers; every
      // reader of a Chat Box value parses CJK-friendly, so the character itself usually reads the same.
      const m = CHAR_REF.exec(out.slice(i, i + 12))
      if (!m) continue
      const code = parseInt(m[1] ?? m[2], m[1] ? 16 : 10)
      if (!(code > 0x20 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) continue
      const ch = String.fromCodePoint(code)
      const candidate = out.slice(0, i) + ch + out.slice(i + m[0].length)
      if (attempt(candidate)) { out = candidate; i += ch.length - 1 }
      else i += m[0].length - 1
    }
  }
  return out
}
