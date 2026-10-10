import { allViews } from '@lcl/engine'
import type { ListSourceContribution } from '../amadeus/plugins/types'
import { normalizeUIAppCards, type UIAppCardDescriptor } from '../../../../tangu-agent/src/shared/intelligentCards'
export type PluginIntelligentSource = { pluginId: string; item: ListSourceContribution }
let sources: PluginIntelligentSource[] = []
const listeners = new Set<() => void>()
export function syncIntelligentSources(next: PluginIntelligentSource[]): void {
  sources = next.filter(s => !!s.item.intelligent)
  listeners.forEach(fn => fn())
}
export const subscribeIntelligentSources = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const getIntelligentSources = (): PluginIntelligentSource[] => sources
export function collectIntelligentCards(): UIAppCardDescriptor[] {
  return normalizeUIAppCards([
    ...allViews().filter(v => v.intelligent).map(v => ({ id: `native:${v.type}`, description: v.intelligent!.description, acceptsQuery: false })),
    ...sources.map(s => ({ id: `plugin:${s.pluginId}:${s.item.id}`, description: s.item.intelligent!.description, acceptsQuery: s.item.search === true })),
  ])
}
