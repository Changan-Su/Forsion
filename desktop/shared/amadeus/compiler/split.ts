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
 *  value is a single-line JSON string (decoded by parseLayout), so the rest-of-line is kept verbatim.
 *  键容忍 YAML 引号("amadeus_schema": 是合法写法):否则版本闸/升级拒绝全被引号绕过(Codex)。 */
function parseSimpleYaml(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of s.split('\n')) {
    const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+)):\s*(.*)$/.exec(line)
    if (m) out[m[1] ?? m[2] ?? m[3]] = m[4].trim()
  }
  return out
}

/** Strip a leading YAML frontmatter block, returning just the body.
 *  正则口径(Codex P0 两条,2026-08-13):①空 frontmatter `---\n---\n` 是合法块,必须认
 *  (认不出 → 整块喂进编辑器,首存被序列化成水平线=毁档);②收尾栅栏必须**独占一行**
 *  (`---broken` 不是栅栏 —— 老写法把行中 `---` 当收尾,拆分口径偏离 remark,错拆重写)。
 *  改此正则须同步:db/pageFrontmatter FM_BLOCK_RE、links.ts、server indexing.ts、tangu-agent amadeus.ts。 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, '')
}

/** Read a note's frontmatter (amadeus_page / amadeus_schema / amadeus_layout / foreign keys). */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const tree = parser.parse(markdown) as unknown as MdRoot
  for (const node of tree.children ?? []) {
    if (node.type === 'yaml') return parseSimpleYaml(node.value ?? '')
  }
  return {}
}

/** Reserved single-line keys we own; everything else in the frontmatter is the user's.
 *  键侧同样容忍引号:带引号的 `"amadeus_page":` 若漏过此过滤,会经 fmExtra 落盘劫持页结构。 */
export const AMADEUS_FM_KEY = /^["']?(amadeus_page|amadeus_schema|amadeus_layout|amadeus_canvas|amadeus_next_id)["']?\s*:/

/** Major of `amadeus_schema` ("amadeus.page/3" → 3), or null when absent/unparseable.
 *  容忍 YAML 引号:parseSimpleYaml 取整行原文,"amadeus.page/4" 带引号也必须被闸认出(Codex)。 */
export function schemaMajorOf(fm: Record<string, string>): number | null {
  const m = /^["']?amadeus\.page\/(\d+)\b/.exec(fm.amadeus_schema ?? '')
  return m ? Number.parseInt(m[1], 10) : null
}

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
