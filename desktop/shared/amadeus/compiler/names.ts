// Id generation + note path helpers. v3 is single-file, so there are no block/folder
// filenames to derive — a note's blocks live inline in its one `.md`.

import { customAlphabet } from 'nanoid'
import type { BlockId, ColumnId, RowId } from './types'

// Lowercase alphanumerics only: safe on case-insensitive filesystems (macOS/Windows).
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const nano = customAlphabet(ALPHABET, 8)

/** The next free block id for a note: a short integer, one past the highest in use.
 *  Block ids are local to one file and only delimit ranges (the meaning is in the layout),
 *  so a number suffices. They are assigned-and-kept (never renumbered), so a cross-note
 *  `![[note#3]]` keeps pointing at the same block across edits. */
/** `floor` = the note's persisted high-water mark (manifest.nextId): ids at/above it were
 *  never handed out twice even if the highest block was deleted — without it, max+1 reuses
 *  a freshly-deleted id and external `![[note#N]]` silently rebinds to new content. */
export function nextBlockId(existing: Iterable<BlockId>, floor = 1): BlockId {
  let max = 0
  for (const id of existing) {
    const n = Number.parseInt(String(id), 10)
    // isSafeInteger:超出安全整数的 id 参与 max 会让 max+1 == max(浮点),「新」号与现存同号。
    if (Number.isSafeInteger(n) && String(n) === String(id) && n > max) max = n
  }
  return String(Math.max(max + 1, floor))
}
/** Advance the high-water mark past `id` (numeric ids only). MUST be called both when an id
 *  is allocated and when its block is deleted: allocation alone isn't enough (allocate 7 at
 *  floor 7 → delete 7 → floor still 7 → reuse), deletion alone isn't enough either (a clean
 *  1,2 note has no stored floor, deleting 2 must raise it to 3 before the next insert). */
export function bumpNextId(current: number | undefined, id: BlockId): number | undefined {
  const n = Number.parseInt(String(id), 10)
  if (!Number.isSafeInteger(n) || String(n) !== String(id)) return current
  return Math.max(current ?? 0, n + 1)
}

export function generatePageId(): string {
  return `pg_${nano()}`
}
export function generateRowId(): RowId {
  return `row_${nano()}`
}
export function generateColumnId(): ColumnId {
  return `col_${nano()}`
}

/** Last path segment of a page path with its trailing extension removed ("Notes/abc.md" -> "abc"). */
export function stripPageBasename(pagePath: string): string {
  const seg = pagePath.split(/[\\/]/).pop() ?? pagePath
  const dot = seg.lastIndexOf('.')
  return dot > 0 ? seg.slice(0, dot) : seg
}

/** Just the note file name within its folder ("Notes/abc.md" -> "abc.md"). */
export function pageFileName(pagePath: string): string {
  return pagePath.split(/[\\/]/).pop() ?? pagePath
}
