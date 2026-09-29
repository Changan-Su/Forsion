// `![[笔记…]]` 跨笔记嵌入的目标拆解与 v4 切片(评审 L-15)。纯函数、isomorphic —— 主进程索引(desktop vaultIndex)、
// 移动端索引移植、web 云桥的客户端兜底共用这一份。
//
// v3 的块嵌入是 `![[笔记#3]]`(marker `<!-- a 3 -->` 的 id),由各索引自己先按 id 找;本文件管 v4 素文件的三种写法:
//   `![[笔记#标题]]`  → 只读切出那一节(标题行起,到下一个同级或更高级标题前;匹配口径 = findHeadingIndex,
//                      与 `[[笔记#标题]]` 跳转 / 聊天引用条同一套:精确优先、容行内格式、嵌套链 `#H1#H2` 按祖先链);
//   `![[笔记#^块]]`   → 只读解析**已有的** Obsidian 块锚(挂在块最后一行尾部的 `^id`;整行只有 `^id` 指上一个块);
//   `![[笔记|x]]`     → `|` 后是别名 / 宽度,不参与解析。
// ⚠️ server 仓(microserver/amadeus/lib/indexing.ts 的 findBlock)有自己的一份标题回退(精确小写匹配、按最后一个 `#`
//    拆),不认 `^块` 与嵌套链;本文件**不**在 server 的 vendor 清单里 —— 两边对齐是 server 仓的后续(见提交说明)。
import { findHeadingIndex, isLoneBlockId, parseBlockSubpath, splitLinkInner, trailingBlockId } from './pdfLink'

/** `笔记#锚点|别名` → { note, subpath }:剥掉 `|` 后缀,按**第一个** `#` 拆(嵌套链的其余 `#` 留在 subpath 里)。
 *  笔记名为空(`![[#标题]]`)= 本篇。 */
export function splitNoteEmbed(target: string): { note: string; subpath: string | null } {
  const { target: note, subpath } = splitLinkInner(target)
  return { note, subpath }
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const LIST_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/

/** 每行是否在围栏代码里(开栏 / 闭栏行本身也算「在」:它们不是标题、也不挂块锚)。同字符、闭栏不短于开栏才收。 */
function fenceMask(lines: string[]): boolean[] {
  const out: boolean[] = []
  let open: string | null = null
  for (const line of lines) {
    const f = FENCE_RE.exec(line)
    if (open) {
      out.push(true)
      if (f && f[1][0] === open[0] && f[1].length >= open.length && !line.slice(line.indexOf(f[1]) + f[1].length).trim()) open = null
      continue
    }
    if (f) {
      open = f[1]
      out.push(true)
      continue
    }
    out.push(false)
  }
  return out
}

const splitLines = (body: string): string[] => body.split(/\r?\n/)
const tidy = (lines: string[]): string => lines.join('\n').replace(/^\n+|\s+$/g, '')

/** md 源里的标题文字 → 近似编辑器纯文本(findHeadingIndex 的标题侧约定是 PM 纯文本,锚点侧才剥格式;
 *  两侧都粗暴剥 `_` 会把 foo_bar 与 foobar 并成同 key —— 所以这里只拆成对的行内标记,不动孤立的 `_`)。 */
function plainHeading(s: string): string {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, '$1$2')
}

/** `#标题` 嵌入:标题行起,到下一个同级或更高级标题(或文末)前。只认顶层 ATX 标题(围栏内的 `#` 行不算)。 */
export function sliceHeadingSection(body: string, heading: string): string | null {
  const lines = splitLines(body)
  const fenced = fenceMask(lines)
  const hs: Array<{ level: number; text: string; line: number }> = []
  lines.forEach((l, i) => {
    if (fenced[i]) return
    const m = ATX_RE.exec(l)
    if (m && m[2].trim()) hs.push({ level: m[1].length, text: plainHeading(m[2].trim()), line: i })
  })
  const k = findHeadingIndex(hs, heading)
  if (k < 0) return null
  const next = hs.slice(k + 1).find((h) => h.level <= hs[k].level)
  return tidy(lines.slice(hs[k].line, next ? next.line : lines.length))
}

/** 围栏代码块从闭栏行往回找开栏行。 */
function fenceStart(fenced: boolean[], end: number): number {
  let i = end
  while (i > 0 && fenced[i - 1]) i--
  return i
}

/** `^id` 嵌入:只解析**已有的**块锚(本仓自己不产 `^id`,来源只有从 Obsidian 导入的素文件)。
 *  - 列表项(或它的续行)行尾挂锚 → 这一项,连同缩进更深的子项 / 续行;
 *  - 普通段落行尾挂锚 → 空行之间的那一段;
 *  - 整行只有 `^id` → 它上面那一整块(Obsidian 语义:表格 / 引用 / 整只列表 / 代码块都这么标)。
 *  返回的内容去掉锚本身。找不到 → null。 */
export function sliceAnchoredBlock(body: string, id: string): string | null {
  const lines = splitLines(body)
  const fenced = fenceMask(lines)
  const at = lines.findIndex((l, i) => !fenced[i] && trailingBlockId(l) === id)
  if (at < 0) return null
  const indentOf = (l: string): number => /^[ \t]*/.exec(l)![0].length
  const inBlock = (i: number): boolean => i >= 0 && !!lines[i].trim() && !fenced[i]
  if (isLoneBlockId(lines[at])) {
    let end = at - 1
    while (end >= 0 && !lines[end].trim()) end--
    if (end < 0) return null
    if (fenced[end]) return tidy(lines.slice(fenceStart(fenced, end), end + 1)) // 光杆锚标的是代码块
    let start = end
    while (inBlock(start - 1)) start--
    return tidy(lines.slice(start, end + 1))
  }
  // 行尾挂锚:往上找块首 —— 段落到空行为止;途经列表项行就停在那一项(锚挂在项上 / 项的续行上)。
  let start = at
  while (!LIST_RE.test(lines[start]) && inBlock(start - 1)) start--
  let stop = at + 1
  const item = LIST_RE.exec(lines[start])
  if (item) {
    // 列表项:收下缩进比项首更深的后续行(子项 / 续行);空行之后仍更深缩进的也算(松散列表)。
    const indent = item[1].length
    while (stop < lines.length) {
      if (!lines[stop].trim()) {
        const nxt = lines.slice(stop + 1).find((x) => x.trim())
        if (nxt == null || indentOf(nxt) <= indent) break
      } else if (indentOf(lines[stop]) <= indent) break
      stop++
    }
  } else {
    while (inBlock(stop)) stop++
  }
  const out = lines.slice(start, stop)
  out[at - start] = out[at - start].replace(/[ \t]*\^[A-Za-z0-9-]+[ \t]*$/, '')
  return tidy(out)
}

/** 嵌入锚点分派:块锚先判(`^` 开头但字符集不合的畸形形态不当标题,同 ChatWikiLink),其余一律按标题。 */
export function sliceEmbedSubpath(body: string, subpath: string): string | null {
  const block = parseBlockSubpath(subpath)
  if (block) return sliceAnchoredBlock(body, block)
  if (subpath.trim().startsWith('^')) return null
  return sliceHeadingSection(body, subpath)
}
