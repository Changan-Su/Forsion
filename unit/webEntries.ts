/** Extra public surfaces share the Unit backend but publish an explicit subset of its packages. */
export interface WebEntry {
  basePath: string
  plugins: string[]
  defaultSpace?: string
  inheritWebAccount?: boolean
  /** Origins of other entries of this operator (another Unit, another domain) that may ask this entry for its
   *  visitor's login. They get a one-time handoff code, never the token. Exact origins only, no wildcards. */
  handoffTargets?: string[]
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    // Plain host names only: URL parsing accepts characters such as '*' that read like a wildcard.
    const host = LOOPBACK.has(url.hostname) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname)
    return host && url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
  } catch { return false }
}

export function validateWebEntries(entries: WebEntry[] | undefined, primary: string, local: boolean,
  packages: Map<string, { requires?: string[]; spaces: Set<string> }>): WebEntry[] {
  if (entries === undefined) return []
  if (!Array.isArray(entries) || local) throw new Error('Web entries require a public Unit')
  const prefixes = [primary]
  for (const entry of entries) {
    if (!entry || typeof entry.basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(entry.basePath) ||
      ['/api/', '/auth/', '/account/', '/pay/', '/shared/', '/oauth/', '/unit/', '/vault/', '/engine/'].some((p) => entry.basePath.startsWith(p)) ||
      prefixes.some((p) => p.startsWith(entry.basePath) || entry.basePath.startsWith(p))) throw new Error('Web entry paths must be distinct and outside reserved routes')
    prefixes.push(entry.basePath)
    if (!Array.isArray(entry.plugins) || !entry.plugins.length || new Set(entry.plugins).size !== entry.plugins.length) throw new Error('Web entry requires distinct installed plugins')
    for (const id of entry.plugins) {
      const pack = packages.get(id)
      if (!pack) throw new Error(`Web entry plugin is not installed: ${id}`)
      if (pack.requires?.some((dep) => !entry.plugins.includes(dep))) throw new Error(`Web entry omits a dependency of ${id}`)
    }
    if (entry.defaultSpace && !entry.plugins.some((id) => packages.get(id)!.spaces.has(entry.defaultSpace!))) throw new Error('Web entry default Space must be published')
    if (entry.handoffTargets !== undefined && (!Array.isArray(entry.handoffTargets) || !entry.handoffTargets.every(validOrigin))) {
      throw new Error('Web entry handoff targets must be exact https origins')
    }
  }
  return entries
}
