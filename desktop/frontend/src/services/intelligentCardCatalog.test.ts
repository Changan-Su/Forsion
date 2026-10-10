import { afterEach, expect, it } from 'vitest'
import { registerView, unregisterView } from '@lcl/engine'
import { collectIntelligentCards, syncIntelligentSources } from './intelligentCardCatalog'
afterEach(() => { unregisterView('test-card'); unregisterView('private-view'); syncIntelligentSources([]) })
it('uses explicit opt-in and removes descriptors when the source or native view disappears', () => {
  registerView({ type: 'test-card', displayName: 'Card', factory: () => null, intelligent: { description: 'Live card', render: () => null } })
  registerView({ type: 'private-view', displayName: 'Private', factory: () => null })
  const source = { id: 'library', title: 'Library', search: true, items: () => [], open: () => {}, subscribe: () => () => {}, intelligent: { description: 'Bookmarks', viewId: 'folder' } }
  syncIntelligentSources([{ pluginId: 'bluebird', item: source }])
  expect(collectIntelligentCards().map(c => c.id)).toEqual(['native:test-card', 'plugin:bluebird:library'])
  syncIntelligentSources([]); unregisterView('test-card')
  expect(collectIntelligentCards()).toEqual([])
})
