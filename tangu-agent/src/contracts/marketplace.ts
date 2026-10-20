/** Public marketplace objects. UI and model responses carry IDs, never executable markup. */
export interface MarketplaceRequirements {
  minAppVersion?: string | null;
  maxAppVersion?: string | null;
  platforms?: string[];
}
export interface MarketplaceItem extends MarketplaceRequirements {
  id: string; name: string; type: string; source: string; author: string;
  summary: string; description?: string; tags: string[]; installSlug: string;
  latestVersion: string | null; iconUrl?: string | null; downloads?: number;
  readme?: string;
}
const VERSION = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export function compareAppVersions(a: string, b: string): number | null {
  const valid = (value: string) => {
    if (typeof value !== 'string' || value.length > 64) return null;
    const parsed = VERSION.exec(value.trim());
    if (!parsed) return null;
    if (parsed[4]?.split('.').some(p => !p || (/^\d+$/.test(p) && p.length > 1 && p.startsWith('0')))) return null;
    if (value.includes('+') && value.split('+')[1].split('.').some(p => !p)) return null;
    return parsed;
  };
  const x = valid(a), y = valid(b);
  if (!x || !y) return null;
  for (let n = 1; n <= 3; n++) { const xa = BigInt(x[n]), ya = BigInt(y[n]); if (xa !== ya) return xa < ya ? -1 : 1; }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const xp = x[4].split('.'), yp = y[4].split('.');
  for (let n = 0; n < Math.max(xp.length, yp.length); n++) {
    if (xp[n] === yp[n]) continue;
    if (xp[n] === undefined || yp[n] === undefined) return xp[n] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(xp[n]), yn = /^\d+$/.test(yp[n]);
    if (xn && yn) { const xa = BigInt(xp[n]), ya = BigInt(yp[n]); return xa === ya ? 0 : xa < ya ? -1 : 1; }
    if (xn !== yn) return xn ? -1 : 1;
    return xp[n] < yp[n] ? -1 : 1;
  }
  return 0;
}
export type MarketplaceCompatibility = 'compatible' | 'unknown' | 'version' | 'platform';
export function marketplaceCompatibility(item: MarketplaceRequirements & { tags?: string[] }, version: string, platform: string): MarketplaceCompatibility {
  const platforms = item.platforms || [];
  const desktop = ['desktop', 'macos', 'windows', 'linux'].includes(platform);
  if (item.tags?.includes('desktop-only') && !desktop) return 'platform';
  if (platforms.length && !platforms.includes(platform) && !(desktop && platforms.includes('desktop'))) return 'platform';
  const min = item.minAppVersion ? compareAppVersions(version, item.minAppVersion) : null;
  const max = item.maxAppVersion ? compareAppVersions(version, item.maxAppVersion) : null;
  if ((min !== null && min < 0) || (max !== null && max >= 0)) return 'version';
  if ((!item.minAppVersion && !item.maxAppVersion) || (item.minAppVersion && min === null) || (item.maxAppVersion && max === null)) return 'unknown';
  return 'compatible';
}
export const marketplaceId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export function assertMarketplaceRequirements(item: MarketplaceRequirements & { tags?: string[]; isDesktopOnly?: boolean }, version: string, platform: string): void {
  if (item.platforms !== undefined && (!Array.isArray(item.platforms) || item.platforms.some(p => !['desktop', 'macos', 'windows', 'linux', 'android', 'ios', 'web'].includes(p)))) throw new Error('install: invalid supported platforms');
  if ((item.minAppVersion != null && (typeof item.minAppVersion !== 'string' || !!item.minAppVersion && compareAppVersions(item.minAppVersion, item.minAppVersion) === null)) ||
      (item.maxAppVersion != null && (typeof item.maxAppVersion !== 'string' || !!item.maxAppVersion && compareAppVersions(item.maxAppVersion, item.maxAppVersion) === null))) throw new Error('install: invalid Forsion version requirements');
  const state = marketplaceCompatibility({ ...item, tags: item.isDesktopOnly ? [...(item.tags || []), 'desktop-only'] : item.tags }, version, platform);
  if (state === 'version') throw new Error(`install: requires Forsion ${item.minAppVersion || '0.0.0'}${item.maxAppVersion ? ` to < ${item.maxAppVersion}` : '+'}`);
  if (state === 'platform') throw new Error('install: unsupported platform');
}
export function marketplaceItemsOf(result: unknown): MarketplaceItem[] {
  try {
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    if (!data || data.kind !== 'marketplace' || data.version !== 1 || !Array.isArray(data.items)) return [];
    return data.items.filter((i: any) => marketplaceId(i?.id) && typeof i.name === 'string' && typeof i.type === 'string' && typeof i.installSlug === 'string').slice(0, 12)
      .map((i: any) => ({ id: i.id, name: i.name.slice(0, 255), type: i.type.slice(0, 32), source: String(i.source || 'zip').slice(0, 16), installSlug: i.installSlug.slice(0, 64), latestVersion: typeof i.latestVersion === 'string' ? i.latestVersion.slice(0, 64) : null, description: typeof i.description === 'string' ? i.description.slice(0, 1500) : '', ...(typeof i.readme === 'string' && data.items.length === 1 ? { readme: i.readme.slice(0, 8000) } : {}), summary: String(i.summary || '').slice(0, 600), author: String(i.author || '').slice(0, 100), tags: Array.isArray(i.tags) ? i.tags.filter((t: unknown) => typeof t === 'string').slice(0, 8).map((t: string) => t.slice(0, 40)) : [], platforms: Array.isArray(i.platforms) ? i.platforms.filter((p: unknown) => typeof p === 'string').slice(0, 7).map((p: string) => p.slice(0, 20)) : [], minAppVersion: typeof i.minAppVersion === 'string' ? i.minAppVersion.slice(0, 64) : null, maxAppVersion: typeof i.maxAppVersion === 'string' ? i.maxAppVersion.slice(0, 64) : null }));
  } catch { return []; }
}

export const MARKETPLACE_CARDS_CAPABILITY = 'marketplace-cards.v1';
export const hasMarketplaceCards = (results: Array<{ name?: string; content?: unknown; isError?: boolean }>) => results.some(r => ['search_marketplace', 'get_marketplace_plugin'].includes(r.name || '') && !r.isError && marketplaceItemsOf(r.content).length > 0);
