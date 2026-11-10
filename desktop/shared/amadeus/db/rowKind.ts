/** 「日程」和「待办」按怎么建的分(2026-11-09 日历来源方案 D1),不按有没有起止时间分。
 *  日程在行上带保留单元格键 `cells._kind = 'event'`,不加列;老版本读到会忽略,按行合并 / 复制行原样带着它。
 *  ⚠️带标记的行**只有在日期列里有画得出来的日期时**才算日程;没日期的带标记行照旧算待办(日历不画它,待办再滤掉它就哪都看不到了)。
 *  日历插件(rowKind.isEventRow)和引擎是同一条规则;宿主自己算待办的界面(仪表盘待办卡、内置待办 / 日历视图)都走这一个函数。 */
import { parseCalDate } from './calDate'

export const ROW_KIND_KEY = '_kind'
export const ROW_KIND_EVENT = 'event'

type KindRow = { cells: Record<string, unknown> } | null | undefined

/** 这一行算日程:标了 `_kind: 'event'`,并且这张表在日历里映射的日期列(`dateCol`)里有能解析的日期。 */
export function isEventRow(row: KindRow, dateCol: string | null | undefined): boolean {
  if (row?.cells?.[ROW_KIND_KEY] !== ROW_KIND_EVENT || !dateCol) return false
  const raw = row.cells[dateCol]
  return typeof raw === 'string' && !!parseCalDate(raw)
}
