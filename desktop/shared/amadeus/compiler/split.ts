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
 *  键容忍 YAML 引号("amadeus_schema": 是合法写法):否则版本闸/升级拒绝全被引号绕过(Codex)。
 *  按 /\r?\n/ 切行(N-1,2026-09-28):remark 的 yaml 节点保留 CRLF 行尾,而 `(.*)$` 越不过 `\r` ——
 *  按 '\n' 切时 CRLF 笔记只认得最后一个键,v3 被判成 v4-plain、跳过升级,首击把分栏布局写坏。 */
function parseSimpleYaml(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of s.split(/\r?\n/)) {
    const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+)):\s*(.*)$/.exec(line)
    if (m) out[m[1] ?? m[2] ?? m[3]] = m[4].trim()
  }
  return out
}

/** 文件头 UTF-8 BOM(U+FEFF)。旧版记事本等工具会写出它;micromark 解析前先剥掉它,所以
 *  remark(parseFrontmatter)照认 fm —— 正则口径不认就是两套判据结论相反(D-01)。 */
export const BOM = '\uFEFF'

/** Strip a leading YAML frontmatter block, returning just the body.
 *  正则口径(Codex P0 两条,2026-08-13):①空 frontmatter `---\n---\n` 是合法块,必须认
 *  (认不出 → 整块喂进编辑器,首存被序列化成水平线=毁档);②收尾栅栏必须**独占一行**
 *  (`---broken` 不是栅栏 —— 老写法把行中 `---` 当收尾,拆分口径偏离 remark,错拆重写);
 *  ③容许文件头 BOM(D-01,2026-09-27):BOM 随 fm 块一起剥走 —— 调用方(UnifiedPage 的 splitFm)
 *  把它并进 fm 原文,拼回时逐字还原,磁盘字节不变。
 *  改此正则须同步:db/pageFrontmatter FM_BLOCK_RE、unified/fm.ts、links.ts stripForIndex(与
 *  mdMarks.findMarkLine 成对)、services/fileKinds.ts、server indexing.ts、tangu-agent amadeus.ts。 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, '')
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

/** frontmatter 内文按**顶层 YAML 条目**分组(V-01,2026-09-27 评审 P0)。一组 = 一个顶格行(键行)+ 它的
 *  续行:缩进行、顶格 `- ` 序列项,以及夹在它们中间的空行/顶格注释;后面不再接续行的空行/顶格注释
 *  各自单独成组(不属于任何键)。行尾 `\r`(CRLF 源文按 '\n' 切)不影响判定。
 *  为什么要有它:外部 YAML 工具(项目自己的 yaml 包按缺省配置往返一次就会)把单行 JSON 的
 *  amadeus_canvas / amadeus_layout 重排成块状多行。「逐行过滤 amadeus_* 键」只摘走键行、把缩进续行
 *  留成孤儿 → 整块 fm 解析不了,tags 等全部属性失效,画布/分栏几何永久丢失。所以凡是要把
 *  amadeus_* 与外来键分开的地方,一律按组搬,别再逐行过滤。 */
export function fmEntries(lines: readonly string[]): string[][] {
  const out: string[][] = []
  let cur: string[] | null = null
  let gap: string[] = []
  const flushGap = (): void => {
    for (const g of gap) out.push([g])
    gap = []
  }
  for (const l of lines) {
    if (!l.trim() || l.startsWith('#')) {
      gap.push(l) // 空行 / 顶格注释:归属看后面还有没有续行
    } else if (/^[ \t]/.test(l) || /^-(?:[ \t]|\r?$)/.test(l)) {
      if (cur) {
        cur.push(...gap, l) // 续行(连同夹在中间的空行/注释)归当前条目
        gap = []
      } else {
        flushGap()
        out.push([l]) // 开头就是续行(没有键可归):单独成组,原样留着
      }
    } else {
      flushGap()
      cur = [l]
      out.push(cur)
    }
  }
  flushGap()
  return out
}

/** Foreign frontmatter lines (everything except the amadeus_* keys), verbatim — multi-line
 *  values, comments and ordering preserved. '' when the note has no foreign frontmatter.
 *  按条目(fmEntries)剔 amadeus_*:块状写法的续行跟着键一起走,不留孤儿(V-01)。 */
export function extractFrontmatterExtra(markdown: string): string {
  const tree = parser.parse(markdown) as unknown as MdRoot
  for (const node of tree.children ?? []) {
    if (node.type === 'yaml') {
      return fmEntries((node.value ?? '').split('\n'))
        .filter((e) => !AMADEUS_FM_KEY.test(e[0]))
        .flat()
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
