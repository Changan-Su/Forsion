/** Which Spaces a host's Space bar holds when it has room for only a few (the Android dock: five cells).
 *
 *  Everything while it fits; past that, the first Space (Home, by position — the same rule the bar itself uses) plus
 *  the ones the user chose, and the bar's last cell is "all". Nobody chose yet = the first ones in list order.
 *  The choice is this device's (localStorage): a phone's dock is not something a desktop has an opinion about.
 *  ponytail: ids only, no order of their own — the bar shows them in list order. Add ordering when someone asks to
 *  rearrange the dock itself. */
export const DOCK_CELLS = 5
/** Cells left for the user's own picks: the dock minus Home and minus "all". */
export const DOCK_PICKS = DOCK_CELLS - 2
const KEY = 'lcl_dock_pins_v1'
const subscribers = new Set<() => void>()

/** The stored picks (Space ids, Home not among them); null = the user never chose. */
export function dockPicks(): string[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null
  } catch { return null }
}

/** Ids of the Spaces that stand in the bar, for the Spaces that exist right now (`ids` in list order). */
export function dockSpaceIds(ids: readonly string[], picks: readonly string[] | null = dockPicks()): Set<string> {
  if (ids.length <= DOCK_CELLS) return new Set(ids)
  const rest = ids.slice(1)
  // A pick whose Space is gone (a plugin was removed) frees its cell; it is not handed to another Space behind the
  // user's back — the dock then simply has one cell fewer until they pick again.
  const chosen = picks ? rest.filter((id) => picks.includes(id)) : rest
  return new Set([ids[0], ...chosen.slice(0, DOCK_PICKS)])
}

/** Store which Spaces stand in the bar (what the picks sheet answered; Home and unknown ids drop out, the first
 *  DOCK_PICKS in list order count). The same set as now stores nothing: a dock never chosen stays never chosen. */
export function setDockPicks(ids: readonly string[], picks: readonly string[]): void {
  const shown = dockSpaceIds(ids)
  const next = ids.slice(1).filter((x) => picks.includes(x)).slice(0, DOCK_PICKS)
  if (next.length === shown.size - 1 && next.every((x) => shown.has(x))) return
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { return }
  subscribers.forEach((fn) => fn())
}

export function subscribeDockPicks(fn: () => void): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}
