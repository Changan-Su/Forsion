import { contentStorageKey, loadLayout, saveLayout, loadNamedLayout, saveNamedLayout, type LayoutBlob } from '@lcl/engine'

/** Replace only Tangu's old right-panel defaults; preserve main tabs, split sizes and other Spaces. */
export function upgradeTanguDetailsLayout(blob: LayoutBlob): LayoutBlob {
  const next = structuredClone(blob)
  const oldTypes = new Set(['chat-panel', 'memory', 'subchats'])
  const stash = next.sidebars.right.stash.filter((v) => !oldTypes.has(v.type) && v.type !== 'tangu-details')
  next.sidebars.right.stash = [{ type: 'tangu-details', params: {} }, ...stash]
  const dv = next.dockview as any
  if (!dv?.panels) return next
  const old = Object.entries(dv.panels).filter(([, p]: any) => p.params?.__loc === 'right' && oldTypes.has(p.params?.__type))
  const existing = Object.entries(dv.panels).find(([, p]: any) => p.params?.__loc === 'right' && p.params?.__type === 'tangu-details')
  const replacement = existing?.[0] || old[0]?.[0]
  if (!replacement) return next
  const panel = dv.panels[replacement]
  panel.params = { __type: 'tangu-details', __loc: 'right' }
  panel.contentComponent = 'tangu-details'
  const removed = new Set(old.map(([id]) => id).filter((id) => id !== replacement))
  for (const id of removed) delete dv.panels[id]
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.views)) {
      node.views = node.views.filter((id: string) => !removed.has(id))
      if (removed.has(node.activeView)) node.activeView = node.views[0]
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(dv.grid)
  // A user may have split the old right tabs into separate groups. Remove empty groups too.
  const groupIds = new Set<string>()
  const prune = (node: any): boolean => {
    if (Array.isArray(node?.data?.views)) {
      if (!node.data.views.length) return false
      if (node.data.id) groupIds.add(node.data.id)
    }
    if (Array.isArray(node?.data)) {
      node.data = node.data.filter(prune)
      return node.data.length > 0
    }
    return true
  }
  prune(dv.grid?.root)
  if (dv.activeGroup && groupIds.size && !groupIds.has(dv.activeGroup)) dv.activeGroup = [...groupIds][0]
  return next
}

export function migrateTanguDetailsLayouts(): void {
  try {
    if (localStorage.getItem(contentStorageKey('tangu_details_layout_v1')) === '1') return
    const named = loadNamedLayout('space:tangu')
    if (named) saveNamedLayout('space:tangu', upgradeTanguDetailsLayout(named))
    if ((localStorage.getItem('forsion_tangu_active_space') || 'tangu') === 'tangu') {
      const current = loadLayout()
      if (current) saveLayout(upgradeTanguDetailsLayout(current))
    }
    localStorage.setItem(contentStorageKey('tangu_details_layout_v1'), '1')
  } catch { /* Unavailable storage: the new default layout still applies on a fresh open. */ }
}
