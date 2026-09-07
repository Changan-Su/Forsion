/** Cross-window Mini targets are data only; view availability is checked by the renderer. */
export interface MiniOpenOptions { sessionId?: string; spaceId?: string; params?: Record<string, unknown> }
export interface MainPanelTarget { spaceId?: string; type: string; params?: Record<string, unknown> }
export function normalizeMiniOpenOptions(raw: unknown): MiniOpenOptions | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId.trim().slice(0, 256) || undefined : undefined
  const spaceId = typeof r.spaceId === 'string' ? r.spaceId.trim().slice(0, 128) || undefined : undefined
  const params = r.params && typeof r.params === 'object' && !Array.isArray(r.params) ? r.params as Record<string, unknown> : undefined
  return sessionId || spaceId ? { sessionId, spaceId, params } : undefined
}
