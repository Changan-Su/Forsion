/** Plugin formats may claim dedicated suffixes, never all ordinary notes or text. */
export function isSafePluginExt(extension: unknown): extension is string {
  if (typeof extension !== 'string') return false
  const value = extension.trim().toLowerCase()
  if (!value.startsWith('.') || value.length < 2 || value.length > 40) return false
  if (value === '.md' || value === '.markdown' || value === '.txt') return false
  return value.endsWith('.md')
    ? /^\.[a-z0-9][a-z0-9-]*\.md$/.test(value)
    : /^\.[a-z0-9][a-z0-9.-]*$/.test(value)
}
