import { afterEach, expect, it, vi } from 'vitest'
vi.mock('./pageStore', () => ({ onNotePathGone: () => () => {}, usePageStore: { getState: () => ({ vaultRoot: '/vault' }), subscribe: () => () => {} } }))
vi.mock('./automationKick', () => ({ kickAutomation: () => {} }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('does not replay pending append onto an already edited entry after failed external reload', async () => {
  vi.useFakeTimers(); vi.resetModules()
  const base = { version: 1, name: 'db', columns: [], rows: [] as Array<{ id: string; cells: {} }> }
  let reads = 0
  let committed: any
  vi.stubGlobal('window', { addEventListener: () => {}, amadeus: {
    readDatabase: async () => { if (++reads > 1) throw new Error('temporary read failure'); return { status: 'ok', path: 'data.db', data: structuredClone(base), version: 'base-v1' } },
    writeDatabaseCas: async (_path: string, data: any) => { committed = structuredClone(data); return { ok: true, version: 'v2' } },
  } })
  const { useDbStore } = await import('./dbStore')
  await useDbStore.getState().load('data.db', 'data.db')
  useDbStore.getState().mutate('data.db', d => ({ ...d, rows: [...d.rows, { id: 'one-user-append', cells: {} }] }))
  await useDbStore.getState().reloadByPath('data.db')
  await useDbStore.getState().flushAll(true)
  expect(committed.rows.map((r: any) => r.id)).toEqual(['one-user-append'])
})
