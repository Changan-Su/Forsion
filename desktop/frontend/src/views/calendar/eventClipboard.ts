/** Calendar's internal clipboard never asks a phone for system clipboard permission. */
import { create } from 'zustand'
import { parseCalDate } from '@amadeus-shared/db/calDate'
import { deleteAggRow, duplicateAggRow, getAggDb, restoreAggRow, setAggCell, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { notifyApp } from '../../stores/notificationStore'
import { amadeus } from '../../amadeus/api'
import { flushAllScopes } from '../../amadeus/store/pageStore'
import { isStamped } from '../../amadeus/blocks/database/propertyTypes'
import { registerMessages, translate } from '../../i18n'
import { calendarScope, currentCalendarRow, offerCalendarUndo, rescheduleCalendarRow, sameCalendarRow } from './eventActions'
import { diffDays, fmtStamp, shiftDays, toLocalDate } from './dateUtils'

registerMessages({
  'calclip.copied': { zh: '已复制事件', en: 'Event copied' },
  'calclip.cut': { zh: '已剪切，选择时间格后粘贴', en: 'Event cut. Choose a time slot and paste' },
  'calclip.created': { zh: '已创建事件副本', en: 'Event duplicated' },
  'calclip.failed': { zh: '操作未完成，原事件已保留。', en: 'The action could not finish. The original event was kept.' },
  'calclip.scope': { zh: '请在原智库的同一日历中粘贴。', en: 'Paste into the same calendar in the original vault.' },
  'calclip.noteCopy': { zh: '笔记事件请在来源中复制文件，以保留完整正文。', en: 'Duplicate the note in its source to preserve the complete document.' },
})
export interface ClipboardEvent { db: AggDb; row: AggRow; colId: string; raw: string; title: string; noteText?: string }
interface Clip { scope: string; event: ClipboardEvent; cut: boolean }
export const useCalendarClipboard = create<{ clip: Clip | null }>(() => ({ clip: null }))
let clipboardGeneration = 0
export function clearCalendarClipboard(): void { ++clipboardGeneration; useCalendarClipboard.setState({ clip: null }) }
export function copyCalendarEvent(event: ClipboardEvent, cut = false): boolean | Promise<boolean> {
  const generation = ++clipboardGeneration
  if (event.db.readonly || (cut && isStamped(event.db.columns.find((c) => c.id === event.colId)?.type ?? ''))) return false
  const row = currentCalendarRow(event.db, event.row.rowId)
  if (!row) return false
  if (event.db.isNoteView && !cut) {
    const scope = calendarScope()
    return (async () => {
      try {
        await flushAllScopes(true)
        if (calendarScope() !== scope || generation !== clipboardGeneration) return false
        const noteText = await amadeus.readTextFile(row.rowId)
        if (noteText == null || calendarScope() !== scope || generation !== clipboardGeneration) return false
        useCalendarClipboard.setState({ clip: { scope, event: { ...event, row: structuredClone(row), noteText }, cut } })
        notifyApp({ level: 'info', text: translate('calclip.copied') })
        return true
      } catch { notifyApp({ level: 'warning', text: translate('calclip.failed') }); return false }
    })()
  }
  useCalendarClipboard.setState({ clip: { scope: calendarScope(), event: { ...event, row: structuredClone(row) }, cut } })
  notifyApp({ level: 'info', text: translate(cut ? 'calclip.cut' : 'calclip.copied') })
  return true
}
export function shiftedCalendarValue(raw: string, target?: Date): string {
  const parsed = parseCalDate(raw)
  if (!parsed || !target) return raw
  const start = toLocalDate(parsed.start)
  const next = new Date(target)
  if (parsed.allDay) next.setHours(0, 0, 0, 0)
  const end = parsed.end ? parsed.allDay
    ? shiftDays(toLocalDate(parsed.end), diffDays(next, start))
    : new Date(next.getTime() + toLocalDate(parsed.end).getTime() - start.getTime()) : null
  return `${fmtStamp(next, parsed.allDay)}${end ? `/${fmtStamp(end, parsed.allDay)}` : ''}`
}
export async function cloneCalendarEvent(event: ClipboardEvent, raw = event.raw): Promise<string | null> {
  const scope = calendarScope()
  if (event.db.readonly) return null
  if (raw !== event.raw && isStamped(event.db.columns.find((c) => c.id === event.colId)?.type ?? '')) {
    notifyApp({ level: 'warning', text: translate('calclip.failed') })
    return null
  }
  const live = getAggDb(event.db.path)
  if (!live || JSON.stringify(live.columns) !== JSON.stringify(event.db.columns)) {
    notifyApp({ level: 'warning', text: translate('calclip.failed') })
    return null
  }
  try {
    const id = await duplicateAggRow({ ...event.db, rows: [event.row] }, event.row.rowId, () => calendarScope() === scope, event.noteText)
    if (!id || scope !== calendarScope()) return null
    if (raw !== event.raw) setAggCell(event.db, id, event.colId, raw)
    if (event.db.isNoteView) {
      notifyApp({ level: 'info', text: translate('calclip.created') })
      return id // File deletion has its own confirmation/recycle bin, never a fake row-level undo.
    }
    const snapshot = structuredClone(currentCalendarRow(event.db, id)!)
    let removed: ReturnType<typeof deleteAggRow> = []
    offerCalendarUndo(translate('calclip.created'), () => {
      if (!sameCalendarRow(event.db, currentCalendarRow(event.db, id), snapshot)) return false
      removed = deleteAggRow(event.db, id, snapshot)
      return true
    }, () => {
      if (currentCalendarRow(event.db, id)) return false
      restoreAggRow(event.db, snapshot, removed)
      return true
    })
    return id
  } catch {
    notifyApp({ level: 'error', text: translate('calclip.failed') })
    return null
  }
}
export async function pasteCalendarEvent(db?: AggDb, target?: Date): Promise<{ db: AggDb; id: string } | null> {
  const clip = useCalendarClipboard.getState().clip
  if (!clip) return null
  const event = clip.event
  if (clip.scope !== calendarScope() || (db && db.path !== event.db.path) || db?.readonly) {
    notifyApp({ level: 'warning', text: translate('calclip.scope') })
    return null
  }
  const live = getAggDb(event.db.path)
  if (!live || JSON.stringify(live.columns) !== JSON.stringify(event.db.columns)) {
    notifyApp({ level: 'warning', text: translate('calclip.failed') })
    return null
  }
  if (clip.cut) {
    const row = currentCalendarRow(event.db, event.row.rowId)
    if (!row || !sameCalendarRow(event.db, row, event.row)) {
      notifyApp({ level: 'warning', text: translate('calclip.failed') })
      return null
    }
    const raw = shiftedCalendarValue(event.raw, target)
    rescheduleCalendarRow(event.db, row, event.colId, event.raw, raw, event.title)
    clearCalendarClipboard()
    return { db: event.db, id: row.rowId }
  }
  const id = await cloneCalendarEvent(event, shiftedCalendarValue(event.raw, target))
  return id ? { db: event.db, id } : null
}
