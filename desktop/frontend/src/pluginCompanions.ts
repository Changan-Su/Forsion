import { getView, useWorkspace } from '@lcl/engine'
import type { ViewContribution } from './amadeus/plugins/types'

/** Native panels stay mounted while the collection form is focused. Never close an editor/chat
 *  to simulate a layout change, and never replace the full workspace layout. */
export function setPluginCompanions(pluginId: string | undefined, ownerId: string, def: ViewContribution, visible: boolean): void {
  if (!pluginId) return
  const ws = useWorkspace.getState(), owner = ws.leafById(ownerId)
  if (!owner) return
  const specs = (def.mainCompanions || []).slice(0, 3).filter(s =>
    ['amadeus-editor', 'chat-panel'].includes(s.type) && s.key.startsWith(pluginId + '-') && ['right','down'].includes(s.split))
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
  for (const spec of specs) {
    let panel = api.panels.find(p => p.params?.__loc === 'main' && p.params?.__type === spec.type && p.params?.reuseKey === spec.key)
    const previousOwner=panel?.params?.__companionOwner
    if(typeof previousOwner==='string'&&previousOwner!==ownerId){
      const previousLeaf=ws.leafById(previousOwner)
      if(previousLeaf?.type===`plugin:${pluginId}:${def.id}`)continue
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
}
