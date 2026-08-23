import { deleteAggRow, restoreAggRow, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { notifyApp } from '../../stores/notificationStore'

/** 删除日历/待办行；经典数据库提供通知条撤销，笔记视图保留文件删除确认。 */
export function deleteCalendarRow(db: AggDb, row: AggRow, title: string): void {
  deleteAggRow(db, row.rowId)
  if (db.isNoteView) return
  notifyApp({
    text: `已删除「${title || '未命名'}」`,
    level: 'info',
    action: { label: '撤销', run: () => restoreAggRow(db, row) },
  })
}
