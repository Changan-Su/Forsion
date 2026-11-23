/** Public marketplace objects. UI and model responses carry IDs, never executable markup. */
export interface MarketplaceRequirements {
  minAppVersion?: string | null;
  maxAppVersion?: string | null;
  platforms?: string[];
}
/** Where a store entry comes from. Absent (older servers) = a Forsion entry from a developer. */
export type MarketplaceOrigin =
  | { kind: 'forsion'; publisher: 'official' | 'developer' }
  /** `collected` = Forsion collected it from an outside catalog (skills.sh); not manually reviewed. */
  | { kind: 'collected' | 'source'; sourceId: string; sourceTitle: string };
/** What an entry needs on the user's machine (not to be confused with the version/platform `MarketplaceRequirements`). */
export interface MarketplaceItemNeeds {
  cli: boolean; apiKeys: string[]; desktopOnly: boolean; scripts: number;
  /** An outside security audit rated it medium; installing asks the user to confirm. */
  auditWarn: boolean;
}
export interface MarketplaceItem extends MarketplaceRequirements {
  id: string; name: string; type: string; source: string; author: string;
  summary: string; description?: string; tags: string[]; installSlug: string;
  latestVersion: string | null; iconUrl?: string | null; downloads?: number;
  readme?: string; origin?: MarketplaceOrigin; requirements?: MarketplaceItemNeeds;
}
/** Built-in skills.sh source: sha256("builtin:skills.sh").slice(0, 8). Card IDs are `src_<id>_<itemId>`. */
export const COLLECTED_SKILLS_SOURCE_ID = '25aae625';
const printable = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};
/** Drops a malformed block, never the entry it belongs to. */
export function marketplaceOriginOf(value: unknown): MarketplaceOrigin | undefined {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  if (o.kind === 'forsion') return { kind: 'forsion', publisher: o.publisher === 'official' ? 'official' : 'developer' };
  if (o.kind !== 'collected' && o.kind !== 'source') return undefined;
  const sourceTitle = printable(o.sourceTitle, 80);
  if (typeof o.sourceId !== 'string' || !/^[0-9a-f]{8}$/.test(o.sourceId) || !sourceTitle) return undefined;
  return { kind: o.kind, sourceId: o.sourceId, sourceTitle };
}
export function marketplaceNeedsOf(value: unknown): MarketplaceItemNeeds | undefined {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  if (['cli', 'desktopOnly', 'auditWarn'].some(k => r[k] !== undefined && typeof r[k] !== 'boolean')) return undefined;
  if (r.apiKeys !== undefined && !Array.isArray(r.apiKeys)) return undefined;
  if (r.scripts !== undefined && !(Number.isInteger(r.scripts) && (r.scripts as number) >= 0)) return undefined;
  const apiKeys = ((r.apiKeys as unknown[]) || []).filter((k): k is string => typeof k === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)).slice(0, 8);
  return { cli: r.cli === true, apiKeys, desktopOnly: r.desktopOnly === true, scripts: Math.min(Number(r.scripts) || 0, 100000), auditWarn: r.auditWarn === true };
}
/** Older servers send no origin: treat those entries as Forsion's. */
export const isForsionMarketplaceItem = (item: { origin?: MarketplaceOrigin }): boolean => !item.origin || item.origin.kind === 'forsion';
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
const extrasOf = (i: any): Pick<MarketplaceItem, 'origin' | 'requirements'> => {
  const origin = marketplaceOriginOf(i.origin), requirements = marketplaceNeedsOf(i.requirements);
  return { ...(origin ? { origin } : {}), ...(requirements ? { requirements } : {}) };
};
export function marketplaceItemsOf(result: unknown): MarketplaceItem[] {
  try {
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    if (!data || !(data.kind === 'marketplace' || data.kind === 'marketplace_lookup') || data.version !== 1 || !Array.isArray(data.items)) return [];
    return data.items.filter((i: any) => marketplaceId(i?.id) && typeof i.name === 'string' && typeof i.type === 'string' && typeof i.installSlug === 'string').slice(0, 12)
      .map((i: any) => ({ id: i.id, name: i.name.slice(0, 255), type: i.type.slice(0, 32), source: String(i.source || 'zip').slice(0, 16), installSlug: i.installSlug.slice(0, 64), latestVersion: typeof i.latestVersion === 'string' ? i.latestVersion.slice(0, 64) : null, description: typeof i.description === 'string' ? i.description.slice(0, 1500) : '', ...(typeof i.readme === 'string' && data.items.length === 1 ? { readme: i.readme.slice(0, 8000) } : {}), summary: String(i.summary || '').slice(0, 600), author: String(i.author || '').slice(0, 100), tags: Array.isArray(i.tags) ? i.tags.filter((t: unknown) => typeof t === 'string').slice(0, 8).map((t: string) => t.slice(0, 40)) : [], platforms: Array.isArray(i.platforms) ? i.platforms.filter((p: unknown) => typeof p === 'string').slice(0, 7).map((p: string) => p.slice(0, 20)) : [], minAppVersion: typeof i.minAppVersion === 'string' ? i.minAppVersion.slice(0, 64) : null, maxAppVersion: typeof i.maxAppVersion === 'string' ? i.maxAppVersion.slice(0, 64) : null, ...extrasOf(i) }));
  } catch { return []; }
}

export const MARKETPLACE_CARDS_CAPABILITY = 'marketplace-cards.v2';
export const MARKETPLACE_RECOMMENDATION_TOOL = 'recommend_marketplace_plugin';
export const hasMarketplaceCards = (results: Array<{ name?: string; content?: unknown; isError?: boolean }>) => results.some(r => r.name === MARKETPLACE_RECOMMENDATION_TOOL && !r.isError && marketplaceItemsOf(r.content).length > 0);
