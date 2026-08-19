// The inline block-boundary codec. Each block opens with `<!-- a <id> -->` on its own
// line; the block's content runs to the next marker (or end of body). Markers are HTML
// comments, so Obsidian/any viewer renders them as nothing — the note reads as plain
// markdown. The 2D layout lives in frontmatter, NOT here, so the marker carries only an id —
// a short per-file integer (`<!-- a 3 -->`), since a block only delimits a range.

import type { BlockId } from './types'

/** One line: `<!-- a 3 -->` (allow surrounding whitespace; id is a short token).
 *  Charset includes `-`: agents/plugins write ids like `ai-root`; before 2026-08-05 those
 *  fell through as content and a 44-marker note silently collapsed into ONE block. Valid
 *  unique ids are kept verbatim (never renumbered): frontmatter id-trees outside the layout
 *  (mindmap:/dashboard keys) reference them, and renumbering would sever those. */
export const BLOCK_MARKER_RE = /^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->\s*$/

/** Closer line: `<!-- /a 3 -->` (2026-08-19, canvas cards moved to wrapped `open…close` form).
 *  A closer ENDS the current block's scope — content after it is anonymous main flow (id null)
 *  until the next open marker. v3 files never contain closers, so this branch never fires there.
 *  ⚠️ 改本文件须 cp server vendor(server/microserver/amadeus/vendor/markers.ts)。 */
export const BLOCK_CLOSE_RE = /^<!--\s*\/a\s+([A-Za-z0-9_-]+)\s*-->\s*$/

export function blockMarker(id: BlockId): string {
  return `<!-- a ${id} -->`
}

export function blockCloser(id: BlockId): string {
  return `<!-- /a ${id} -->`
}

export interface ParsedBlock {
  /** null for leading content that precedes the first marker (import/foreign). */
  id: BlockId | null
  content: string
}

/** Split a note BODY (frontmatter already stripped) into blocks by their open markers. */
export function parseBody(body: string): ParsedBlock[] {
  const out: ParsedBlock[] = []
  let curId: BlockId | null = null
  let buf: string[] = []
  const flush = (): void => {
    // 掐首尾空行与尾部空白,但**保住首个非空行的行首横向空白**:行首制表符是段落缩进档
    // (indentIo,2026-08-14),裸 .trim() 会在每次 parse 时把它静默抹平。
    // 尾部必须 trimEnd()(与 \s 同字符集、原生线性)—— `/\s+$/` 在长空白 run 上二次方回溯
    // 可冻结主进程(评审 P1);前导正则吃 \r 防 CRLF 正文留 \r\n 垃圾前缀(评审 P2)。
    const content = buf.join('\n').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
    // Emit a block if it has an id (even when empty) or any leading content.
    if (curId !== null || content) out.push({ id: curId, content })
    buf = []
  }
  for (const line of body.split('\n')) {
    const m = BLOCK_MARKER_RE.exec(line)
    if (m) {
      flush()
      curId = m[1]
    } else {
      const c = BLOCK_CLOSE_RE.exec(line)
      if (c && curId !== null && c[1] === curId) {
        // 闭合符**只认自家 id**(与前端 foldCanvas 同规,Codex 08-19 high:任意闭合符收束会让
        // 编译器与编辑器对同一文件切出不同的块辖域):匹配才收束,之后是匿名主流(嵌入
        // ![[note#id]] 与索引因此不吞卡后的正文)。不匹配/孤儿闭合符按字面内容保留。
        flush()
        curId = null
      } else {
        buf.push(line)
      }
    }
  }
  flush()
  return out
}
