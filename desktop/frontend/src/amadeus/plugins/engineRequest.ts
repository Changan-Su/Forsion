/** Bundle-scoped JSON transport. Paths never escape the host-owned prefix. */
export interface PluginRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/** `bundleDir` = the bundle's install folder name (`plugins/<bundleDir>/`), which is what the engine mounts scoped
 *  routes under; it is not necessarily the plugin id. */
export function pluginRequestPath(bundleDir: string, engineId: string, path: string, owned: readonly string[]): string {
  const id = /^[a-z0-9][a-z0-9-]{0,63}$/
  if (!id.test(bundleDir)) throw new Error('Plugin install folder name cannot be used in a route (lowercase letters, digits and hyphens only)')
  if (!id.test(engineId) || !owned.includes(engineId)) throw new Error('Engine plugin is not owned by this bundle')
  // Encoded segments, queries and fragments are deliberately excluded. Use JSON bodies for filters.
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.includes('//')) throw new Error('Invalid plugin route')
  return `/extensions/${bundleDir}/${engineId}${path}`
}
