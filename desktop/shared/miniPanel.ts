/** Cross-window Mini targets are data only; view availability is checked by the renderer. */
export interface MiniViewTarget { type: string; params?: Record<string, unknown> }
export interface MiniOpenOptions {
  sessionId?: string
  spaceId?: string
  params?: Record<string, unknown>
  /** Direct compact view target, primarily for plugins that do not own an entire Space. */
  view?: MiniViewTarget
  /** Destination used by the Mini "show in main panel" action. Defaults to view. */
  mainView?: MiniViewTarget
  title?: string
  /** Identity within the same Space / view (2.13.8+): different keys open different Mini windows,
   *  the same key focuses the window that is already open. Absent = one window per Space / view. */
  key?: string
  /** "Duplicate window": open another window for this target even when one is already open. */
  duplicate?: boolean
}
/** What `window.tangu.openMini` resolves to (2.13.8+; older hosts resolve nothing). */
export type MiniOpenResult =
  | { ok: true; reused: boolean }
  | { ok: false; reason: 'limit'; limit: number }
/** How many ordinary Mini windows may be open at once. Hidden ones count (each keeps its renderer process);
 *  the voice-call window is outside the cap. Measured: see check:minimulti (memory per Mini) before raising. */
export const MINI_WINDOW_LIMIT = 6
/** The voice call has its own window, one at a time; another call reuses it. */
export const VOICE_CALL_VIEW = 'voice-call'
export interface MainPanelTarget { spaceId?: string; type: string; params?: Record<string, unknown> }
export function normalizeMiniOpenOptions(raw: unknown): MiniOpenOptions | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId.trim().slice(0, 256) || undefined : undefined
  const spaceId = typeof r.spaceId === 'string' ? r.spaceId.trim().slice(0, 128) || undefined : undefined
  const params = r.params && typeof r.params === 'object' && !Array.isArray(r.params) ? r.params as Record<string, unknown> : undefined
  const target = (rawTarget: unknown): MiniViewTarget | undefined => {
    if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) return undefined
    const value = rawTarget as Record<string, unknown>
    const type = typeof value.type === 'string' ? value.type.trim().slice(0, 256) : ''
    if (!type) return undefined
    return { type, params: value.params && typeof value.params === 'object' && !Array.isArray(value.params) ? value.params as Record<string, unknown> : undefined }
  }
  const view = target(r.view)
  const mainView = target(r.mainView)
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 128) || undefined : undefined
  const key = typeof r.key === 'string' ? r.key.trim().slice(0, 256) || undefined : undefined
  const duplicate = r.duplicate === true || undefined
  return sessionId || spaceId || view ? { sessionId, spaceId, params, view, mainView, title, key, duplicate } : undefined
}

/** Which Mini window a target belongs to: Space + view + identity. The same key reopens = focus that window.
 *  Identity is deliberately narrow so old callers keep reusing one window: a chat session (`sessionId`,
 *  top-level or in the Tangu Space's params) and an explicit `key`. Other params only retarget the window.
 *  No target (hotkey / tray) = 'default'; the voice call is one window whatever its params. */
export function miniEntityKey(target: MiniOpenOptions | undefined): string {
  if (!target) return 'default'
  const key = target.key ? `#key:${target.key}` : ''
  if (target.view) return target.view.type === VOICE_CALL_VIEW ? VOICE_CALL_VIEW : `view:${target.view.type}${key}`
  const space = target.spaceId || (target.sessionId ? 'tangu' : '')
  if (!space) return `default${key}`
  const fromParams = space === 'tangu' && typeof target.params?.sessionId === 'string' ? target.params.sessionId.trim() : ''
  const session = target.sessionId || fromParams
  return `space:${space}${session ? `#session:${session}` : ''}${key}`
}

/** Reported only by the main renderer; no message text or credentials cross this IPC. */
export interface MiniSessionContext { sessionId: string | null; runId: string | null }
export function normalizeMiniSessionContext(raw: unknown): MiniSessionContext {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const id = (v: unknown): string | null => typeof v === 'string' && v.trim() && v.length <= 256 ? v.trim() : null
  const sessionId = id(value.sessionId)
  return { sessionId, runId: sessionId ? id(value.runId) : null }
}
