/** 盖章列的纯逻辑(零 React / 零 store,主进程与渲染端都能 import):
 *  - `localMinuteStamp`:本地 'YYYY-MM-DDTHH:mm'(与 calendarDate 单侧串 / propertyTypes.builtins.createdStamp /
 *    引擎 automationDbAction.localMinute 同款);
 *  - `stampUpdatedRows`:`updated`(修改时间)列的盖章 —— 只对**内容真变了**的行(prev 与 next 里都在、cells 变了)
 *    盖当前时刻;新增行(建行初值由 propertyTypes.initialValue 盖)、恢复的行、只动列定义/视图的 mutate 一律不盖。
 *  ⚠️ 'updated' 与引擎 tangu-agent automationDbAction.ts 是**同名字符串契约**(那边 db_row_edit 同款只对真变了的行盖章)。 */
import type { DbFile, DbRow } from './schema'

export const UPDATED_TYPE = 'updated'

export const localMinuteStamp = (d: Date = new Date()): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 忽略 updated 列本身后,两行 cells 是否不同:引用相同直接判等;否则按键序无关的 JSON 比。 */
function cellsChanged(a: DbRow, b: DbRow, skip: Set<string>): boolean {
  if (a.cells === b.cells) return false
  const pick = (r: DbRow): string => {
    const keys = Object.keys(r.cells).filter((k) => !skip.has(k) && r.cells[k] != null).sort()
    return JSON.stringify(keys.map((k) => [k, r.cells[k]]))
  }
  return pick(a) !== pick(b)
}

/** 见文件头。表里没有 updated 列 → 原样返回 next(零开销、引用不变)。 */
export function stampUpdatedRows(prev: DbFile, next: DbFile, now: Date = new Date()): DbFile {
  const cols = next.columns.filter((c) => c.type === UPDATED_TYPE).map((c) => c.id)
  if (!cols.length || prev.rows === next.rows) return next
  const skip = new Set(cols)
  const before = new Map(prev.rows.map((r) => [r.id, r]))
  const stamp = localMinuteStamp(now)
  let touched = false
  const rows = next.rows.map((r) => {
    const p = before.get(r.id)
    if (!p || !cellsChanged(p, r, skip)) return r
    touched = true
    const cells = { ...r.cells }
    for (const id of cols) cells[id] = stamp
    return { ...r, cells }
  })
  return touched ? { ...next, rows } : next
}
