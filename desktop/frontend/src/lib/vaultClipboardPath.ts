/** A cloud vault has no local absolute path. Keep separators native for Windows roots. */
export function vaultClipboardPath(root: string | null | undefined, relative: string): string | null {
  if (!root || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(root)) return null
  if (!relative || /^[\\/]/.test(relative) || /[\0:]/.test(relative)) return null
  const parts = relative.replace(/\\/g, '/').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + parts.join(sep)
}
