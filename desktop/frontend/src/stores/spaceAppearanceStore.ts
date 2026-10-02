import { create } from 'zustand'
import { normalizeSpaceAppearance, normalizeSpaceAppearanceUpdate, SPACE_APPEARANCE_PREFIX, type SpaceAppearance, type SpaceAppearanceUpdate } from '../../../shared/spaceAppearance'

function readAll(): Record<string, SpaceAppearance> {
  const out: Record<string, SpaceAppearance> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(SPACE_APPEARANCE_PREFIX)) continue
      try { out[key.slice(SPACE_APPEARANCE_PREFIX.length)] = normalizeSpaceAppearance(JSON.parse(localStorage.getItem(key) || '{}')) } catch { /* ignore one corrupt entry */ }
    }
  } catch { /* no storage */ }
  return out
}

export const useSpaceAppearance = create<{ byId: Record<string, SpaceAppearance> }>(() => ({ byId: readAll() }))

/** Persist one Space only; a concurrent edit to another Space cannot be overwritten. */
export function receiveSpaceAppearance(raw: SpaceAppearanceUpdate, persist = true): boolean {
  const update = normalizeSpaceAppearanceUpdate(raw)
  if (!update) return false
  const { id, appearance } = update
  if (persist) {
    try {
      const key = SPACE_APPEARANCE_PREFIX + id
      if (Object.keys(appearance).length) localStorage.setItem(key, JSON.stringify(appearance))
      else localStorage.removeItem(key)
    } catch { return false }
  }
  useSpaceAppearance.setState((s) => ({ byId: { ...s.byId, [id]: appearance } }))
  return true
}

export function setSpaceAppearance(id: string, appearance: SpaceAppearance): boolean {
  const update = normalizeSpaceAppearanceUpdate({ id, appearance })
  if (!update || !receiveSpaceAppearance(update)) return false
  try { window.tangu?.broadcastUi?.({ spaceAppearance: update }) } catch { /* browser */ }
  return true
}

// Browser tabs and Electron windows share storage; IPC carries the exact value when
// Chromium's storage propagation arrives after the settings window's notification.
if (typeof window !== 'undefined') window.addEventListener?.('storage', (event) => {
  if (event.key === null) { useSpaceAppearance.setState({ byId: readAll() }); return }
  if (!event.key.startsWith(SPACE_APPEARANCE_PREFIX)) return
  try { receiveSpaceAppearance({ id: event.key.slice(SPACE_APPEARANCE_PREFIX.length), appearance: JSON.parse(event.newValue || '{}') }, false) } catch { /* corrupt entry */ }
})
