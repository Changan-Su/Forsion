import { openObject, spaceOpensElsewhere, useSpaceStore } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { PENZOR_SPACE_ID } from '../../services/syncSetup'
import { windowKind } from '../../windowKind'

const PLUGIN = 'forsion-extend'
const SOURCE = 'penzor-places'

function librarySource() {
  if (windowKind() !== 'main' || spaceOpensElsewhere(PENZOR_SPACE_ID)) return undefined
  if (!useSpaceStore.getState().spaces.some((space) => space.id === PENZOR_SPACE_ID)) return undefined
  const state = usePluginStore.getState()
  if (!state.activeIds.includes(PLUGIN) || !state.plugins.some((plugin) => plugin.id === PLUGIN && plugin.locked)) return undefined
  return state.listSources.find((source) => source.pluginId === PLUGIN && source.item.id === SOURCE)?.item
}

export function canViewPenzorLibrary(): boolean { return !!librarySource() }

/** Use the built-in Penzor sidebar's existing list action and its library key. */
export async function openPenzorLibrary(libraryId: string, title: string): Promise<boolean> {
  const source = librarySource()
  if (!source) return false
  const result = await openObject({ type: 'space', id: PENZOR_SPACE_ID }, 'here', { kind: 'plugin', container: PLUGIN })
  if (!result.ok || librarySource() !== source || useSpaceStore.getState().activeSpaceId !== PENZOR_SPACE_ID) return false
  source.open({ key: `lib:${libraryId}`, title }, { newTab: false })
  return true
}
