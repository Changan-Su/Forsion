// The inline block-boundary codec. Each block opens with `<!-- a <id> -->` on its own
// line; the block's content runs to the next marker (or end of body). Markers are HTML
// comments, so Obsidian/any viewer renders them as nothing — the note reads as plain
// markdown. The 2D layout lives in frontmatter, NOT here, so the marker carries only an id —
// a short per-file integer (`<!-- a 3 -->`), since a block only delimits a range.

import type { BlockId } from './types'

/** One line: `<!-- a 3 -->` (allow surrounding whitespace; id is a short token).
 *  Charset includes `-`: agents write ids like `ai-root`; before 2026-08-05 those fell
 *  through as content and a 44-marker note silently collapsed into ONE block. Accepting
 *  them here lets parseV3's renumber pass heal such files to clean numeric ids. */
export const BLOCK_MARKER_RE = /^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->\s*$/

export function blockMarker(id: BlockId): string {
  return `<!-- a ${id} -->`
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
    const content = buf.join('\n').trim()
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
      buf.push(line)
    }
  }
  flush()
  return out
}
