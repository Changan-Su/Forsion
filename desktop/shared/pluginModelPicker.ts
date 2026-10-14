/** A local selection draft. Empty means follow the host slot; `local` means on-device ASR. */
export type PluginModelKind = 'asr' | 'translation'
export interface PluginModelInfo {
  id: string
  name: string
  provider: string
  source: 'forsion' | 'direct' | 'local'
  available: boolean
  /** Machine translation models cannot follow a custom correction prompt. */
  supportsCorrection: boolean
}
export interface PluginModelCatalog { models: PluginModelInfo[]; defaultModelId: string }
export interface PluginModelPickerOptions {
  kind: PluginModelKind
  value: string
  label: string
  followLabel: string
  scopeKey?: string
  disabled?: boolean
  onChange(value: string): void
}
export interface PluginModelPickerHandle { update(patch: Partial<PluginModelPickerOptions>): void; dispose(): void }
