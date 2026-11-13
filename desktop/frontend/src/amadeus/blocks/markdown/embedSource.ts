import { PluginKey } from '@milkdown/kit/prose/state'
import type { DecorationSet } from '@milkdown/kit/prose/view'

// Inline wiki widgets leave source ranges owned by the embed layer alone.
export const embedSourceKey = new PluginKey<{
  decos: DecorationSet; sourcePos: number | null; pendingPos: number | null; revealPos: number | null
}>('UNIFIED_EMBED_LAYER')
