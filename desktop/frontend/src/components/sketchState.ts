/** Local presentation state only: never sent to the model or exposed to another card. */
export const SKETCH_STATE_LIMIT = 16_384
const STORAGE_KEY = 'forsion_sketch_state_v1'
const MAX_ENTRIES = 48
type Entry = { key: string; state: unknown }

export function serializeSketchState(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value)
    return json && new TextEncoder().encode(json).length <= SKETCH_STATE_LIMIT ? json : undefined
  } catch { return undefined }
}

/** Include source identity so a regenerated card never inherits an incompatible snapshot. */
export function sketchStateKey(scope: string, callId: string, html: string): string {
  let hash = 2166136261
  for (let i = 0; i < html.length; i++) hash = Math.imul(hash ^ html.charCodeAt(i), 16777619)
  return JSON.stringify([scope, callId, html.length, hash >>> 0])
}

function entries(storage: Storage): Entry[] {
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw || raw.length > SKETCH_STATE_LIMIT * (MAX_ENTRIES + 4)) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  return Array.isArray(parsed) ? parsed.filter((e): e is Entry =>
    !!e && typeof e.key === 'string' && e.key.length < 2048 && serializeSketchState(e.state) !== undefined,
  ).slice(-MAX_ENTRIES) : []
}

export function readSketchState(key: string): unknown {
  try { return entries(localStorage).find((e) => e.key === key)?.state ?? null } catch { return null }
}

export function saveSketchState(key: string, value: unknown): void {
  const json = serializeSketchState(value)
  if (!json || key.length >= 2048) return
  try {
    const next = entries(localStorage).filter((e) => e.key !== key)
    next.push({ key, state: JSON.parse(json) })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(-MAX_ENTRIES)))
  } catch { /* Private mode, corrupt storage and quota errors must not break the visualization. */ }
}
