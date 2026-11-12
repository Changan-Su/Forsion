import type { UiMessage } from '../../types'
import { splitSuggestions, type FenceKind, type SuggestState } from './suggest'

/** The visible prose can span several tool-separated segments; content holds only the final one. */
export function replyText(msg: Pick<UiMessage, 'content' | 'segments' | 'status'>, kinds?: FenceKind[]): string {
  const texts = msg.segments?.flatMap((seg) => seg.t === 'text' ? [seg.text] : [])
  if (!texts?.length) return splitSuggestions(msg.content, { kinds, streaming: msg.status === 'streaming' }).text
  let state: SuggestState | undefined
  return texts.map((text, i) => {
    const parsed = splitSuggestions(text, { kinds, state, streaming: msg.status === 'streaming' || i < texts.length - 1 })
    state = parsed.state
    return parsed.text
  }).filter((text) => text.trim()).join('\n\n')
}
