// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
const h = vi.hoisted(() => ({ action: undefined as (() => void) | undefined, read: vi.fn() }))
vi.mock('../../amadeus/api', () => ({ amadeus: { writeDatabase: async () => {}, readTextFile: (...args: unknown[]) => h.read(...args), onDbExternalChange: undefined } }))
vi.mock('../../amadeus/store/automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))
vi.mock('../../amadeusPlugins', () => ({ ensureAmadeusReady: () => {} }))
vi.mock('../../stores/notificationStore', () => ({ notifyApp: (n: { action?: { run: () => void } }) => { h.action = n.action?.run } }))
const { useDbStore } = await import('../../amadeus/store/dbStore')
const { usePageStore } = await import('../../amadeus/store/pageStore')
const { useNoteViewStore } = await import('../../amadeus/store/noteViewStore')
const { aggregateDatabases, setAggCell } = await import('../../amadeus/store/dbAggregateStore')
const { rescheduleCalendarRow, deleteCalendarRow, undoLastCalendarEdit, redoLastCalendarEdit } = await import('./eventActions')
const { copyCalendarEvent, cloneCalendarEvent, pasteCalendarEvent, clearCalendarClipboard, useCalendarClipboard, shiftedCalendarValue } = await import('./eventClipboard')
const base = (): DbFile => ({ version: 1, name: 'Events', columns: [
  { id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' },
  { id: 'n', name: 'Number', type: 'autonumber' }, { id: 'created', name: 'Created', type: 'created' },
  { id: 'tag', name: 'Tag', type: 'multiselect', options: ['a', 'b'] },
], rows: [{ id: 'r1', body: '# Body\nUser content', cells: { name: 'Review', date: '2026-10-20T09:30/2026-10-20T11:00', n: 1, created: '2020-01-01T00:00', tag: ['a'] } }] })
const db = () => aggregateDatabases(['Events.db'], useDbStore.getState().entries, {})[0]
const event = () => { const d = db(), row = d.rows[0]; return { db: d, row, colId: 'date', raw: String(row.cells.date), title: row.name } }
const rows = () => useDbStore.getState().entries['Events.db'].data!.rows
let generation = 0
beforeEach(() => {
  usePageStore.setState({ vaultRoot: '/calendar-test-' + ++generation, vaultSide: 'local', files: ['Events.db'] })
  useDbStore.setState({ entries: { 'Events.db': { status: 'ok', path: 'Events.db', data: base() } } })
  clearCalendarClipboard()
})
afterEach(async () => { await useDbStore.getState().flushAll() })
describe('calendar action safety', () => {
  it('copy freezes fields/body and makes fresh stamps; clone preserves clipboard', async () => {
    const e = event()
    expect(copyCalendarEvent(e)).toBe(true)
    const clip = useCalendarClipboard.getState().clip
    setAggCell(db(), 'r1', 'tag', ['b'])
    const pasted = await pasteCalendarEvent()
    const copy = rows().find((r) => r.id === pasted!.id)!
    expect(copy.id).not.toBe('r1')
    expect(copy.body).toBe(e.row.body)
    expect(copy.cells.tag).toEqual(['a'])
    expect(copy.cells.n).toBe(2)
    expect(copy.cells.created).not.toBe('2020-01-01T00:00')
    await cloneCalendarEvent(event())
    expect(useCalendarClipboard.getState().clip).toBe(clip)
    expect(rows()).toHaveLength(3)
  })
  it('cut moves original only at paste, keeps duration; undo/redo and cancel keep data', async () => {
    const e = event()
    copyCalendarEvent(e, true)
    expect(rows()[0].cells.date).toBe(e.raw)
    const pasted = await pasteCalendarEvent(e.db, new Date(2026, 9, 21, 13, 15))
    expect(pasted!.id).toBe('r1')
    expect(rows()).toHaveLength(1)
    expect(rows()[0].cells.date).toBe('2026-10-21T13:15/2026-10-21T14:45')
    expect(undoLastCalendarEdit()).toBe(true)
    expect(rows()[0].cells.date).toBe(e.raw)
    expect(redoLastCalendarEdit()).toBe(true)
    copyCalendarEvent(event(), true)
    clearCalendarClipboard()
    expect(rows()).toHaveLength(1)
  })
  it('rejects another calendar/vault and changed cut source', async () => {
    const e = event()
    copyCalendarEvent(e, true)
    expect(await pasteCalendarEvent({ ...e.db, path: 'Other.db' })).toBeNull()
    setAggCell(db(), 'r1', 'name', 'Later edit')
    expect(await pasteCalendarEvent()).toBeNull()
    expect(rows()[0].cells.name).toBe('Later edit')
    copyCalendarEvent(event())
    usePageStore.setState({ vaultRoot: '/elsewhere' })
    expect(await pasteCalendarEvent()).toBeNull()
  })
  it('deletion restores body; shared notification undo runs once, with redo', () => {
    const e = event()
    deleteCalendarRow(e.db, e.row, e.title)
    const undo = h.action
    expect(rows()).toHaveLength(0)
    expect(undoLastCalendarEdit()).toBe(true)
    undo?.()
    expect(rows()).toHaveLength(1)
    expect(rows()[0].body).toBe(e.row.body)
    expect(redoLastCalendarEdit()).toBe(true)
    expect(rows()).toHaveLength(0)
  })
  it('delete redo refreshes its reference snapshot, preserving links added after the first undo', () => {
    useDbStore.getState().mutate('Events.db', (d) => ({ ...d,
      columns: [...d.columns, { id: 'link', name: 'Link', type: 'rowlink', refDb: 'Events.db' }],
      rows: [...d.rows, { id: 'ref', cells: { name: 'Ref' } }],
    }))
    const e = event()
    deleteCalendarRow(e.db, e.row, e.title)
    expect(undoLastCalendarEdit()).toBe(true)
    setAggCell(db(), 'ref', 'link', 'r1')
    expect(redoLastCalendarEdit()).toBe(true)
    expect(rows().find((r) => r.id === 'ref')!.cells.link).toBeUndefined()
    expect(undoLastCalendarEdit()).toBe(true)
    expect(rows().find((r) => r.id === 'ref')!.cells.link).toBe('r1')
  })
  it('pending note reads cannot overwrite a newer copy/cut/clear', async () => {
    const e = event()
    useDbStore.setState((s) => ({ entries: { ...s.entries, 'Notes.db': { status: 'ok', path: 'Notes.db', data: {
      version: 1, name: 'Notes', source: { folder: 'Notes' }, columns: [
        { id: 'page', name: 'Note', type: 'page' }, { id: 'date', name: 'Date', type: 'calendarDate' },
      ], rows: [],
    } } } }))
    usePageStore.setState({ files: ['Events.db', 'Notes.db'] })
    useNoteViewStore.setState({ folders: { Notes: { status: 'ok', props: [{ path: 'Notes/A.md', title: 'A', fm: { date: '2026-10-20' } }] } } } as never)
    const n = aggregateDatabases(['Notes.db'], useDbStore.getState().entries, useNoteViewStore.getState().folders)[0]
    const note = { db: n, row: n.rows[0], colId: 'date', raw: '2026-10-20', title: 'A' }
    let resolve!: (s: string) => void
    h.read.mockImplementation(() => new Promise<string>((r) => { resolve = r }))
    const pending = copyCalendarEvent(note)
    await vi.waitFor(() => expect(h.read).toHaveBeenCalled())
    copyCalendarEvent(e, true)
    resolve('# Old clipboard choice')
    expect(await pending).toBe(false)
    expect(useCalendarClipboard.getState().clip?.event.row.rowId).toBe('r1')
    h.read.mockClear()
    const cleared = copyCalendarEvent(note)
    await vi.waitFor(() => expect(h.read).toHaveBeenCalled())
    clearCalendarClipboard()
    resolve('# Cancelled copy')
    expect(await cleared).toBe(false)
    expect(useCalendarClipboard.getState().clip).toBeNull()
  })
  it('date undo keeps later title, refuses later date; clone undo keeps later changes', async () => {
    const e = event()
    rescheduleCalendarRow(e.db, e.row, 'date', e.raw, '2026-10-21', e.title)
    setAggCell(db(), 'r1', 'name', 'Later title')
    expect(undoLastCalendarEdit()).toBe(true)
    expect(rows()[0].cells.name).toBe('Later title')
    expect(redoLastCalendarEdit()).toBe(true)
    setAggCell(db(), 'r1', 'date', '2026-10-23')
    expect(undoLastCalendarEdit()).toBe(false)
    expect(rows()[0].cells.date).toBe('2026-10-23')
    const id = await cloneCalendarEvent(event())
    setAggCell(db(), id!, 'name', 'Keep this')
    expect(undoLastCalendarEdit()).toBe(false)
    expect(rows()).toHaveLength(2)
  })
  it('keeps 20 steps and clears redo on new work', () => {
    let before = event().raw
    for (let i = 1; i <= 22; i++) {
      const next = '2026-11-' + String(i).padStart(2, '0')
      rescheduleCalendarRow(db(), event().row, 'date', before, next, 'Review')
      before = next
    }
    for (let i = 0; i < 20; i++) expect(undoLastCalendarEdit()).toBe(true)
    expect(undoLastCalendarEdit()).toBe(false)
    expect(redoLastCalendarEdit()).toBe(true)
    rescheduleCalendarRow(db(), event().row, 'date', String(rows()[0].cells.date), '2026-12-01', 'Review')
    expect(redoLastCalendarEdit()).toBe(false)
  })
  it('readonly never mutates; all-day paste retains day count', async () => {
    const e = event(), ro = { ...e, db: { ...e.db, readonly: true } }
    expect(copyCalendarEvent(ro)).toBe(false)
    expect(await cloneCalendarEvent(ro)).toBeNull()
    deleteCalendarRow(ro.db, ro.row, ro.title)
    expect(rows()).toHaveLength(1)
    expect(shiftedCalendarValue('2026-10-20/2026-10-22', new Date(2026, 9, 24, 13))).toBe('2026-10-24/2026-10-26')
  })
})
