import { expect, it } from 'vitest'
import { normalizeUIAppCards } from './intelligentCards.js'
it('bounds and sanitizes untrusted client metadata; never accepts executable props or records', () => {
  expect(normalizeUIAppCards(null)).toEqual([])
  expect(normalizeUIAppCards([{ id: 'native:calendar', description: 'Agenda\u202e', records: ['secret'], render: 'code' }, { id: '__proto__', description: 'bad' }, { id: 'plugin:x:y', description: 'Bookmarks', acceptsQuery: true }])).toEqual([
    { id: 'native:calendar', description: 'Agenda', acceptsQuery: false }, { id: 'plugin:x:y', description: 'Bookmarks', acceptsQuery: true },
  ])
  expect(normalizeUIAppCards(Array.from({ length: 90 }, (_, i) => ({ id: `native:a${i}`, description: 'card' })))).toHaveLength(64)
})
