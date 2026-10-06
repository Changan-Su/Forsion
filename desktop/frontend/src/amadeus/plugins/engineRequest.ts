/** Bundle-scoped JSON transport. Paths never escape the host-owned prefix. */
export interface PluginRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

export function pluginRequestPath(bundleId: string, engineId: string, path: string, owned: readonly string[]): string {
  const id = /^[a-z0-9][a-z0-9-]{0,63}$/
  if (!id.test(bundleId) || !id.test(engineId) || !owned.includes(engineId)) throw new Error('Engine plugin is not owned by this bundle')
  // Encoded segments, queries and fragments are deliberately excluded. Use JSON bodies for filters.
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.includes('//')) throw new Error('Invalid plugin route')
  return `/extensions/${bundleId}/${engineId}${path}`
}
