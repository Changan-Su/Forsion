/** Navigation params are JSON data (the same contract as saved View layouts).
 * Preserve nested object identity and all restore parameters; strip host-owned metadata. */
export function navigationParams(params: Record<string, unknown>): Record<string, unknown> {
  const user = Object.fromEntries(Object.entries(params).filter(([key]) => !key.startsWith('__')))
  try { return JSON.parse(JSON.stringify(user)) as Record<string, unknown> } catch { return { ...user } }
}
export function navigationSig(params: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)]))
    return value
  }
  try { return JSON.stringify(stable(navigationParams(params))) } catch { return '' }
}
