import { getView, useWorkspace } from '@lcl/engine'
import { withPreservedSideWidths } from '@lcl/engine/dockviewStore'
import type { ViewContribution } from './amadeus/plugins/types'

const COMPANION_TYPES: readonly string[] = ['amadeus-editor', 'chat-panel']

/** The companions a view may declare: at most three, native host views only, keys inside the plugin's namespace. */
function companionSpecs(pluginId: string, def: ViewContribution): NonNullable<ViewContribution['mainCompanions']> {
  return (def.mainCompanions || []).slice(0, 3).filter(s =>
    COMPANION_TYPES.includes(s.type) && typeof s.key === 'string' && s.key.startsWith(pluginId + '-') && ['right','down'].includes(s.split))
}

/** Close companion tabs a plugin view no longer declares (a newer plugin version dropped them; plugins cannot close
 *  host panels themselves, so without this they live in the saved layout forever).
 *  Only tabs carrying the host's own `__companionOwner` marker are candidates — a tab the user opened, even on the
 *  same note, never has it. A candidate is closed when its owner is this leaf, or its owner leaf is gone (an
 *  in-session upgrade closes the old owner and the Space reopens a new one), AND no registered view of this plugin
 *  still declares its (type, key). Keys belonging to a longer plugin id (`foo-bar-x` vs plugin `foo`) are skipped.
 *  Callers run this only once the owner view is registered and mounted: a plugin that is still loading or failed
 *  to load never mounts its view, so it never prunes. The single-column store (no Dockview api) opens companions
 *  without the marker; those cannot be told apart from user tabs and are left alone. */
export function pruneStalePluginCompanions(pluginId: string | undefined, ownerId: string, def: ViewContribution,
  plugin: { views: readonly ViewContribution[]; knownPluginIds: readonly string[] }): number {
  if (!pluginId) return 0
  const ws = useWorkspace.getState(), api = ws.api
  if (!api) return 0
  const ownerType = `plugin:${pluginId}:${def.id}`
  if (ws.leafById(ownerId)?.type !== ownerType || !getView(ownerType)) return 0
  const declared = new Set([def, ...plugin.views].flatMap(v => companionSpecs(pluginId, v)).map(s => `${s.type}\n${s.key}`))
  const longer = plugin.knownPluginIds.filter(id => id !== pluginId && id.startsWith(pluginId + '-'))
  const stale = api.panels.filter(p => {
    const q = (p.params ?? {}) as Record<string, unknown>
    const owner = q.__companionOwner, key = q.reuseKey, type = q.__type
    if (q.__loc !== 'main' || typeof owner !== 'string' || typeof key !== 'string' || typeof type !== 'string') return false
    if (!COMPANION_TYPES.includes(type) || !key.startsWith(pluginId + '-') || longer.some(id => key.startsWith(id + '-'))) return false
    if (owner !== ownerId && ws.leafById(owner)) return false // another live owner handles its own companions
    return !declared.has(`${type}\n${key}`)
  })
  if (!stale.length) return 0
  for (const p of stale) ws.closeLeaf(p.id, true)
  ws.saveCurrent()
  return stale.length
}

/** Native panels stay mounted while the collection form is focused. Never close an editor/chat
 *  to simulate a layout change, and never replace the full workspace layout. */
export function setPluginCompanions(pluginId: string | undefined, ownerId: string, def: ViewContribution, visible: boolean): void {
  if (!pluginId) return
  const ws = useWorkspace.getState(), owner = ws.leafById(ownerId)
  if (!owner) return
  const specs = companionSpecs(pluginId, def)
  const api = ws.api
  if (!api) {
    if (visible) for (const spec of specs) {
      const exists=ws.mainTabs.some(tab=>ws.leafById(tab.id)?.params?.reuseKey===spec.key)
      if(!exists)ws.openView(spec.type, { ...spec.params, reuseKey: spec.key }, 'main', { newTab: true })
    }
    ws.activateLeaf(ownerId)
    return
  }
  const anchor = api.getPanel(ownerId)
  if (!anchor || anchor.params?.__loc !== 'main') return
  const companionFor = (spec: (typeof specs)[number]) => api.panels.find(p => p.params?.__loc === 'main' && p.params?.__type === spec.type && p.params?.reuseKey === spec.key)
  const ownedElsewhere = (panel: ReturnType<typeof companionFor>) => {
    const previousOwner = panel?.params?.__companionOwner
    return typeof previousOwner === 'string' && previousOwner !== ownerId && ws.leafById(previousOwner)?.type === `plugin:${pluginId}:${def.id}`
  }
  const newColumns = visible && api.width >= 720 ? new Set(specs.filter(spec => {
    const panel = companionFor(spec)
    return spec.split === 'right' && !ownedElsewhere(panel) && (panel ? panel.group === anchor.group : !!getView(spec.type))
  }).map(spec => `${spec.type}:${spec.key}`)).size : 0
  withPreservedSideWidths(api, () => {
    for (const spec of specs) {
      let panel = companionFor(spec)
      if (ownedElsewhere(panel)) continue
      const previousOwner=panel?.params?.__companionOwner
      if(typeof previousOwner==='string'&&previousOwner!==ownerId){
        panel!.api.updateParameters({...panel!.params,__companionOwner:ownerId})
      }
      if (!panel && visible) {
        const view = getView(spec.type)
        if (!view) continue
        const title = typeof view.displayName === 'function' ? view.displayName() : view.displayName
        panel = api.addPanel({ id: `${ownerId}:${spec.key}`, component: '__frame', title,
          params: { ...spec.params, reuseKey: spec.key, __type: spec.type, __loc: 'main', __companionOwner: ownerId },
          position: { referencePanel: anchor.id, direction: api.width < 720 ? 'within' : spec.split === 'down' ? 'below' : 'right' } })
      }
      if (!panel) continue
      if ((!visible || api.width < 720) && panel.group !== anchor.group) {
        panel.api.updateParameters({ ...panel.params, __companionOwner: ownerId,
          __companionSize: { width: panel.group.api.width, height: panel.group.api.height } })
        panel.api.moveTo({ group: anchor.group, position: 'center', skipSetActive: true })
      } else if (visible && api.width >= 720 && panel.group === anchor.group) {
        const size = panel.params?.__companionSize as { width?: number; height?: number } | undefined
        panel.api.moveTo({ group: anchor.group, position: spec.split === 'down' ? 'bottom' : 'right', skipSetActive: true })
        panel.api.setActive()
        if (spec.split === 'right' && size?.width) panel.group.api.setSize({ width: size.width })
        if (spec.split === 'down' && size?.height) panel.group.api.setSize({ height: size.height })
      }
    }
    anchor.api.setActive()
    ws.refreshTabs()
    ws.saveCurrent()
  }, newColumns)
}
