/** Host-native Amadeus Markdown editor for API-backed documents. No vault or implicit active page. */
export interface PluginMarkdownEditorOptions {
  value: string
  label?: string
  readOnly?: boolean
  /** Origin for public relative images/videos when mounted in a desktop or cross-origin admin host. */
  previewBaseUrl?: string
  onChange?(markdown: string): void
}
export interface PluginMarkdownEditorHandle {
  /** Synchronous, including the latest native editor transaction. */
  getValue(): string
  update(patch: Partial<PluginMarkdownEditorOptions>): void
  insertMarkdown(markdown: string): void
  focus(): void
  /** Idempotent. Afterwards the element is the plugin's again at once: clear it, or mount on it again. */
  dispose(): void
}
