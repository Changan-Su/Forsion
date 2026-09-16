/** File output needs a vault and an engine on the same real filesystem. */
export function pluginHostPath(root: string | null, path: string, host: { platform?: unknown; unitPage?: boolean; executionCapabilities?: { host: boolean } } | undefined): string | null {
  if (!root || !host || (host.executionCapabilities ? !host.executionCapabilities.host : !host.platform || host.unitPage)) return null
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(root) || /^[a-z]+:\/\//i.test(root)) return null
  if (typeof path !== 'string' || !path || /^[\\/]/.test(path) || /[:\0]/.test(path)) return null
  const parts = path.replace(/\\/g, '/').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return root.replace(/[\\/]+$/, '') + '/' + parts.join('/')
}
