/** 表格分组按**日期列**(DbView.groupBy 指向 date / calendarDate / created 列)的纯逻辑。
 *  档位由 DbView.groupUnit 给('day' | 'month';缺 = day)。单选列的泳道分组不走这里(选项池即组序)。 */
import type { CellValue } from './schema'

export type DateGroupUnit = 'day' | 'month'

/** 读端归一:只认 day/month,别的(旧值/脏值/缺)一律 day。 */
export const dateGroupUnitOf = (u: string | undefined): DateGroupUnit => (u === 'month' ? 'month' : 'day')

/** 落盘串 → 分组键:day 取前 10 位 `YYYY-MM-DD`,month 取前 7 位 `YYYY-MM`;取不到 = `''`(未设置)。
 *
 *  ⚠️ **不做任何时区换算,也绝不经 `new Date`**:三种日期列的落盘串开头都已经是**本地日历日** ——
 *  date = `YYYY-MM-DD`、calendarDate = `start[/end]`(每侧 `YYYY-MM-DD[THH:mm]`)、created = `YYYY-MM-DDTHH:mm`。
 *  丢进 Date 会把 `YYYY-MM-DD` 当 UTC 午夜再折回本地,东八区之外整片错一天(calDate.ts 的同一条纪律)。
 *  区间值(`a/b`)按**起始侧**归组:一条跨天任务只属于它开始的那一天,不复制成多条。 */
export function dateGroupKey(v: CellValue | undefined, unit: DateGroupUnit): string {
  if (typeof v !== 'string') return ''
  const head = v.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return ''
  return unit === 'month' ? head.slice(0, 7) : head
}

/** 按日期列分组:键**升序**;空键(未设置)恒排最后,且只有真有空值行时才出现(不凭空造空组)。
 *  组内保持输入行序(= 视图筛选/排序后的序)。 */
export function groupRowsByDate<R extends { cells: Record<string, CellValue> }>(
  rows: R[],
  colId: string,
  unit: DateGroupUnit,
): Array<{ key: string; rows: R[] }> {
  const by = new Map<string, R[]>()
  for (const r of rows) {
    const k = dateGroupKey(r.cells[colId], unit)
    const a = by.get(k)
    if (a) a.push(r)
    else by.set(k, [r])
  }
  // 键是定长零填充串,字典序 = 时间序(day 与 month 各自定长,不会混排)
  const keys = [...by.keys()].filter((k) => k !== '').sort()
  if (by.has('')) keys.push('')
  return keys.map((key) => ({ key, rows: by.get(key) as R[] }))
}
