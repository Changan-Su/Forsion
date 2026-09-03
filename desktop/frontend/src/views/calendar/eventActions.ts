import { deleteAggRow, restoreAggRow, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { notifyApp } from '../../stores/notificationStore'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'calevtact.deleted': { zh: '已删除「{title}」', en: 'Deleted “{title}”' },
  'calevtact.untitled': { zh: '未命名', en: 'Untitled' },
  'calevtact.undo': { zh: '撤销', en: 'Undo' },
})

/** 删除日历/待办行；经典数据库提供通知条撤销，笔记视图保留文件删除确认。 */
export function deleteCalendarRow(db: AggDb, row: AggRow, title: string): void {
  const removed = deleteAggRow(db, row.rowId) // 同文件自引用清单:撤销时条件回填,不然关联随删行一起丢
  if (db.isNoteView) return
  notifyApp({
    text: translate('calevtact.deleted', { title: title || translate('calevtact.untitled') }),
    level: 'info',
    action: { label: translate('calevtact.undo'), run: () => restoreAggRow(db, row, removed) },
  })
}
