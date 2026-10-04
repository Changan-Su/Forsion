/** Host-owned classification. Third-party manifests cannot promote themselves to core plugins. */
export const CORE_BUNDLE_IDS: readonly string[] = ['forsion-extend', 'tangu-computer-use']

export function isCorePlugin(plugin: { id: string; builtin?: boolean; preinstalled?: boolean }): boolean {
  return !!(plugin.builtin || plugin.preinstalled) && CORE_BUNDLE_IDS.includes(plugin.id)
}

export interface CorePluginUpdate {
  id: string
  packageName: string
  phase: 'idle' | 'checking' | 'downloading' | 'current' | 'staged' | 'incompatible' | 'error' | 'development'
  installedVersion?: string
  latestVersion?: string
  pendingVersion?: string
  error?: string
}

export interface CorePluginUpdates {
  checking: boolean
  items: CorePluginUpdate[]
}
