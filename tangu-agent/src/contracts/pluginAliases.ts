/** Exact runtime identities win. A legacy package ID is an alias only while it is unambiguous. */
export function pluginDependencyIndex<T extends { id: string; packageId?: string }>(nodes: readonly T[]): Map<string, T> {
  const index = new Map(nodes.map(node => [node.id, node]));
  const aliases = new Map<string, T[]>();
  for (const node of nodes) if (node.packageId && node.packageId !== node.id) aliases.set(node.packageId, [...(aliases.get(node.packageId) || []), node]);
  for (const [alias, values] of aliases) if (!index.has(alias) && values.length === 1) index.set(alias, values[0]);
  return index;
}

/** A store install's directory. The directory name is that install's runtime identity. */
export const MARKET_INSTALL_DIR = /^market-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Plain installs that a store install of the same package replaces: plain directory → store directory.
 *
 * A plain install runs under its manifest id; a store install of the same package runs under `market-<uuid>`.
 * The two identities differ, so both used to load side by side — two copies of every view and command, and
 * bundled Spaces with the same id where whichever directory sorted first won (the plain one, so users kept
 * seeing the old copy after installing from the store). Only the store copy loads now; it is the one the store
 * keeps updating.
 *
 * Same narrow rule as the package-id alias above: exactly one store install may claim the id. Two store items
 * declaring the same manifest id say nothing about which one the plain copy came from, so nothing is replaced.
 * `keep` lists runtime ids that are never replaced (packages that ship with the app).
 * Every scan of the shared plugins directory must apply this rule, or the host and the engine load different copies.
 */
export function supersededPlainInstalls(
  entries: ReadonlyArray<{ dir: string; manifestId: unknown }>,
  keep: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const store = new Map<string, string[]>();
  for (const e of entries) {
    if (MARKET_INSTALL_DIR.test(e.dir) && typeof e.manifestId === 'string' && SAFE_ID.test(e.manifestId)) {
      store.set(e.manifestId, [...(store.get(e.manifestId) || []), e.dir]);
    }
  }
  const out = new Map<string, string>();
  for (const e of entries) {
    if (MARKET_INSTALL_DIR.test(e.dir)) continue;
    const id = typeof e.manifestId === 'string' && SAFE_ID.test(e.manifestId) ? e.manifestId : SAFE_ID.test(e.dir) ? e.dir : null;
    const claim = id ? store.get(id) : undefined;
    if (id && !keep.has(id) && claim?.length === 1) out.set(e.dir, claim[0]);
  }
  return out;
}

/**
 * A plugin view type saved under an identity the plugin no longer runs as: `plugin:<packageId>:<view>` where no
 * listed plugin has that id but exactly one runs it under another (a store install, `market-<uuid>`). Returns the
 * type under the current identity, or null when the saved type is still someone's or the match is ambiguous.
 * `nodes` = every listed plugin, whether enabled or not (a disabled plain copy still owns its id).
 */
export function pluginViewAlias(type: string, nodes: ReadonlyArray<{ id: string; packageId?: string }>): string | null {
  const m = /^plugin:([^:]+):(.+)$/.exec(type);
  if (!m) return null;
  const owner = pluginDependencyIndex(nodes).get(m[1]);
  return owner && owner.id !== m[1] ? `plugin:${owner.id}:${m[2]}` : null;
}
