import { deleteAggRow, restoreAggRow, setAggCell, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { usePageStore } from '../../amadeus/store/pageStore'
import { effectiveDue, patchMark, useMdMarkStore } from '../../amadeus/store/mdMarkStore'
import { resolveMark, type MdMark } from '@amadeus-shared/mdMarks'
import { notifyApp } from '../../stores/notificationStore'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'calevtact.deleted': { zh: '已删除「{title}」', en: 'Deleted “{title}”' },
  'calevtact.moved': { zh: '已改时间「{title}」', en: 'Rescheduled “{title}”' },
  'calevtact.untitled': { zh: '未命名', en: 'Untitled' },
  'calevtact.undo': { zh: '撤销', en: 'Undo' },
})

// ponytail: 只记最近一次(⌘Z 撤这一步);要多步撤销再换成栈。
let lastUndo: (() => boolean) | null = null

/** ⌘Z:撤销日历里最近一次删除 / 改时间;没有可撤的返回 false。 */
export function undoLastCalendarEdit(): boolean {
  const run = lastUndo
  lastUndo = null
  return run ? run() : false
}

const vaultKey = (): string => { const s = usePageStore.getState(); return `${s.vaultSide}:${s.vaultRoot}` }

/** 撤销只生效一次(⌘Z 与通知条按钮共用),且只在记下它的那个库里生效:
 *  库路径是相对的,换了库再撤会把 A 库的行写进 B 库(Codex 评审 P1)。 */
function offerUndo(text: string, run: () => void): void {
  const vault = vaultKey()
  let used = false
  const once = (): boolean => {
    if (lastUndo === once) lastUndo = null
    if (used || vaultKey() !== vault) return false
    used = true
    run()
    return true
  }
  lastUndo = once
  notifyApp({
    text,
    level: 'info',
    dedupeKey: 'calendar-undo',
    durationMs: 8000, // U-06:带撤销钮的提示留够反应时间
    action: { label: translate('calevtact.undo'), run: () => { once() } },
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

/** 笔记正文任务改日期(待办视图拖到分组头):改那一行的 `@日期`,撤销 = 改回原值。
 *  撤销时笔记可能已经插 / 删过行:按「同篇同一句、且只有这一条」找回它,且它的日期还得是我们写进去的值,否则不写只提示
 *  (只按「路径:行号」会把那个位置上另一条任务的日期改掉 —— 10-17 Codex 评审 P1)。 */
export function rescheduleNoteTask(mark: MdMark, before: string, after: string, title: string): void {
  if (before === after || !after) return // 正文任务清掉 `@` 就不再是待办(列表里会消失),不收「未排期」
  if (!patchMark(mark, { due: after })) return
  offerUndo(translate('calevtact.moved', { title: title || translate('calevtact.untitled') }), () => {
    const hit = resolveMark(useMdMarkStore.getState().marks, mark)
    if (hit && effectiveDue(hit) === after) patchMark(hit, { due: before })
    else notifyApp({ event: 'system.generic', level: 'warning', text: translate('mdmark.patchFailed', { name: mark.text }) })
  })
}
