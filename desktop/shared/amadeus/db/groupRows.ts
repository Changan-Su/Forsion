/** Property-based table groups. View settings never mutate the underlying rows. */
import type { CellValue, DbColumn, DbRow, DbView } from './schema'
import { dateGroupKey, dateGroupUnitOf } from './groupDate'

export const GROUP_TYPES = new Set(['text', 'page', 'url', 'select', 'multiselect', 'checkbox', 'number', 'date'])
export interface RowGroup { key: string; value: CellValue; rows: DbRow[] }
export const groupValueKey = (value: CellValue): string => value === null || value === '' ? 'empty:' : `value:${JSON.stringify(value)}`

/** `kind` is resolved by the property registry at the rendering boundary. */
export function rowGroupValues(value: CellValue | undefined, kind: string, unit?: string): CellValue[] {
  if (kind === 'date') return [dateGroupKey(value, dateGroupUnitOf(unit)) || null]
  if (kind === 'checkbox') return [value === true]
  if (kind === 'multiselect') {
    const values = Array.isArray(value) ? [...new Set(value.filter(Boolean))].map(String) : []
    return values.length ? values : [null]
  }
  if (value == null || value === '') return [null]
  if (kind === 'number') return [typeof value === 'number' && Number.isFinite(value) ? value : null]
  return [String(value)]
}

export function groupRows(rows: DbRow[], column: DbColumn, kind: string, view: DbView, sourceRows: DbRow[] = rows): RowGroup[] {
  const by = new Map<string, RowGroup>()
  const ensure = (value: CellValue) => {
    const key = groupValueKey(value)
    if (!by.has(key)) by.set(key, { key, value, rows: [] })
    return by.get(key)!
  }
  if (kind === 'select' || kind === 'multiselect') (column.options ?? []).forEach(ensure)
  if (kind === 'checkbox') { ensure(false); ensure(true) }
  sourceRows.forEach((r) => rowGroupValues(r.cells[column.id], kind, view.groupUnit).forEach(ensure))
  rows.forEach((r) => rowGroupValues(r.cells[column.id], kind, view.groupUnit).forEach((v) => ensure(v).rows.push(r)))
  // Empty is a real destination, also useful for adding an unset row in editable tables.
  if (kind !== 'checkbox') ensure(null)
  const groups = [...by.values()]
  const order = new Map((view.groupOrder ?? []).map((key, index) => [key, index]))
  const sort = view.groupSort ?? (kind === 'date' || kind === 'number' ? 'asc' : 'manual')
  groups.sort((a, b) => {
    if (sort === 'manual') {
      const ai = order.get(a.key) ?? Number.MAX_SAFE_INTEGER, bi = order.get(b.key) ?? Number.MAX_SAFE_INTEGER
      if (ai !== bi) return ai - bi
    }
    if (a.value === null) return b.value === null ? 0 : 1
    if (b.value === null) return -1
    if (sort === 'manual') return 0 // property option order, then first appearance
    const cmp = typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value
      : String(column.optionLabels?.[String(a.value)] ?? a.value).localeCompare(String(column.optionLabels?.[String(b.value)] ?? b.value), undefined, { numeric: true })
    return sort === 'desc' ? -cmp : cmp
  })
  return groups
}

export function visibleGroups(groups: RowGroup[], view: DbView): RowGroup[] {
  const hidden = new Set(view.groupHidden)
  return groups.filter((g) => !hidden.has(g.key) && (!view.groupHideEmpty || g.rows.length > 0))
}
