import { describe, expect, it } from 'vitest'
import { draftRange, draftValue, pickDraftDb } from './draft'

describe('calendar draft', () => {
  it('double-click = default 30 minutes from the snapped start, pulled back before midnight', () => {
    expect(draftRange(13 * 60 + 30, 13 * 60 + 30, true)).toEqual([810, 840])
    expect(draftRange(23 * 60 + 30, 23 * 60 + 30, true)).toEqual([1410, 1440])
  })
  it('drag sorts the ends and keeps at least 15 minutes', () => {
    expect(draftRange(15 * 60 + 30, 13 * 60, false)).toEqual([780, 930])
    expect(draftRange(600, 600, false)).toEqual([600, 615])
  })
  it('values: timed range, single all-day, multi-day all-day', () => {
    expect(draftValue({ day: '2026-10-15', startMin: 780, endMin: 930, endDay: '2026-10-15', title: '', dbPath: null })).toBe('2026-10-15T13:00/2026-10-15T15:30')
    expect(draftValue({ day: '2026-10-15', startMin: null, endMin: 0, endDay: '2026-10-15', title: '', dbPath: null })).toBe('2026-10-15')
    expect(draftValue({ day: '2026-10-12', startMin: null, endMin: 0, endDay: '2026-10-14', title: '', dbPath: null })).toBe('2026-10-12/2026-10-14')
  })
  it('picks the same target the side panel ticks', () => {
    const m = (path: string, o: { readonly?: boolean; isNoteView?: boolean } = {}) => ({ db: { path, ...o } })
    const ms = [m('ro', { readonly: true }), m('notes', { isNoteView: true }), m('a'), m('b')]
    expect(pickDraftDb(ms, 'b', 'a')?.db.path).toBe('b')
    expect(pickDraftDb(ms, null, 'a')?.db.path).toBe('a')
    expect(pickDraftDb(ms, 'ro', null)?.db.path).toBe('a')
    expect(pickDraftDb([m('notes', { isNoteView: true })], null, null)?.db.path).toBe('notes')
    expect(pickDraftDb([m('ro', { readonly: true })], null, null)).toBeNull()
  })
  it('saves a point when the mobile end-time control is off', () => {
    expect(draftValue({ day: '2026-10-21', startMin: 600, endMin: 630, endDay: '2026-10-21', title: 'Point', dbPath: null, hasEnd: false })).toBe('2026-10-21T10:00')
  })
})
