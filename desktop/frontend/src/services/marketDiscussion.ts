export interface MarketComment {
  id: string; parentId: string | null; userId: string; username: string; content: string; deleted: boolean;
  isAuthor: boolean; pluginVersion: string | null; createdAt: string; updatedAt: string; replies?: MarketComment[]; repliesHasMore?: boolean
}
export interface MarketPreferences { enabled: boolean; mutedItemIds: string[] }
export const readMarketResource = <T,>(id: string, resource: string, offset = 0): Promise<T> => {
  if (window.tangu?.marketRead) return window.tangu.marketRead(id, resource, offset)
  return marketAccountRequest(`/market/items/${encodeURIComponent(id)}/${resource}?offset=${offset}`)
}
export async function marketAccountRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!window.tangu?.cloudFetch) throw Object.assign(new Error('Sign in to Forsion to continue'), { status: 401 })
  const result = await window.tangu.cloudFetch({ path, method, ...(body !== undefined ? { body } : {}) })
  if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(result.json?.detail || result.error || `HTTP ${result.status}`), { status: result.status })
  return result.json as T
}
export const marketPreferences = () => marketAccountRequest<MarketPreferences>('/market/notifications')
export const setMarketPreference = (enabled: boolean, itemId?: string) => marketAccountRequest<MarketPreferences>('/market/notifications', 'PUT', { enabled, ...(itemId ? { itemId } : {}) })
