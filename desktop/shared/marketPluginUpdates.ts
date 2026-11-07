export type MarketPluginType = 'plugin' | 'amadeus-plugin'
/** A package copy kept under ~/.forsion/.plugin-versions/<type>/<slug>/<version>/, most recently kept first. */
export interface KeptPluginVersion { version: string; compatible: boolean; keptAt?: number }
export interface MarketPluginUpdate {
  id: string
  name: string
  type: MarketPluginType
  slug: string
  /** Effective: not pinned and (the plugin's own choice, else the global switch). */
  autoUpdate: boolean
  /** The user's explicit per-plugin choice; undefined follows the global switch. */
  autoUpdateChoice?: boolean
  /** Set by a rollback or by installing an older store version; auto-update stays off until cleared. */
  pinnedVersion?: string
  phase: 'idle' | 'checking' | 'downloading' | 'staged' | 'current' | 'error'
  installedVersion?: string
  pendingVersion?: string
  /** The staged package is an older version (a rollback that could not swap while files were in use). */
  pendingRollback?: boolean
  keptVersions?: KeptPluginVersion[]
  error?: string
}
/** A plugin folder that is not a marketplace install (copied in by hand). Old versions are kept, never updated. */
export interface LocalPluginVersions { type: MarketPluginType; slug: string; id: string; version: string; keptVersions: KeptPluginVersion[]; pendingVersion?: string }
export interface MarketPluginUpdates { checking: boolean; autoUpdateAll: boolean; items: MarketPluginUpdate[]; local: LocalPluginVersions[] }
export interface PluginRollbackResult { ok: true; type: MarketPluginType; slug: string; version: string; deferred?: boolean }

/** Unknown/malformed versions never authorize an unattended replacement. */
export function compareMarketVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const parse = (v: string | null | undefined) => /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v?.trim() || '')
  const x = parse(a), y = parse(b)
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i] || 0) - Number(y[i] || 0)
    if (d) return Math.sign(d)
  }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1
  const px = x[4].split('.'), py = y[4].split('.')
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined || py[i] === undefined) return px[i] === py[i] ? 0 : px[i] === undefined ? -1 : 1
    if (px[i] === py[i]) continue
    const nx = /^\d+$/.test(px[i]), ny = /^\d+$/.test(py[i])
    if (nx && ny) return Math.sign(Number(px[i]) - Number(py[i]))
    if (nx !== ny) return nx ? -1 : 1
    return px[i] < py[i] ? -1 : 1
  }
  return 0
}
