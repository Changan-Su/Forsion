import { setContentStorageScope } from '@lcl/engine/contentStorageScope'
import { forsionAccountId } from '../../../shared/forsionAccount'

const OWNER_KEY = 'forsion.cloudCacheAccount'

// layoutPersist and singleColumnStore serialize tab titles, note paths, session IDs,
// and arbitrary view params. Named layouts also hold the inactive Space snapshots.
// Widths, UI mode, shortcuts, ribbon choices, and other geometry preferences use separate keys.
const isContentLayoutKey = (key: string): boolean =>
  !key.includes(':account:') && (
  key === 'tangu2_named_layouts' || /^tangu2_layout_(?:v[34]|detached_.+)$/.test(key) ||
  /^lcl_sc_(?:layout|named_layouts)_v1(?:_.+)?$/.test(key))

/** Cloud snapshots have no reliable legacy owner; clear them before hydrating another account. */
export function clearCloudAccountCache(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.includes(':account:')) continue // Keep owned snapshots for returning to that account.
      if (key === 'amadeus_tree_snap' || key === 'amadeus.cloudVaultId' ||
          key.startsWith('amadeus_last_page:') || key === 'forsion.deskBySession' ||
          key === 'forsion_tangu_unread_sessions' || isContentLayoutKey(key)) localStorage.removeItem(key)
    }
    localStorage.removeItem(OWNER_KEY)
  } catch { /* Private mode. The next page still starts with empty in-memory caches. */ }
}

export function cloudAccountIdentity(origin: string, token: string): string | null {
  // API requests preserve a configured path prefix. Two backends below one host
  // must therefore have distinct owners, just like the desktop account registry.
  return forsionAccountId(origin, token)
}

export function syncCloudAccountCache(origin: string, token: string): void {
  const owner = cloudAccountIdentity(origin, token)
  // The host calls this before dynamically importing its workspace. Only layout
  // content receives the scope; language/theme/width preferences keep their existing keys.
  setContentStorageScope(owner ?? `anonymous:${Date.now()}:${Math.random().toString(36).slice(2)}`)
  try {
    if (!owner || localStorage.getItem(OWNER_KEY) !== owner) clearCloudAccountCache()
    if (owner) localStorage.setItem(OWNER_KEY, owner)
  } catch { /* private mode */ }
}
