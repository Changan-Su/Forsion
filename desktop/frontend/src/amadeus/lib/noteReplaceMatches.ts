import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkStrike from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import type { Nodes } from 'mdast'
import { classifyPageSource, hasPluginPageStructure } from '@amadeus-shared/compiler/v4'
import { WIKILINK_RE } from '@amadeus-shared/links'
import { CALLOUT_TOKEN_SRC } from '@amadeus-shared/calloutToken'
import { isDashboardPath } from '@amadeus-shared/dashboard'
import { isBuiltinFileType } from '@amadeus-shared/builtinTypes'
import { scanObsidian, type ObsSpan } from '../blocks/markdown/inlineTextSpans'
import { displayRanges } from './noteReplaceDisplayRanges'
import { splitFm } from '../unified/fm'

const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })
  .use(remarkMath).use(remarkCjkFriendly).use(remarkCjkStrike, { singleTilde: false })

export interface ReplaceMatch { id: string; from: number; to: number; quote: boolean }
export interface ReplaceFile { path: string; source: string; fileId?: string; matches: ReplaceMatch[] }

export function isReplaceNotePath(path: string): boolean {
  return /\.md$/i.test(path) && !isBuiltinFileType(path) && !isDashboardPath(path)
}

// Forsion recognizes these even in already-decoded ProseMirror text. A Markdown entity
// can escape a heading marker, but does not turn an embedded note into inert text.
const noteTokenSource = [
  '!?'+ WIKILINK_RE.source, CALLOUT_TOKEN_SRC + '[+-]?',
  String.raw`(?:^|(?<=\s))\^[\w-]+(?=[ \t]*$)`,
  String.raw`\$\$[^$]+?\$\$|\$[^\s$](?:[^\n$]*?[^\s$])?\$`,
].join('|')
const noteTokens = new RegExp(noteTokenSource, 'gim')
const protectedSyntax = new RegExp([
  noteTokenSource, String.raw`\\[!-/:-@\[-\x60{-~]`,
  String.raw`&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);`,
  String.raw`<(?<tag>code|pre|script|style|kbd)\b[^>]*>[\s\S]*?<\/\k<tag>\s*>`,
].join('|'), 'gim')

const textblock = (node: Nodes): boolean => node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell'

// Match the editor's textblock projection: marks can split a delimiter pair, a hard break
// is a newline, and code text takes up space without providing markup delimiters.
function blockText(node: Nodes): string {
  if (node.type === 'text') return node.value
  if (node.type === 'inlineCode') return ' '.repeat(node.value.length)
  if (node.type === 'break') return '\n'
  if ('children' in node) return node.children.map(blockText).join('')
  return '\uFFFC'
}

/** Work only on raw source slices belonging to visible text leaves. Never stringify the note. */
export function noteReplaceMatches(path: string, source: string, query: string): ReplaceMatch[] {
  if (!query.trim() || /[\r\n]/.test(query) || !source.includes(query) || !isReplaceNotePath(path)) return []
  const { fmText, body } = splitFm(source)
  if (classifyPageSource(fmText) === 'future' || hasPluginPageStructure(path, fmText)) return []
  const matches: ReplaceMatch[] = []

  // Wiki targets and block IDs are meaningful to Forsion even though CommonMark sees ordinary text.
  // A wiki label can contain emphasis and straddle more than one mdast node.
  const protectedRanges = Array.from(body.matchAll(protectedSyntax), (m) => [m.index!, m.index! + m[0].length])
  let nextRange = 0
  function walk(node: Nodes, quote: boolean, decoration?: { hidden: ObsSpan[]; offset: number }): void {
    if (textblock(node)) {
      const spans = scanObsidian(blockText(node))
      const hidden = spans.flatMap(sp => sp.kind === 'cmt' ? [sp] : [
        { ...sp, to: sp.from + 2 }, { ...sp, from: sp.to - 2 },
      ])
      decoration = hidden.length ? { hidden, offset: 0 } : undefined
    }
    const pos = node.position
    if (!pos || pos.start.offset == null || pos.end.offset == null) return
    const from = pos.start.offset
    const end = pos.end.offset
    if ((node.type === 'link' && body[from] !== '[') || (node.type === 'linkReference' && node.referenceType !== 'full')) {
      if (decoration) decoration.offset += blockText(node).length
      return // the label is also the destination or reference key
    }
    if (node.type === 'text') {
      // Within a multiline text leaf, markdown quote/list continuation prefixes are not visible text.
      const first = matches.length
      let start = from
      for (const line of body.slice(from, end).split('\n')) {
        const prefix = start === from ? 0 : /^[ \t]*(?:>[ \t]*)*/.exec(line)![0].length
        let column = line.indexOf(query, prefix)
        while (column !== -1) {
          const at = start + column
          while (nextRange < protectedRanges.length && protectedRanges[nextRange][1] <= at) nextRange++
          if (nextRange === protectedRanges.length || protectedRanges[nextRange][0] >= at + query.length) {
            const offset = at + fmText.length
            matches.push({ id: JSON.stringify([path, offset]), from: offset, to: offset + query.length, quote })
          }
          column = line.indexOf(query, column + query.length)
        }
        start += line.length + 1
      }
      if (decoration) {
        const hits = matches.splice(first)
        const ranges = displayRanges(body.slice(from, end), node.value, hits, fmText.length + from)
        for (const {hit, left, right} of ranges) {
          const offset = decoration.offset
          if (!decoration.hidden.some(span => left + offset < span.to && right + offset > span.from)) matches.push(hit)
        }
        decoration.offset += node.value.length
      }
      return
    }
    // Raw HTML, code, math, definitions and images have no text children.
    if ('children' in node) for (const child of node.children) walk(child, quote || node.type === 'blockquote', decoration)
    else if (decoration) decoration.offset += blockText(node).length
  }
  walk(parser.parse(body), false)
  return matches
}

/** Splice only frozen source offsets. Undo works even for deletions and adjacent matches. */
export function spliceNoteText(source: string, offsets: number[], query: string, replacement: string, reverse: boolean): string {
  const parts: string[] = []
  const remove = reverse ? replacement : query
  const insert = reverse ? query : replacement
  let end = 0
  for (let i = 0; i < offsets.length; i++) {
    const at = offsets[i] + (reverse ? i * (replacement.length - query.length) : 0)
    if (at < end || at > source.length || !source.startsWith(remove, at)) throw new Error('Replacement no longer matches')
    parts.push(source.slice(end, at), insert)
    end = at + remove.length
  }
  parts.push(source.slice(end))
  return parts.join('')
}

// Compare the resulting Markdown tree, including links, reference IDs and formatting, against the intended
// literal text edit. For example, replacing “old” by “1” in “old. Example” must not create a numbered list.
function treeSignature(source: string, marker = '', replacement = ''): string {
  function normalize(node: Nodes): unknown {
    const { position: _position, ...rest } = node
    if (node.type === 'text') {
      const value = marker ? node.value.split(marker).join(replacement) : node.value
      return value ? { type: 'text', value, tokens: node.value.match(noteTokens) } : null
    }
    if ('children' in node) {
      const children = node.children.map(normalize).filter(x => x !== null)
      if (node.type === 'paragraph' && !children.length) return null
      if (textblock(node)) {
        const text = blockText(node)
        const literal = (raw: string): string => marker ? raw.split(marker).join(replacement) : raw
        const decorations = scanObsidian(text).map(span => ({
          kind: span.kind, from: literal(text.slice(0, span.from)).length, value: literal(text.slice(span.from, span.to)),
        }))
        return { ...rest, children, tokens: text.match(noteTokens), decorations }
      }
      return { ...rest, children }
    }
    return rest
  }
  return JSON.stringify(normalize(parser.parse(splitFm(source).body)))
}

export function prepareLiteralReplacement(source: string, offsets: number[], query: string, replacement: string): { after: string; encoded?: string } | null {
  let marker = 'ForsionReplaceLiteral'
  while (source.includes(marker) || replacement.includes(marker)) marker += 'X'
  const expected = treeSignature(spliceNoteText(source, offsets, query, marker, false), marker, replacement)
  // All three candidate encodings represent exactly the user's visible text. Prefer leaving source readable.
  const escaped = replacement.replace(/[!-/:-@\[-`{-~]/g, '\\$&')
  const entities = Array.from(replacement, c => '&#' + c.codePointAt(0) + ';').join('')
  const originalFm = splitFm(source).fmText
  for (const encoded of new Set([replacement, escaped, entities])) {
    const after = spliceNoteText(source, offsets, query, encoded, false)
    if (splitFm(after).fmText === originalFm && treeSignature(after) === expected) return { after, encoded: encoded === replacement ? undefined : encoded }
  }
  // E.g. deleting only “old” in “old# Title” would reinterpret untouched bytes as a heading.
  return null
}
