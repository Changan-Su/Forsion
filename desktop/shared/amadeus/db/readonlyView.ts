// 只读表格呈现(公开分享页 web/src/shareDb.tsx 用):把 DbFile 折算成「要渲染的列 + 行」,
// 复用 viewQuery.applyFilters 与 schema.coerceForDisplay。经典表全渲染;笔记视图(source=folder,
// 行来自实时笔记)公开侧拿不到 folder 数据 → 只出列、不出行(noteView=true,壳层给「在 Forsion 查看」)。
import { applyFilters } from './viewQuery'
import { coerceForDisplay, type CellValue, type ColumnType, type DbColumn, type DbFile, type DbRow } from './schema'

const ALL_TYPES = new Set<ColumnType>(['text', 'number', 'checkbox', 'date', 'select', 'multiselect', 'url', 'page'])

/** 自定义/未知列类型一律折算成 text(与 propertyTypes.resolveBaseType 的公开侧极简版:不认插件类型)。 */
export function baseKind(type: string | undefined): ColumnType {
  return type && ALL_TYPES.has(type as ColumnType) ? (type as ColumnType) : 'text'
}

export function resolveDbTable(db: DbFile): { columns: DbColumn[]; rows: DbRow[]; noteView: boolean } {
  const view = db.views?.[0] // 首视图 = 默认呈现(激活视图不落盘,公开侧取第一个)
  const hidden = new Set(view?.hidden ?? [])
  const columns = db.columns.filter((c) => !hidden.has(c.id))
  if (db.source) return { columns, rows: [], noteView: true }
  const kindOf = (colId: string): ColumnType => baseKind(db.columns.find((c) => c.id === colId)?.type)
  let rows = applyFilters(db.rows, view?.filters, kindOf)
  const sort = view?.sort
  if (sort) {
    const k = kindOf(sort.colId)
    const dir = sort.dir === 'desc' ? -1 : 1
    rows = [...rows].sort((a, b) => cmp(a.cells[sort.colId], b.cells[sort.colId], k) * dir)
  }
  return { columns, rows, noteView: false }
}

function cmp(a: CellValue | undefined, b: CellValue | undefined, kind: ColumnType): number {
  if (kind === 'number') return (typeof a === 'number' ? a : -Infinity) - (typeof b === 'number' ? b : -Infinity)
  return String(coerceForDisplay(a ?? null, 'text')).localeCompare(String(coerceForDisplay(b ?? null, 'text')))
}

/** 单元格只读呈现:checkbox→勾选态,select/multiselect→标签块,其余→coerceForDisplay 文本。 */
export function cellDisplay(v: CellValue | undefined, type: string): { text?: string; checked?: boolean; chips?: string[] } {
  const k = baseKind(type)
  if (k === 'checkbox') return { checked: v === true }
  if (k === 'multiselect') return { chips: Array.isArray(v) ? v : [] }
  if (k === 'select') return { chips: typeof v === 'string' && v ? [v] : [] }
  return { text: String(coerceForDisplay(v ?? null, k)) }
}
