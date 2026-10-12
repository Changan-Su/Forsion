/** Host-native Amadeus Markdown editor for API-backed documents. No vault or implicit active page. */
export interface PluginMarkdownEditorOptions {
  value: string
  label?: string
  readOnly?: boolean
  /** Origin for public relative images/videos when mounted in a desktop or cross-origin admin host. */
  previewBaseUrl?: string
  /** Default true: a row of three buttons switches between the visual editor, Markdown source and the published preview.
   *  `false` draws no row and keeps the visual editor only — for an editor that sits inside the caller's own card or cell.
   *  Hosts up to 2.13.2 ignore the field and always draw the row. */
  modes?: boolean
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
