/** Exact runtime identities win. A legacy package ID is an alias only while it is unambiguous. */
export function pluginDependencyIndex<T extends { id: string; packageId?: string }>(nodes: readonly T[]): Map<string, T> {
  const index = new Map(nodes.map(node => [node.id, node]));
  const aliases = new Map<string, T[]>();
  for (const node of nodes) if (node.packageId && node.packageId !== node.id) aliases.set(node.packageId, [...(aliases.get(node.packageId) || []), node]);
  for (const [alias, values] of aliases) if (!index.has(alias) && values.length === 1) index.set(alias, values[0]);
  return index;
}
