/** Bundle-scoped JSON transport. Paths never escape the host-owned prefix. */
export interface PluginRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

type ChannelField = 'appId' | 'appSecret' | 'botToken'
/** The fragment of `GET /agent/channels` the host check needs. `owner` comes from the engine's plugin discovery. */
export interface ChannelOwnership {
  kind: string
  plugin?: { fields: Array<{ key: ChannelField }>; owner?: { engine: string; bundle: string | null } | null }
}

/** ctx.tangu.connectChannel's gate. The channel must be registered by an engine plugin inside this bundle (engine-side
 *  fact against the host's own bundle listing, nothing the plugin says about itself) and `fields` may only name
 *  credentials the channel declared. Returns the config patch; throws on refusal. */
export function ownedChannelPatch(channel: ChannelOwnership | undefined, fields: unknown, bundleDir: string, owned: readonly string[]): Partial<Record<ChannelField, string>> {
  const owner = channel?.plugin?.owner
  if (!owner?.bundle || owner.bundle.toLowerCase() !== bundleDir.toLowerCase() || !owned.includes(owner.engine)) throw new Error('This channel does not belong to this plugin')
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid channel fields')
  const declared = new Set(channel!.plugin!.fields.map((f) => f.key))
  const patch: Partial<Record<ChannelField, string>> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!declared.has(key as ChannelField) || typeof value !== 'string') throw new Error(`Invalid channel field: ${key}`)
    patch[key as ChannelField] = value
  }
  return patch
}

/** `bundleDir` = the bundle's install folder name (`plugins/<bundleDir>/`), which is what the engine mounts scoped
 *  routes under; it is not necessarily the plugin id. The engine matches that prefix case-insensitively, so a
 *  hand-installed `My-Plugin` is requested as `my-plugin` (that case worked when the route was built from the id). */
export function pluginRequestPath(bundleDir: string, engineId: string, path: string, owned: readonly string[]): string {
  const id = /^[a-z0-9][a-z0-9-]{0,63}$/
  const dir = bundleDir.toLowerCase()
  if (!id.test(dir)) throw new Error('Plugin install folder name cannot be used in a route (letters, digits and hyphens only)')
  if (!id.test(engineId) || !owned.includes(engineId)) throw new Error('Engine plugin is not owned by this bundle')
  // Encoded segments, queries and fragments are deliberately excluded. Use JSON bodies for filters.
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.includes('//')) throw new Error('Invalid plugin route')
  return `/extensions/${dir}/${engineId}${path}`
}
