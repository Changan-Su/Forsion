/** Manifest `requires`: the array form, or `{ plugins?, entitlement? }`. Unit and the desktop / mobile plugin mapping
 *  both read it here. `plugins` keeps its Unit meaning (a list of Unit package ids, same as the array form): desktop and
 *  mobile ignore it and use `requiresPlugins`, because Unit ids such as `tangu` are not plugins there and would read as
 *  a missing prerequisite. */
const ENTITLEMENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** null = a shape this host does not understand. Validating the `plugins` entries is left to Unit, the only reader.
 *  A malformed `entitlement` reads as none: it is informational, and Unit fails its whole load on null. */
export function parseManifestRequires(raw: unknown): { plugins: unknown[]; entitlement?: string } | null {
  if (raw === undefined || raw === null) return { plugins: [] }
  if (Array.isArray(raw)) return { plugins: raw }
  if (typeof raw !== 'object') return null
  const { plugins, entitlement } = raw as { plugins?: unknown; entitlement?: unknown }
  if (plugins !== undefined && !Array.isArray(plugins)) return null
  return { plugins: plugins ?? [], ...(typeof entitlement === 'string' && ENTITLEMENT_NAME.test(entitlement) ? { entitlement } : {}) }
}
