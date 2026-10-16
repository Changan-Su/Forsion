import { deleteAggRow, restoreAggRow, setAggCell, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { notifyApp } from '../../stores/notificationStore'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'calevtact.deleted': { zh: '已删除「{title}」', en: 'Deleted “{title}”' },
  'calevtact.moved': { zh: '已改时间「{title}」', en: 'Rescheduled “{title}”' },
  'calevtact.untitled': { zh: '未命名', en: 'Untitled' },
  'calevtact.undo': { zh: '撤销', en: 'Undo' },
})

// ponytail: 只记最近一次(⌘Z 撤这一步);要多步撤销再换成栈。
let lastUndo: (() => void) | null = null

/** ⌘Z:撤销日历里最近一次删除 / 改时间;没有可撤的返回 false。 */
export function undoLastCalendarEdit(): boolean {
  const run = lastUndo
  lastUndo = null
  run?.()
  return !!run
}

function offerUndo(text: string, run: () => void): void {
  lastUndo = run
  notifyApp({
    text,
    level: 'info',
    dedupeKey: 'calendar-undo',
    durationMs: 8000, // U-06:带撤销钮的提示留够反应时间
    action: { label: translate('calevtact.undo'), run: () => { if (lastUndo === run) lastUndo = null; run() } },
  })
}

/** 删除日历/待办行；经典数据库提供通知条撤销，笔记视图保留文件删除确认。 */
export function deleteCalendarRow(db: AggDb, row: AggRow, title: string): void {
  const removed = deleteAggRow(db, row.rowId) // 同文件自引用清单:撤销时条件回填,不然关联随删行一起丢
  if (db.isNoteView) return
  offerUndo(translate('calevtact.deleted', { title: title || translate('calevtact.untitled') }), () => restoreAggRow(db, row, removed))
}

/** 拖动改时间 / 改时长:写新值,并给撤销(回到改之前的原值)。 */
export function rescheduleCalendarRow(db: AggDb, row: AggRow, colId: string, before: string, after: string, title: string): void {
  if (before === after) return
  setAggCell(db, row.rowId, colId, after)
  offerUndo(translate('calevtact.moved', { title: title || translate('calevtact.untitled') }), () => setAggCell(db, row.rowId, colId, before || undefined))
}
