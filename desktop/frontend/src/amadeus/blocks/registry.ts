// The BlockType registry — the seam that keeps blocks pluggable. The page/layout
// engine never knows how a block edits or renders; it dispatches through here.
// Swapping the markdown editor (Phase 1 Milkdown -> anything) is a BlockType change,
// with zero change to the on-disk file format.

import type { ComponentType } from 'react'

/** 'body-enter' 仅统一实例的标题回车发出(AFFiNE 语义:首块非空段则顶插空段再落光标);
 *  v3 逐块宿主永远只发 start/end,消费侧把它当 start 兜底即可。 */
export type FocusPlace = 'start' | 'end' | 'body-enter'

export interface BlockEditorProps {
  blockId: string
  /** Current markdown content of the block. */
  content: string
  /** Vault-relative path of the page this block belongs to (for resolving asset links). */
  pagePath: string
  autoFocus?: boolean
  /** Render-only mode (cross-note embeds): no editing, no slash, no caret nav. */
  readOnly?: boolean
  /** Emit new markdown (debounced persistence happens in the store). */
  onChange(content: string): void
  /** Create a new block after this one (Shift+Enter, or slash on a non-empty block) and focus it. */
  onInsertAfter(content?: string): void
  /** Insert a cross-note embed cell for the given block basename (e.g. from a copied `![[ ]]`). */
  onInsertEmbed?(target: string): void
  /** Backspace in an empty block → delete it and focus the previous block. */
  onDeleteEmpty(): void
  /** Backspace at the start of a non-empty block → merge it into the previous block. */
  onMergePrev(): void
  /** Caret tried to leave the top/bottom of the block → move focus to the spatial neighbour.
   *  goalX = the caret's viewport X so the neighbour can keep the same horizontal column. */
  onArrowOut(dir: 'prev' | 'next', goalX?: number): void
  /** Mod+Shift+ArrowUp/Down → reorder this block within its column. */
  onMoveDir(dir: 'up' | 'down'): void
  /** A pending caret target for THIS block (after create/delete/nav), or null. */
  focusPlace: FocusPlace | null
  /** When crossing in via ↑↓, the goal column (viewport X) to land on within the first/last line. */
  focusGoalX?: number
  /** 源码模式切回时带来的「光标前文本」:块内按它找回落点,找不到就停在块首(见 lib/modeCursor)。 */
  focusAnchor?: string
  /** Notify that the caret has been placed (clears the pending request). */
  onFocused(): void
  /** Ask for the caret to (re)enter THIS block — e.g. after a slash transform. */
  requestSelfFocus(place: FocusPlace): void
  /** Open the page named by a clicked [[wikilink]]. */
  onOpenWiki(name: string): void
  /** All page paths in the vault — for [[ autocomplete suggestions. */
  getPageNames(): string[]
}

export interface BlockType {
  id: string
  fileExtensions: string[]
  Editor: ComponentType<BlockEditorProps>
}

const registry = new Map<string, BlockType>()

export function registerBlockType(t: BlockType): void {
  registry.set(t.id, t)
}

export function getBlockType(id: string): BlockType | undefined {
  return registry.get(id)
}
