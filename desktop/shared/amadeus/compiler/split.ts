// Markdown helpers over the remark/mdast AST. In v2 the note body is a generated
// `![[]]` projection that we never read back for content — so these are used only to
// (a) read a note's frontmatter (id + layout) and (b) split a FOREIGN plain-markdown
// file into blocks when importing it into the folder-bundle format.

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  [k: string]: unknown
}
interface MdRoot {
  type: 'root'
  children: MdNode[]
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml'])
const stringifier = unified()
  .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one', rule: '-' })
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])

function nodesToMarkdown(nodes: MdNode[]): string {
  const root: MdRoot = { type: 'root', children: nodes }
  return String(stringifier.stringify(root as never)).trim()
}

/** Normalize a markdown string through the parse→stringify pipeline (stable comparisons). */
export function normalizeMarkdown(markdown: string): string {
  const tree = parser.parse(markdown) as unknown as MdRoot
  return nodesToMarkdown(tree.children ?? [])
}

/** Parse a YAML frontmatter block into flat key→(rest-of-line) values. The `amadeus_layout`
 *  value is a single-line JSON string (decoded by parseLayout), so the rest-of-line is kept verbatim. */
function parseSimpleYaml(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of s.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

/** Strip a leading YAML frontmatter block, returning just the body. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/** Read a note's frontmatter (amadeus_page / amadeus_schema / amadeus_layout / foreign keys). */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const tree = parser.parse(markdown) as unknown as MdRoot
  for (const node of tree.children ?? []) {
    if (node.type === 'yaml') return parseSimpleYaml(node.value ?? '')
  }
  return {}
}

/** Reserved single-line keys we own; everything else in the frontmatter is the user's. */
export const AMADEUS_FM_KEY = /^(amadeus_page|amadeus_schema|amadeus_layout|amadeus_next_id):/

/** Foreign frontmatter lines (everything except the amadeus_* keys), verbatim — multi-line
 *  values, comments and ordering preserved. '' when the note has no foreign frontmatter. */
export function extractFrontmatterExtra(markdown: string): string {
  const tree = parser.parse(markdown) as unknown as MdRoot
  for (const node of tree.children ?? []) {
    if (node.type === 'yaml') {
      return (node.value ?? '')
        .split('\n')
        .filter((l) => !AMADEUS_FM_KEY.test(l))
        .join('\n')
        .replace(/^\n+|\n+$/g, '')
    }
  }
  return ''
}

/** Split a FOREIGN plain-markdown document into one markdown string per top-level block. */
export function splitIntoBlocks(markdown: string): string[] {
  const tree = parser.parse(markdown) as unknown as MdRoot
  const out: string[] = []
  for (const node of tree.children ?? []) {
    if (node.type === 'yaml') continue
    const md = nodesToMarkdown([node])
    if (md) out.push(md)
  }
  return out
}
