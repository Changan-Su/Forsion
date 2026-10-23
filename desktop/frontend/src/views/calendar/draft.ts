/** 新建草稿 → 日历列的值。纯函数(无 store / DOM),CalendarView 与右栏草稿面板共用。 */
import type { CalDraft } from '../../amadeus/store/calendarNavStore'
import { atMinute, fmtStamp } from './dateUtils'

/** 单击新建的默认时长(分钟)。 */
export const DRAFT_MINUTES = 60

export function draftValue(d: CalDraft): string {
  if (d.startMin === null) return d.endDay !== d.day ? `${d.day}/${d.endDay}` : d.day
  if (d.hasEnd === false) return fmtStamp(atMinute(d.day, d.startMin), false)
  return `${fmtStamp(atMinute(d.day, d.startMin), false)}/${fmtStamp(atMinute(d.day, d.endMin), false)}`
}

/** 从按下点 a 拖到 b(都是吸附后的分钟,同一天):起止按先后排好,至少 15 分钟,不出当天。
 *  没拖(a === b)= 单击:从 a 起默认时长,碰到 24:00 就整体往前挪。 */
export function draftRange(a: number, b: number, clicked: boolean): [number, number] {
  if (clicked) {
    const start = Math.max(0, Math.min(a, 24 * 60 - DRAFT_MINUTES))
    return [start, start + DRAFT_MINUTES]
  }
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.min(24 * 60, Math.max(a, b))
  return hi - lo < 15 ? [lo, Math.min(24 * 60, lo + 15)] : [lo, hi]
}

/** 新建落进哪张表:草稿上点名的 → 左栏标星的默认 → 第一张经典多维表 → 第一张;只读的不算。
 *  主区提交与右栏草稿面板打勾共用这一份 —— 各算各的,面板上勾的和写进去的就可能不是同一张。 */
export function pickDraftDb<M extends { db: { path: string; readonly?: boolean; isNoteView?: boolean } }>(
  members: M[], dbPath: string | null, defaultPath: string | null,
): M | null {
  const w = members.filter((m) => !m.db.readonly)
  return w.find((m) => m.db.path === dbPath) ?? w.find((m) => m.db.path === defaultPath) ?? w.find((m) => !m.db.isNoteView) ?? w[0] ?? null
}

/** 待办行拖进日历的载荷类型(TodoListView 发,CalendarView 接):JSON { dbPath, rowId }。 */
export const TODO_DRAG_MIME = 'application/x-forsion-todo'
