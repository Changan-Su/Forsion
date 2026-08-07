// Pure data contracts for the Amadeus page format (v3: single-file inline).
// MUST stay free of Electron / React / Node-only APIs — runs in BOTH the main process
// and the (sandboxed) renderer.
//
// A note is ONE `.md` file. Its blocks live INLINE, each delimited by an open marker
// `<!-- a <id> -->` (an HTML comment, invisible in Obsidian); a block's content is the
// markdown from its marker to the next marker. The 2D layout lives in the note's
// frontmatter (`amadeus_layout`). Content is stored exactly once (inline) — so loading is
// just parsing the file; there is no projection and nothing to reconcile.
//
// A block whose content is exactly `![[note#blockid]]` is a cross-note embed: Amadeus
// resolves it by scanning the target note's markers and renders it read-only.

export const PAGE_SCHEMA = 'amadeus.page/3' as const
export const COMPILER_VERSION = '3.0.0' as const

export type BlockId = string // e.g. "b_a1b2c3"
export type RowId = string // e.g. "row_1"
export type ColumnId = string // e.g. "col_1a"

/** A reference to a block id inside a column. */
export interface BlockRef {
  ref: BlockId
}

/** One column within a row: a vertical, ordered list of block refs. */
export interface ColumnNode {
  id: ColumnId
  /** Fraction of the row width; columns in a row sum to ~1.0. */
  width: number
  children: BlockRef[]
}

/** A horizontal row of one-or-more columns. */
export interface RowNode {
  type: 'row'
  id: RowId
  columns: ColumnNode[]
}

/** The page root: a vertical stack of rows. Lives in the note's `amadeus_layout` frontmatter. */
export interface StackNode {
  type: 'stack'
  children: RowNode[]
}

export type LayoutNode = StackNode | RowNode | ColumnNode

/** Registry entry: the block's type. Content lives inline in the note body, keyed by id. */
export interface BlockEntry {
  /** Resolves to a registered BlockType ("markdown" | plugin id). */
  type: string
}

/** In-memory page model. The renderer consumes `root` (2D layout) + `blocks`. */
export interface PageManifest {
  schema: typeof PAGE_SCHEMA
  id: string
  title: string
  createdAt: string
  updatedAt: string
  compiler: { version: string }
  root: StackNode
  blocks: Record<BlockId, BlockEntry>
  /** Foreign frontmatter lines (everything but the amadeus_* keys), verbatim — preserved
   *  across load→save so Obsidian properties (tags 等) survive Amadeus edits. */
  fmExtra?: string
  /** Block-id high-water mark (`amadeus_next_id`): the smallest id safe to allocate. Persisted
   *  only when it exceeds max(present)+1, i.e. after the highest block was deleted — keeps ids
   *  from ever being reused so external `![[note#N]]` can't rebind. */
  nextId?: number
  /** Set (in memory only) when `amadeus_schema` declares a major newer than this compiler.
   *  compile() refuses to run — old clients must never "repair" a future-format note. */
  schemaTooNew?: boolean
}

/** A block whose inline content has been parsed from the note. */
export interface LoadedBlock {
  id: BlockId
  type: string
  /** Raw markdown content. If it is exactly an `![[ ]]`, the renderer treats it as an embed. */
  content: string
}

/** In-memory page = manifest + parsed block contents, keyed for O(1) lookup. */
export interface LoadedPage {
  manifest: PageManifest
  blocks: Record<BlockId, LoadedBlock>
}
