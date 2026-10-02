import type { DockviewApi } from 'dockview-react'

/** Remove temporary native Views from a copy. Regular tabs opened while editing still persist. */
export function withoutTransientPanels(input: ReturnType<DockviewApi['toJSON']>, previousViews: Record<string, string> = {}): ReturnType<DockviewApi['toJSON']> {
  const removed = new Set(Object.entries(input.panels ?? {}).filter(([, p]) => p.contentComponent === '__extend').map(([id]) => id))
  if (!removed.size) return input
  const blob = structuredClone(input)
  for (const id of removed) delete blob.panels[id]
  type Node = typeof blob.grid.root
  const prune = (node: Node): Node | null => {
    if (Array.isArray(node.data)) {
      node.data = node.data.map(prune).filter((n): n is Node => n !== null)
      return node.data.length ? node : null
    }
    const had = node.data.views.length
    node.data.views = node.data.views.filter((id) => !removed.has(id))
    if (had && !node.data.views.length) return null // 本来就空的组(收起的底部面板藏着的那个)照存
    if (node.data.activeView && removed.has(node.data.activeView)) {
      const previous = previousViews[node.data.activeView]
      node.data.activeView = node.data.views.includes(previous) ? previous : node.data.views[0]
    }
    return node
  }
  const root = prune(blob.grid.root)
  if (root) blob.grid.root = root
  // A removed group may have held focus. Dockview will select the first surviving group.
  const hasGroup = (node: Node, id: string): boolean => Array.isArray(node.data)
    ? node.data.some((child) => hasGroup(child, id)) : node.data.id === id
  if (blob.activeGroup && !hasGroup(blob.grid.root, blob.activeGroup)) delete blob.activeGroup
  return blob
}
