/** DOM plugin contract. No React, store, credentials, or implicit active-session access. */
export interface ChatBoxSelection {
  modelId: string
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}
export interface ChatBoxSubmission extends ChatBoxSelection { text: string }
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
  onChange?(draft: ChatBoxSubmission): void
  /** true clears the submitted text; false/rejection keeps it for retry. No automatic AI run. */
  onSubmit(draft: ChatBoxSubmission): boolean | Promise<boolean>
}
export interface PluginChatBoxHandle {
  update(patch: Partial<PluginChatBoxOptions>): void
  focus(): void
  /** Idempotent. Afterwards the element is the plugin's again at once: clear it, or mount on it again. */
  dispose(): void
}
