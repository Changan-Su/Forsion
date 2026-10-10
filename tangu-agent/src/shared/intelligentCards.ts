/** Client-advertised presentation catalog. Contains no user records or executable props. */
export type UIAppCardDescriptor = { id: string; description: string; acceptsQuery: boolean }
export const validAppCardId = (v: unknown): v is string => typeof v === 'string'
  && /^(?:native:[a-z][a-z0-9-]{0,63}|plugin:[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63})$/.test(v)
export function normalizeUIAppCards(raw: unknown): UIAppCardDescriptor[] {
  if (!Array.isArray(raw)) return []
  const result = new Map<string, UIAppCardDescriptor>()
  for (const x of raw.slice(0, 64)) {
    if (!x || !validAppCardId(x.id) || typeof x.description !== 'string' || !x.description.trim() || x.description.length > 400) continue
    result.set(x.id, { id: x.id, description: x.description.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ''), acceptsQuery: x.acceptsQuery === true })
  }
  return [...result.values()]
}
