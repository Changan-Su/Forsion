// PROBE (inline-literal-bold): bold delimiters `**` / `__` as real text characters + decorations,
// the same model obsidianInline.ts uses for `==highlight==` (text in the document, decorations for display).
// Everything here is inert unless literalBoldEnabled() (see ./literalBoldFlag).
//
//  · Read:  a remark transformer turns every mdast `strong` back into `text(open) ...children text(close)`,
//           open/close taken from the source by position, so `**` vs `__` survives verbatim.
//  · Show:  scanLiteralBold() finds `**x**` / `__x__` in the block string (code / math / escaped chars blanked);
//           selection away -> delimiters hidden, inner text bold; selection touching (both outer edges count) -> shown.
//  · Input: Mod-b wraps / unwraps the selection with `**`, empty selection inserts `****` with the caret in the middle;
//           `*` wraps a selection, and auto-pairs before whitespace / end of block (Obsidian's auto-pair).
//           The `**x**` -> strong mark input rule is disabled in anchoredMarkRules.ts.
//  · Save:  the text handler stops escaping `*` and `_` inside phrasing (text is the source); at a line start only
//           the constructs that would really change meaning (list bullet, thematic break) are still escaped.
//           User-escaped chars keep their backslash through the existing amadeusEscaped mark.
import { $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { buildBlockString, scanMath } from './mathLivePreview'
import { editorFocused } from './editorFocus'
import { literalBoldEnabled } from './literalBoldFlag'
export { withLiteralStars } from './literalBoldFlag'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

// ── read ──
/** Replace every `strong` with its delimiters as text, recursively. Exported for tests. */
export function restoreStrongAsText(tree: MdNode, src: string): void {
  const visit = (n: MdNode): void => {
    const kids = n?.children
    if (!Array.isArray(kids)) return
    let touched = false
    const out: MdNode[] = []
    for (const k of kids) {
      visit(k)
      if (k?.type !== 'strong') {
        out.push(k)
        continue
      }
      const s = k.position?.start?.offset
      const e = k.position?.end?.offset
      const fallback = (k as { marker?: string }).marker === '_' ? '__' : '**'
      let open = typeof s === 'number' ? src.slice(s, s + 2) : fallback
      let close = typeof e === 'number' ? src.slice(e - 2, e) : fallback
      if (open !== '**' && open !== '__') open = fallback
      if (close !== '**' && close !== '__') close = open
      touched = true
      out.push({ type: 'text', value: open }, ...(k.children ?? []), { type: 'text', value: close })
    }
    if (touched) n.children = out
  }
  visit(tree)
}

export const literalBoldRemark = $remark('amadeusLiteralBold', () => () => (tree: MdNode, file: { value?: unknown }) => {
  if (!literalBoldEnabled()) return
  restoreStrongAsText(tree, String(file?.value ?? ''))
})

// ── show ──
export interface BoldSpan { from: number; to: number; delim: '**' | '__' }

/** Block string for scanning: buildBlockString (code -> spaces) + escaped `*` / `_` blanked + math blanked. */
function scanString(block: PMNode): string {
  let s = buildBlockString(block)
  block.forEach((child, offset) => {
    if (!child.isText || !child.marks.some((m) => m.type.name === 'amadeusEscaped')) return
    const t = child.text ?? ''
    s = s.slice(0, offset) + t.replace(/[*_]/g, '\u0002') + s.slice(offset + t.length)
  })
  for (const m of scanMath(s)) s = s.slice(0, m.from) + ' '.repeat(m.to - m.from) + s.slice(m.to)
  return s
}

const WORD = /[\p{L}\p{N}]/u
/** `**x**` / `__x__` spans (offsets include delimiters). Inner side of a delimiter is not whitespace; `__` does not
 *  open / close inside a word (CommonMark); content may contain single `*` and soft line breaks. */
export function scanLiteralBold(s: string): BoldSpan[] {
  if (s.indexOf('**') === -1 && s.indexOf('__') === -1) return []
  const out: BoldSpan[] = []
  const RE = /(\*\*|__)(?![\s*_])([\s\S]*?[^\s\\])\1/g
  for (let m = RE.exec(s); m; m = RE.exec(s)) {
    const from = m.index
    const to = from + m[0].length
    const delim = m[1] as '**' | '__'
    if (delim === '__' && ((from > 0 && WORD.test(s[from - 1])) || (to < s.length && WORD.test(s[to])))) {
      RE.lastIndex = from + 1
      continue
    }
    // `****x` style runs: the opener must not be preceded by the same char (keeps `***` / `****` literal).
    if (from > 0 && s[from - 1] === delim[0]) {
      RE.lastIndex = from + 1
      continue
    }
    out.push({ from, to, delim })
  }
  return out
}

const key = new PluginKey('amadeus-literal-bold')

function buildDecorations(state: EditorState): DecorationSet {
  const focus = editorFocused(state)
  const { from: selFrom, to: selTo } = state.selection
  const decos: Decoration[] = []
  state.doc.descendants((node: PMNode, pos: number) => {
    if (!node.isTextblock) return true
    if (node.type.spec.code) return false
    const text = node.textContent
    if (text.indexOf('**') === -1 && text.indexOf('__') === -1) return false
    const cs = pos + 1
    for (const sp of scanLiteralBold(scanString(node))) {
      const from = cs + sp.from
      const to = cs + sp.to
      const active = focus && selFrom <= to && selTo >= from
      const cls = active ? 'amx-obs-delim' : 'amx-obs-hidden'
      decos.push(
        Decoration.inline(from, from + 2, { class: cls }),
        Decoration.inline(from + 2, to - 2, { class: 'amx-lit-bold' }),
        Decoration.inline(to - 2, to, { class: cls }),
      )
    }
    return false
  })
  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
}

// ── input ──
function spanAt(state: EditorState, from: number, to: number): { cs: number; sp: BoldSpan } | null {
  const $from = state.doc.resolve(from)
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null
  const cs = $from.start()
  const sp = scanLiteralBold(scanString($from.parent)).find((x) => cs + x.from <= from && to <= cs + x.to)
  return sp ? { cs, sp } : null
}

/** Mod-b with the switch on: Obsidian's literal toggle. */
export const toggleLiteralBold: Command = (state, dispatch) => {
  const { $from, $to, from, to, empty } = state.selection
  if (!$from.sameParent($to) || !$from.parent.isTextblock || $from.parent.type.spec.code) return false
  const hit = spanAt(state, from, to)
  if (hit) {
    const a = hit.cs + hit.sp.from
    const b = hit.cs + hit.sp.to
    const tr = state.tr.delete(b - 2, b).delete(a, a + 2)
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(from), tr.mapping.map(to)))
    dispatch?.(tr)
    return true
  }
  if (empty) {
    const tr = state.tr.insertText('****', from)
    tr.setSelection(TextSelection.create(tr.doc, from + 2))
    dispatch?.(tr)
    return true
  }
  const tr = state.tr.insertText('**', to).insertText('**', from)
  tr.setSelection(TextSelection.create(tr.doc, from + 2, to + 2))
  dispatch?.(tr)
  return true
}

/** `*` typed: wrap a selection; empty selection auto-pairs before whitespace / end, steps over a following `*`. */
function handleStar(state: EditorState, from: number, to: number, dispatch: (tr: ReturnType<EditorState['tr']['setMeta']>) => void): boolean {
  const $from = state.doc.resolve(from)
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false
  if ($from.marks().some((m) => m.type.name === 'inlineCode' || m.type.name === 'code')) return false
  if (from !== to) {
    if (!$from.sameParent(state.doc.resolve(to))) return false
    const tr = state.tr.insertText('*', to).insertText('*', from)
    tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1))
    dispatch(tr)
    return true
  }
  const off = $from.parentOffset
  const text = $from.parent.textBetween(0, $from.parent.content.size, '\n', '￼')
  const prev = text[off - 1] ?? ''
  const next = text[off] ?? ''
  if (prev === '*' && next === '*' && text[off - 2] !== '*' && text[off + 1] !== '*') {
    // `*|*` -> `**|**`
    const tr = state.tr.insertText('**', from)
    tr.setSelection(TextSelection.create(tr.doc, from + 1))
    dispatch(tr)
    return true
  }
  if (next === '*') {
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, from + 1)))
    return true
  }
  if (next === '' || /\s/.test(next)) {
    const tr = state.tr.insertText('**', from)
    tr.setSelection(TextSelection.create(tr.doc, from + 1))
    dispatch(tr)
    return true
  }
  return false
}

export function literalBoldPlugin() {
  return $prose(
    () =>
      new Plugin({
        key,
        props: {
          decorations: (state) => (literalBoldEnabled() ? buildDecorations(state) : DecorationSet.empty),
          handleKeyDown: (view, e) => {
            if (!literalBoldEnabled()) return false
            const mod = navigator.platform.includes('Mac') ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
            if (!mod || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b') return false
            return toggleLiteralBold(view.state, view.dispatch)
          },
          handleTextInput: (view, from, to, text) => {
            if (!literalBoldEnabled() || text !== '*' || view.composing) return false
            return handleStar(view.state, from, to, view.dispatch)
          },
        },
      }),
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
