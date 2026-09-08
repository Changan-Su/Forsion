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

/** Reported only by the main renderer; no message text or credentials cross this IPC. */
export interface MiniSessionContext { sessionId: string | null; runId: string | null }
export function normalizeMiniSessionContext(raw: unknown): MiniSessionContext {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const id = (v: unknown): string | null => typeof v === 'string' && v.trim() && v.length <= 256 ? v.trim() : null
  const sessionId = id(value.sessionId)
  return { sessionId, runId: sessionId ? id(value.runId) : null }
}
