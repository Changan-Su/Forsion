/** Calendar renderers share the host's record clipboard and edit history. No internal stores cross the API. */
import { getAggDb, isDateCol } from '../store/dbAggregateStore'
import { isRealDate, parseCalDate } from '@amadeus-shared/db/calDate'
import { isStamped } from '../blocks/database/propertyTypes'
import { findMdMark, effectiveDue } from '../store/mdMarkStore'
import { calendarScope, canUndoCalendarEdit, canRedoCalendarEdit, deleteCalendarRow, redoLastCalendarEdit, rescheduleCalendarRow, rescheduleNoteTask, undoLastCalendarEdit } from '../../views/calendar/eventActions'
import { clearCalendarClipboard, cloneCalendarEvent, copyCalendarEvent, pasteCalendarEvent, useCalendarClipboard } from '../../views/calendar/eventClipboard'
import type { DataScope } from './pluginData'
import type { PluginCalendarEvents } from './types'

export function createCalendarEventsApi(scope: DataScope): PluginCalendarEvents {
  const validDate = (raw: string): boolean => {
    if (!raw) return true
    const [a, b, ...rest] = raw.split('/'), parsed = parseCalDate(raw)
    return !!parsed && !rest.length && isRealDate(a) && (b === undefined || parsed.end === b && isRealDate(b))
  }
  const event = (path: string, rowId: string, colId: string, before?: string) => {
    const db = scope.alive() ? getAggDb(path) : null
    const row = db?.rows.find((r) => r.rowId === rowId)
    if (!db || !row || !db.columns.some((c) => c.id === colId && isDateCol(c))) return null
    const raw = typeof row.cells[colId] === 'string' ? row.cells[colId] as string : ''
    return before !== undefined && before !== raw ? null : { db, row, colId, raw, title: row.name }
  }
  return {
    scope: () => scope.alive() ? calendarScope() : '',
    clipboard: () => {
      const clip = scope.alive() ? useCalendarClipboard.getState().clip : null
      return clip ? { scope: clip.scope, cut: clip.cut, path: clip.event.db.path, rowId: clip.event.row.rowId, colId: clip.event.colId, raw: clip.event.raw, title: clip.event.title } : null
    },
    subscribe: (cb) => scope.own(useCalendarClipboard.subscribe(() => { if (scope.alive()) cb() })),
    clearClipboard: () => { if (scope.alive()) clearCalendarClipboard() },
    copy: (path, rowId, colId, before, cut) => { const e = event(path, rowId, colId, before); return e ? copyCalendarEvent(e, cut, scope.alive) : false },
    clone: async (path, rowId, colId, before, after) => { const e = event(path, rowId, colId, before); return e && validDate(after ?? before) ? cloneCalendarEvent(e, after ?? before, scope.alive) : null },
    paste: async (path, stamp) => {
      if (!scope.alive()) return null
      const db = path ? getAggDb(path) : undefined
      if (path && !db) return null
      const date = stamp ? new Date(stamp) : undefined
      if (date && !Number.isFinite(date.getTime())) return null
      const hit = await pasteCalendarEvent(db ?? undefined, date, scope.alive)
      return hit && scope.alive() ? { path: hit.db.path, rowId: hit.id } : null
    },
    remove: (path, rowId, colId) => { const e = event(path, rowId, colId); if (!e) return false; deleteCalendarRow(e.db, e.row, e.title); return true },
    reschedule: (path, rowId, colId, before, after) => { const e = event(path, rowId, colId, before); if (!e || !validDate(after) || isStamped(e.db.columns.find((c) => c.id === colId)!.type)) return false; rescheduleCalendarRow(e.db, e.row, colId, before, after, e.title); return true },
    rescheduleNote: (id, before, after) => { const mark = scope.alive() ? findMdMark(id) : null; if (!mark || effectiveDue(mark) !== before || !after || !validDate(after)) return false; rescheduleNoteTask(mark, before, after, mark.text); return true },
    canUndo: () => scope.alive() && canUndoCalendarEdit(), canRedo: () => scope.alive() && canRedoCalendarEdit(),
    undo: () => scope.alive() && undoLastCalendarEdit(), redo: () => scope.alive() && redoLastCalendarEdit(),
  }
}
