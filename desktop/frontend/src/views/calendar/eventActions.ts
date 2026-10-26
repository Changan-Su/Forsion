import { deleteAggRow, restoreAggRow, setAggCell, getAggDb, type AggDb, type AggRow } from '../../amadeus/store/dbAggregateStore'
import { usePageStore } from '../../amadeus/store/pageStore'
import { useDbStore } from '../../amadeus/store/dbStore'
import { isStamped } from '../../amadeus/blocks/database/propertyTypes'
import { effectiveDue, patchMark, useMdMarkStore } from '../../amadeus/store/mdMarkStore'
import { resolveMark, type MdMark } from '@amadeus-shared/mdMarks'
import { notifyApp } from '../../stores/notificationStore'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'calevtact.deleted': { zh: '已删除「{title}」', en: 'Deleted “{title}”' },
  'calevtact.moved': { zh: '已改时间「{title}」', en: 'Rescheduled “{title}”' },
  'calevtact.untitled': { zh: '未命名', en: 'Untitled' },
  'calevtact.undo': { zh: '撤销', en: 'Undo' },
  'calevtact.undone': { zh: '已撤销', en: 'Undone' },
  'calevtact.conflict': { zh: '事件已发生变化，未覆盖后续编辑。', en: 'The event changed. Later edits were kept.' },
})

interface Edit { vault: string; undo: () => boolean; redo?: () => boolean }
const past: Edit[] = []
const future: Edit[] = []
export const canUndoCalendarEdit = (): boolean => past.at(-1)?.vault === vaultKey()
export const canRedoCalendarEdit = (): boolean => future.at(-1)?.vault === vaultKey()

/** ⌘Z:撤销日历里最近一次删除 / 改时间;没有可撤的返回 false。 */
export function undoLastCalendarEdit(): boolean {
  const edit = past.at(-1)
  if (!edit || edit.vault !== vaultKey()) return false
  past.pop()
  if (!edit.undo()) { conflict(); return false }
  if (edit.redo) future.push(edit)
  // 走查续七 7.13:撤销成功(⌘Z、提示上的按钮、插件 ctx.events.undo 都走这里)→ 同一条提示原地换成「已撤销」,去掉按钮,1.2 秒后淡出
  notifyApp({ level: 'info', text: translate('calevtact.undone'), dedupeKey: UNDO_KEY, action: undefined, durationMs: 1200, settle: true })
  return true
}
export function redoLastCalendarEdit(): boolean {
  const edit = future.at(-1)
  if (!edit || edit.vault !== vaultKey()) return false
  future.pop()
  if (!edit.redo?.()) { conflict(); return false }
  past.push(edit)
  return true
}
const UNDO_KEY = 'calendar-undo'
// 冲突同样换掉那条「撤销」提示(不再留一个点了也没用的按钮)
const conflict = (): void => { notifyApp({ level: 'warning', text: translate('calevtact.conflict'), dedupeKey: UNDO_KEY, action: undefined, settle: true }) }
export function calendarScope(): string { return vaultKey() }
export function currentCalendarRow(db: AggDb, id: string): AggRow | undefined {
  if (db.isNoteView) return getAggDb(db.path)?.rows.find((r) => r.rowId === id)
  if (db.readonly) {
    const mark = useMdMarkStore.getState().marks.find((m) => `${m.path}:${m.line}` === id)
    return mark ? { rowId: id, name: mark.text, cells: { name: mark.text, date: effectiveDue(mark), note: mark.title } } : undefined
  }
  const row = useDbStore.getState().entries[db.path]?.data?.rows.find((r) => r.id === id)
  return row ? { rowId: row.id, cells: row.cells, body: row.body, name: String(row.cells[db.columns[0]?.id] ?? '') } : undefined
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
// System updated stamps naturally change on undo; compare user data only.
export function sameCalendarRow(db: AggDb, a: AggRow | undefined, b: AggRow): boolean {
  const columns = useDbStore.getState().entries[db.path]?.data?.columns ?? db.columns
  return !!a && a.body === b.body && columns.filter((c) => c.type !== 'updated').every((c) => same(a.cells[c.id], b.cells[c.id]))
}

const vaultKey = (): string => { const s = usePageStore.getState(); return `${s.vaultSide}:${s.vaultRoot}` }

/** 撤销只生效一次(⌘Z 与通知条按钮共用),且只在记下它的那个库里生效:
 *  库路径是相对的,换了库再撤会把 A 库的行写进 B 库(Codex 评审 P1)。 */
export function offerCalendarUndo(text: string, run: () => boolean, redo?: () => boolean): void {
  const vault = vaultKey()
  const edit: Edit = { vault, undo: run, redo }
  past.push(edit)
  if (past.length > 20) past.shift()
  future.length = 0
  const once = (): boolean => {
    if (past.at(-1) !== edit || vaultKey() !== vault) return false
    return undoLastCalendarEdit()
  }
  notifyApp({
    text,
    level: 'info',
    dedupeKey: UNDO_KEY,
    durationMs: 8000, // U-06:带撤销钮的提示留够反应时间
    action: { label: translate('calevtact.undo'), run: () => { once() } },
  })
}

/** 删除日历/待办行；经典数据库提供通知条撤销，笔记视图保留文件删除确认。 */
export function deleteCalendarRow(db: AggDb, row: AggRow, title: string): void {
  if (db.readonly) return
  const snapshot = structuredClone(currentCalendarRow(db, row.rowId) ?? row)
  let removed = deleteAggRow(db, row.rowId) // Same-file references must follow each redo as well as the first deletion.
  if (db.isNoteView) return
  offerCalendarUndo(translate('calevtact.deleted', { title: title || translate('calevtact.untitled') }), () => {
    if (currentCalendarRow(db, row.rowId)) return false
    restoreAggRow(db, snapshot, removed)
    return true
  }, () => {
    if (!sameCalendarRow(db, currentCalendarRow(db, row.rowId), snapshot)) return false
    removed = deleteAggRow(db, row.rowId, snapshot)
    return true
  })
}

/** 拖动改时间 / 改时长:写新值,并给撤销(回到改之前的原值)。 */
export function rescheduleCalendarRow(db: AggDb, row: AggRow, colId: string, before: string, after: string, title: string): void {
  if (before === after) return
  if (isStamped(db.columns.find((c) => c.id === colId)?.type ?? '')) return
  if (db.readonly && !db.writeCell) return
  if (db.writeCell) {
    const mark = useMdMarkStore.getState().marks.find((m) => `${m.path}:${m.line}` === row.rowId)
    if (mark) rescheduleNoteTask(mark, before, after, title)
    return
  }
  if (!currentCalendarRow(db, row.rowId)) return
  setAggCell(db, row.rowId, colId, after || undefined)
  const change = (expected: string, next: string): boolean => {
    const live = currentCalendarRow(db, row.rowId)
    if (!live || !same(live.cells[colId], expected || undefined)) return false
    setAggCell(db, row.rowId, colId, next || undefined, { value: expected || undefined })
    return true
  }
  offerCalendarUndo(translate('calevtact.moved', { title: title || translate('calevtact.untitled') }), () => change(after, before), () => change(before, after))
}

/** 笔记正文任务改日期(待办视图拖到分组头):改那一行的 `@日期`,撤销 = 改回原值。
 *  撤销时笔记可能已经插 / 删过行:按「同篇同一句、且只有这一条」找回它,且它的日期还得是我们写进去的值,否则不写只提示
 *  (只按「路径:行号」会把那个位置上另一条任务的日期改掉 —— 10-17 Codex 评审 P1)。 */
export function rescheduleNoteTask(mark: MdMark, before: string, after: string, title: string): void {
  if (before === after || !after) return // 正文任务清掉 `@` 就不再是待办(列表里会消失),不收「未排期」
  if (!patchMark(mark, { due: after })) return
  offerCalendarUndo(translate('calevtact.moved', { title: title || translate('calevtact.untitled') }), () => {
    const hit = resolveMark(useMdMarkStore.getState().marks, mark)
    if (hit && effectiveDue(hit) === after) return patchMark(hit, { due: before })
    return false
  })
}
