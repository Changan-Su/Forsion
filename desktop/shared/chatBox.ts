/** DOM plugin contract. No React, store, credentials, or implicit active-session access. */
export interface ChatBoxSelection {
  modelId: string
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}
export interface ChatBoxSubmission extends ChatBoxSelection { text: string }
export interface PluginChatBoxSuggestItem {
  label: string
  hint?: string
  /** Replaces trigger + query. The host appends one space. */
  value: string
}
export interface PluginChatBoxSuggest {
  /** Non-empty, e.g. `#`. Must sit at line start or after whitespace. */
  trigger: string
  /** Called with the text typed after the trigger (letters, digits, `_`, `/`, `-`; never empty). A rejection closes the menu. */
  items(query: string): PluginChatBoxSuggestItem[] | Promise<PluginChatBoxSuggestItem[]>
}
export interface PluginChatBoxOptions {
  value?: string
  modelId?: string
  thinkingLevel?: ChatBoxSelection['thinkingLevel']
  placeholder?: string
  label?: string
  submitLabel?: string
  disabled?: boolean
  submitOn?: 'enter' | 'modifier-enter'
  /** Optional initial defaults; changes stay local until the caller handles onSubmit. */
  agentSlug?: string
  /** false hides the model and effort pill and skips resolving the default model. Drafts then carry `modelId` as given
   *  (`''` when unset) and `thinkingLevel` as given (`'medium'` when unset). Default true. */
  modelPicker?: boolean
  /** Fills a host slot at the left of the bottom row, before the model pill. The returned cleanup runs on dispose, and when
   *  a later update() passes a different function. Exceptions from either are logged and contained. */
  toolbar?(el: HTMLElement): void | (() => void)
  /** Host menu next to the caret. Same look and keys as the editor's `#` completion: ↑↓ Enter Tab Esc; opens only while
   *  typing, never during IME composition; Enter on a highlighted row picks it and does not submit. */
  suggest?: PluginChatBoxSuggest
  onChange?(draft: ChatBoxSubmission): void
  /** true clears the submitted text; false/rejection keeps it for retry. No automatic AI run. */
  onSubmit(draft: ChatBoxSubmission): boolean | Promise<boolean>
}
export interface PluginChatBoxHandle {
  update(patch: Partial<PluginChatBoxOptions>): void
  focus(): void
  /** Inserts at the caret, replacing any selection, and focuses the input. Older hosts lack this method: it is how a plugin
   *  detects modelPicker, toolbar and suggest too, which those hosts ignore. */
  insertText(text: string): void
  /** Idempotent. Afterwards the element is the plugin's again at once: clear it, or mount on it again. */
  dispose(): void
}

export interface ChatBoxSuggestMatch {
  query: string
  /** Range of trigger + query in the text. */
  from: number
  to: number
}

const QUERY_CHAR = /^[\p{L}\p{N}_/-]/u

/** The trigger + query directly before the caret, or null. Same rule as the editor's `#` completion: the trigger starts a
 *  word, the query is non-empty, and the caret is not in the middle of a word. */
export function matchChatBoxSuggest(value: string, caret: number, trigger: string): ChatBoxSuggestMatch | null {
  if (!trigger) return null
  const escaped = trigger.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
  const m = new RegExp(`(?:^|\\s)${escaped}([\\p{L}\\p{N}_/-]+)$`, 'u').exec(value.slice(0, caret))
  if (!m || QUERY_CHAR.test(value.slice(caret))) return null
  return { query: m[1], from: caret - m[1].length - trigger.length, to: caret }
}
