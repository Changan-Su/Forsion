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

/** `![` is two characters of text: with images off, `![cat](pic.png)` must not turn into `!` + a link to the picture. */
const imageLiteral = {
  name: 'chatBoxImageLiteral',
  tokenize(effects: { enter(t: string): void; exit(t: string): void; consume(c: number): void }, ok: (c: number) => unknown, nok: (c: number) => unknown) {
    const open = (code: number) => { if (code !== 91) return nok(code); effects.consume(code); effects.exit('data'); return ok }
    return (code: number) => { if (code !== 33) return nok(code); effects.enter('data'); effects.consume(code); return open }
  },
}

interface MdTree { type: string; value?: string; children?: MdTree[] }
/** `inline` is one line: a line break (`a  ⏎b`, `a\⏎b`, a soft break in a value with newlines) reads as a space. */
function oneLine(tree: MdTree): void {
  const walk = (n: MdTree): void => {
    if (!n.children) return
    n.children = n.children.map((c) => (c.type === 'break' ? { ...c, type: 'text', value: ' ' } : c))
    for (const c of n.children) { if (c.type === 'text' && c.value?.includes('\n')) c.value = c.value.replace(/[ \t]*\n[ \t]*/g, ' '); walk(c) }
  }
  walk(tree)
}

/** remark plugin: switch the profile's missing syntax off (it parses as literal text). Must come after remark-gfm:
 *  bare URLs are found by a tree transform of gfm's, not only by the micromark constructs, so that transform goes too. */
export function remarkChatBoxSyntax(this: Processor, format: ChatBoxFormat = 'inline'): ((tree: MdTree) => void) | undefined {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] }
  ;(data.micromarkExtensions ??= []).push({ disable: { null: OFF[format] ?? OFF.inline } }, { text: { 33: imageLiteral } })
  const walk = (ext: unknown): void => {
    if (Array.isArray(ext)) { ext.forEach(walk); return }
    const e = ext as { enter?: Record<string, unknown>; transforms?: unknown[] } | null
    if (e && typeof e === 'object' && e.enter && 'literalAutolink' in e.enter) e.transforms = [] // a fresh object per processor
  }
  walk(data.fromMarkdownExtensions ?? [])
  return format === 'basic' ? undefined : oneLine
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

/** Parse an inline-profile value (a todo title) into runs of text. Never throws; anything unexpected reads as text.
 *  Wiki links are found in the parsed text, as the editor shows them: `` `[[x]]` `` is code, `[[*x*]]` has an italic x. */
export function parseInlineMarkdown(md: string): ChatBoxInlineToken[] {
  const src = String(md ?? '')
  if (!src) return []
  let tree: MdNode
  try {
    const p = processor('inline')
    tree = p.runSync(p.parse(src)) as unknown as MdNode
  } catch { return [{ text: src, from: 0, to: src.length }] }
  const out: ChatBoxInlineToken[] = []
  const push = (value: string, node: MdNode, marks: Marks, wikis: boolean): void => {
    const nodeFrom = node.position?.start.offset ?? 0, to0 = node.position?.end.offset ?? nodeFrom
    // Offsets are exact where the source spells the text as is (inside a code span's backticks too); with escapes or
    // references in it, a run gets the node's range.
    const k = src.indexOf(value, nodeFrom)
    const exact = !!value && k >= nodeFrom && k + value.length <= to0
    const from = exact ? k : nodeFrom, to = exact ? k + value.length : to0
    const at = (i: number): number => (exact ? from + i : from)
    const end = (i: number): number => (exact ? from + i : to)
    let last = 0
    if (wikis) {
      for (const m of value.matchAll(WIKI_RE)) {
        const i = m.index ?? 0
        if (i > last) out.push({ text: value.slice(last, i), ...marks, from: at(last), to: end(i) })
        const inner = m[0].slice(2, -2)
        const shown = (inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner).trim() || inner
        const raw = src.indexOf(m[0], exact ? from + i : from)
        const wFrom = raw >= from && raw + m[0].length <= to ? raw : at(i), wTo = raw >= from && raw + m[0].length <= to ? raw + m[0].length : end(i + m[0].length)
        out.push({ text: shown, ...marks, wiki: inner, from: wFrom, to: wTo })
        last = i + m[0].length
      }
    }
    if (last < value.length) out.push({ text: value.slice(last), ...marks, from: at(last), to: end(value.length) })
  }
  const walk = (node: MdNode, marks: Marks): void => {
    switch (node.type) {
      case 'text': push(node.value ?? '', node, marks, true); return
      case 'inlineCode': push(node.value ?? '', node, { ...marks, code: true }, false); return
      case 'strong': for (const c of node.children ?? []) walk(c, { ...marks, strong: true }); return
      case 'emphasis': for (const c of node.children ?? []) walk(c, { ...marks, em: true }); return
      case 'delete': for (const c of node.children ?? []) walk(c, { ...marks, strike: true }); return
      case 'link': for (const c of node.children ?? []) walk(c, { ...marks, href: node.url ?? '' }); return
      default:
        if (node.children) for (const c of node.children) walk(c, marks)
        else if (typeof node.value === 'string') push(node.value, node, marks, false)
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
    if (++tries > 600) return false
    try { return same(candidate) } catch { return false }
  }
  const bare = (x: string): string => x.replace(/\\([!-/:-@[-`{-~])/g, '$1')
  // Most values need no escape at all: one parse settles it.
  if (bare(out) !== out && attempt(bare(out))) return bare(out)
  // Otherwise one at a time, repeating while a pass frees an escape an earlier one kept; then the remaining ones together
  // (`\*a\*\*b`: each of the last two is needed alone, both can go at once → `*a**b`).
  for (let pass = 0; pass < 4; pass++) {
    const before = out
    out = minimizePass(out, attempt)
    if (out === before) break
  }
  if (bare(out) !== out && attempt(bare(out))) out = bare(out)
  return out
}

function minimizePass(md: string, attempt: (candidate: string) => boolean): string {
  let out = md
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
