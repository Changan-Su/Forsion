import type { Root, RootContent } from 'mdast'
import { parseMarkdown } from './markdownParse'

export interface MarkdownChunk {
  offset: number
  content: string
  headingStart: number
  headings: number
}
export interface MarkdownSnapshot {
  source: string
  chunks: MarkdownChunk[]
  whole: boolean
}

/** Parse only the mutable suffix of append-only model output. Keep TWO top-level groups
 * open: setext headings, table delimiters, lazy list/quote continuations and unfinished fences
 * can change the last block. Boundaries must be BOTH parser block boundaries and separated
 * by a blank source line; adjacent nodes can depend on the preceding block's context.
 * On replacements or completion callers can omit previous to reparse the full source.
 * Reference definitions/footnotes have document-wide scope: fall back to one normal Markdown
 * document as soon as one appears (including definitions nested inside quotes/lists).
 */
export function markdownSnapshot(source: string, previous?: MarkdownSnapshot): MarkdownSnapshot {
  const append = previous && source.startsWith(previous.source)
  // A non-initial BOM is ordinary text. Moving it to the start of a fragment would make
  // Markdown treat it as a document BOM and could turn literal text into a heading/list.
  if ((append && previous.whole) || source.indexOf('\uFEFF', 1) !== -1) return { source, chunks: [chunk(source)], whole: true }
  const stable = append ? previous.chunks.slice(0, -2) : []
  const offset = stable.length ? previous!.chunks[stable.length].offset : 0
  const tail = source.slice(offset)
  const tree: Root = parseMarkdown(tail)
  if (hasGlobalDefinition(tree)) return { source, chunks: [chunk(source)], whole: true }
  let headingStart = stable.reduce((n, c) => n + c.headings, 0)
  const groups: Array<{ start: number; headings: number }> = []
  tree.children.forEach((node, i) => {
    const start = node.position?.start.offset ?? 0
    const gap = i ? tail.slice(tree.children[i - 1].position?.end.offset ?? 0, start).replace(/\r\n?/g, '\n') : ''
    if (!groups.length || /\n[\t ]*\n/.test(gap)) groups.push({ start: i ? lineStart(tail, start) : 0, headings: 0 })
    groups[groups.length - 1].headings += countHeadings(node)
  })
  const chunks = groups.map((group, i) => {
    const end = groups[i + 1]?.start ?? tail.length
    const result = { offset: offset + group.start, content: tail.slice(group.start, end), headingStart, headings: group.headings }
    headingStart += group.headings
    return result
  })
  return { source, chunks: [...stable, ...chunks], whole: false }
}

const chunk = (content: string): MarkdownChunk => ({ offset: 0, content, headingStart: 0, headings: 0 })
const lineStart = (text: string, offset: number) => offset === 0 ? 0 : Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1
type Node = { type: string; depth?: number; children?: Node[]; data?: Record<string, any> }
function hasGlobalDefinition(node: Node): boolean {
  return node.type === 'definition' || node.type === 'footnoteDefinition' || node.type === 'footnoteReference'
    || !!node.children?.some(hasGlobalDefinition)
}
function countHeadings(node: RootContent | Node): number {
  return node.type === 'heading' && 'depth' in node && node.depth! <= 3 ? 1
    : ('children' in node ? node.children?.reduce((n, child) => n + countHeadings(child as Node), 0) : 0) ?? 0
}

/** Put anchors on the AST instead of creating new React heading component types per delta.
 * Stable component identity preserves DOM, selections, link cards and copy-button state.
 */
export function remarkHeadingAnchors({ prefix, start = 0 }: { prefix?: string; start?: number }) {
  return (tree: Node) => {
    if (!prefix) return
    let i = start
    const walk = (node: Node) => {
      if (node.type === 'heading' && node.depth! <= 3) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: `${prefix}-${i++}`, 'data-toc-level': String(node.depth) } }
      }
      node.children?.forEach(walk)
    }
    walk(tree)
  }
}
