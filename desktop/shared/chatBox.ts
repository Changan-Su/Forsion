/** DOM plugin contract. No React, store, credentials, or implicit active-session access. */
import { AT_BLOCKED_BEFORE } from './amadeus/mdMarks'
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
  /** Called with the text typed after the trigger (letters, digits, `_`, `/`, `-`; never empty unless `mention`). A rejection closes the menu. */
  items(query: string): PluginChatBoxSuggestItem[] | Promise<PluginChatBoxSuggestItem[]>
  /** For @-style mentions: opens on the bare trigger, and the trigger may follow CJK text. Only a Latin letter or digit keeps it closed. */
  mention?: boolean
}
/** Host-provided `@` sources (2026-11-20+, capability `'mentions'`): the same `@` panel as in notes. `'date'` lists Today /
 *  Tomorrow and whatever date the user types after `@` (`@11/28`, `@2200`…); `'page'` lists notes in the current vault. */
export type ChatBoxMentionKind = 'date' | 'page'
/** What the user picked from the host's `@` panel. */
export type ChatBoxMention =
  /** `value` is `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (the note marks' canonical form). Inserted as `@<value> ` by default. */
  | { kind: 'date'; value: string }
  /** `path` is vault-relative (`Projects/Plan.md`); `link` is what goes inside `[[ ]]` (bare name, or the path when the
   *  name is not unique). Inserted as `[[<link>]] ` by default. */
  | { kind: 'page'; path: string; link: string }
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
   *  typing, never during IME composition; Enter on a highlighted row picks it and does not submit.
   *  2026-11-02+: when the box sits in the lower half of the window the menu opens upward (falling back below if it doesn't fit).
   *  2026-11-02+: an array gives several triggers (e.g. `#` tags and `[[` links); the one nearest the caret wins.
   *  Older hosts take a single object only. Pass an array only when `ctx.ui.chatBoxCapabilities?.includes('suggestMany')`:
   *  `insertText` is not enough, 2.13.8-beta.3 has it but not arrays. */
  suggest?: PluginChatBoxSuggest | PluginChatBoxSuggest[]
  /** 2026-11-20+ (check `chatBoxCapabilities?.includes('mentions')`): turn on the host's `@` panel with these sources, in
   *  this order (dates first in notes). While this is set, a `suggest` entry whose trigger is `@` is ignored; `[[` / `#` are not
   *  affected. Older hosts ignore it. */
  mentions?: ChatBoxMentionKind[]
  /** A row was picked from the host's `@` panel. Return true to take it yourself (e.g. set a due date): the host then removes
   *  the typed `@query` and inserts nothing. Anything else (or an exception) inserts the default text. Synchronous. */
  onMention?(mention: ChatBoxMention): boolean | void
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

/** Chat Box behaviour a plugin can't feature-detect with `?.`, because hosts that lack it ignore the option instead of
 *  rejecting it. Exposed as `ctx.ui.chatBoxCapabilities` (2026-11-04+); a host without that field has none of these.
 *  `suggestMany`: `suggest` takes an array. `suggestAbove`: the menu opens upward in the lower half of the window.
 *  `mentions`: `mentions` / `onMention` (2026-11-20+). */
export const CHAT_BOX_CAPABILITIES = ['suggestMany', 'suggestAbove', 'mentions'] as const
export type ChatBoxCapability = (typeof CHAT_BOX_CAPABILITIES)[number]

export interface ChatBoxSuggestMatch {
  query: string
  /** Range of trigger + query in the text. */
  from: number
  to: number
}

const QUERY_CHAR = /^[\p{L}\p{N}_/-]/u

/** The trigger + query directly before the caret, or null. Same rule as the editor's `#` completion: the trigger starts a
 *  word, the query is non-empty, and the caret is not in the middle of a word. */
export function matchChatBoxSuggest(value: string, caret: number, trigger: string, mention = false): ChatBoxSuggestMatch | null {
  if (!trigger) return null
  const escaped = trigger.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
  // A mention opens on the bare trigger, and CJK text has no spaces to start a word with: only Latin letters and digits block it.
  const pattern = mention ? `(?:^|[^\\p{Script=Latin}\\p{N}_])${escaped}([\\p{L}\\p{N}_/-]*)$` : `(?:^|\\s)${escaped}([\\p{L}\\p{N}_/-]+)$`
  const m = new RegExp(pattern, 'u').exec(value.slice(0, caret))
  if (!m || QUERY_CHAR.test(value.slice(caret))) return null
  return { query: m[1], from: caret - m[1].length - trigger.length, to: caret }
}

/** The `@` mention before the caret, or null — the notes rule (amadeus wikiAutocomplete `mentionSuggestPlugin`): `@` may not
 *  follow an e-mail-ish character (`AT_BLOCKED_BEFORE`), the query stays on the line, has no whitespace or brackets and is at
 *  most 30 characters. Unlike `matchChatBoxSuggest` the query may hold `:` `/` `.` so `@11/28`, `@22:00` and `@remind:` work.
 *  `from` is the `@`. A caret in the middle of a word keeps it closed. */
export function matchChatBoxMention(value: string, caret: number): ChatBoxSuggestMatch | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1
  const before = value.slice(lineStart, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && AT_BLOCKED_BEFORE.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.length > 30 || /[\s[\]\ufffc]/u.test(query)) return null
  if (/^[\p{L}\p{N}_]/u.test(value.slice(caret))) return null
  return { query, from: lineStart + at, to: caret }
}
