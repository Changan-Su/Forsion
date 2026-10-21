// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'

let disk: DbFile
vi.mock('../api', () => ({ amadeus: {
  readDatabase: async () => ({ status: 'ok', path: 'T.db', data: structuredClone(disk), version: 'v0' }),
  writeDatabaseCas: async (_p: string, data: DbFile) => { disk = structuredClone(data); return { ok: true, version: 'v1' } },
  writeDatabase: async () => {}, listMarks: async () => [], onDbExternalChange: undefined,
} }))
vi.mock('../../amadeusPlugins', () => ({ ensureAmadeusReady: () => {} }))
vi.mock('../store/automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))
const { useDbStore } = await import('../store/dbStore')
const { usePageStore } = await import('../store/pageStore')
const { createCalendarEventsApi } = await import('./pluginCalendarEvents')
const api = createCalendarEventsApi({ alive: () => true, own: (off) => off })
beforeEach(async () => {
  disk = { version: 1, name: 'T', columns: [{ id: 'name', name: 'Task', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }, { id: 'created', name: 'Created', type: 'created' }], rows: [{ id: 'r1', cells: { name: 'Original', date: '2026-10-21T10:00/2026-10-21T11:00', created: '2026-10-20' }, body: '# Full body' }] }
  usePageStore.setState({ vaultRoot: '/A', vaultSide: 'local', files: ['T.db'], filesPendingFor: null })
  useDbStore.setState({ entries: {} }); await useDbStore.getState().reload('T.db', 'T.db'); api.clearClipboard()
})
afterEach(async () => { await useDbStore.getState().flushAll() })

it('rejects stale dates, non-date columns and malformed dates', async () => {
  expect(api.reschedule('T.db', 'r1', 'date', '2026-10-20', '2026-10-22')).toBe(false)
  expect(api.reschedule('T.db', 'r1', 'name', 'Original', '2026-10-22')).toBe(false)
  expect(api.reschedule('T.db', 'r1', 'created', '2026-10-20', '2026-10-22')).toBe(false)
  expect(api.reschedule('T.db', 'r1', 'date', disk.rows[0].cells.date as string, '2026-02-31')).toBe(false)
  expect(await api.clone('T.db', 'r1', 'date', disk.rows[0].cells.date as string, 'invalid')).toBeNull()
})
it('the plugin uses native copy/clone/conditional undo and retains the record body', async () => {
  const raw = disk.rows[0].cells.date as string
  expect(await api.copy('T.db', 'r1', 'date', raw)).toBe(true)
  const hit = await api.paste('T.db', '2026-10-22T10:00:00')
  expect(hit?.path).toBe('T.db')
  const rows = () => useDbStore.getState().entries['T.db'].data!.rows
  expect(rows().find((r) => r.id === hit?.rowId)?.body).toBe('# Full body')
  expect(api.undo()).toBe(true); expect(rows()).toHaveLength(1)
  expect(api.redo()).toBe(true); expect(rows()).toHaveLength(2)
  useDbStore.getState().mutate('T.db', (d) => ({ ...d, rows: d.rows.map((r) => r.id === hit?.rowId ? { ...r, body: 'Later edit' } : r) }))
  expect(api.undo()).toBe(false); expect(rows()).toHaveLength(2)
})
it('does not paste across vaults or operate after plugin disable', async () => {
  await api.copy('T.db', 'r1', 'date', disk.rows[0].cells.date as string)
  usePageStore.setState({ vaultRoot: '/B' })
  expect(await api.paste()).toBeNull()
  const revoked = createCalendarEventsApi({ alive: () => false, own: (off) => { off(); return () => {} } })
  expect(revoked.copy('T.db', 'r1', 'date', '')).toBe(false)
  expect(revoked.remove('T.db', 'r1', 'date')).toBe(false)
  expect(revoked.undo()).toBe(false)
})
it('unscheduling supports undo and redo without an intervening edit', () => {
  const raw = disk.rows[0].cells.date as string
  const row = () => useDbStore.getState().entries['T.db'].data!.rows[0]
  expect(api.reschedule('T.db', 'r1', 'date', raw, '')).toBe(true)
  expect(row().cells.date).toBeUndefined()
  expect(api.undo()).toBe(true)
  expect(row().cells.date).toBe(raw)
  expect(api.redo()).toBe(true)
  expect(row().cells.date).toBeUndefined()
  expect(row().body).toBe('# Full body')
})
