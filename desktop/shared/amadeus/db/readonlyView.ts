// 只读表格呈现(公开分享页 web/src/shareDb.tsx 用):把 DbFile 折算成「要渲染的列 + 行」,
// 复用 viewQuery.applyFilters 与 schema.coerceForDisplay。经典表全渲染;笔记视图(source=folder,
// 行来自实时笔记)公开侧拿不到 folder 数据 → 只出列、不出行(noteView=true,壳层给「在 Forsion 查看」)。
import { applyFilters, applySorts } from './viewQuery'
import { evalRowFormulas } from './formula'
import { coerceForDisplay, sortsOf, type CellValue, type ColumnType, type DbColumn, type DbFile, type DbRow } from './schema'
import { orderColumns } from './viewCols'

const ALL_TYPES = new Set<ColumnType>(['text', 'number', 'checkbox', 'date', 'select', 'multiselect', 'url', 'page'])

/** 自定义/未知列类型一律折算成 text(与 propertyTypes.resolveBaseType 的公开侧极简版:不认插件类型)。 */
export function baseKind(type: string | undefined): ColumnType {
  return type && ALL_TYPES.has(type as ColumnType) ? (type as ColumnType) : 'text'
}

export function resolveDbTable(db: DbFile): { columns: DbColumn[]; rows: DbRow[]; noteView: boolean } {
  const view = db.views?.[0] // 首视图 = 默认呈现(激活视图不落盘,公开侧取第一个)
  const hidden = new Set(view?.hidden ?? [])
  const columns = orderColumns(db.columns, view?.order).filter((c) => !hidden.has(c.id)) // 首视图的独立列序(缺 = 全局序)
  if (db.source) return { columns, rows: [], noteView: true }
  const kindOf = (colId: string): ColumnType => baseKind(db.columns.find((c) => c.id === colId)?.type)
  // 公式列物化(lookup 要跨表数据,公开侧拿不到 → 留空)。
  const base = db.columns.some((c) => c.type === 'formula')
    ? db.rows.map((r) => ({ ...r, cells: { ...r.cells, ...evalRowFormulas(db.columns, r.cells) } }))
    : db.rows
  let rows = applyFilters(base, view?.filters, kindOf, view?.filterMode)
  const sorts = view ? sortsOf(view) : []
  if (sorts.length) {
    // 计算列(formula/lookup)排序键取物化值:数字按数值比,别让 2 排到 10 后面。
    const typeOf = (colId: string): string | undefined => db.columns.find((c) => c.id === colId)?.type
    rows = applySorts(rows, sorts, (r, colId) => {
      const raw = r.cells[colId]
      const t = typeOf(colId)
      if (t === 'formula' || t === 'lookup') return typeof raw === 'number' ? raw : Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
      const k = kindOf(colId)
      if (k === 'number') return typeof raw === 'number' ? raw : Number.NEGATIVE_INFINITY
      if (k === 'checkbox') return raw === true ? 1 : 0
      return String(coerceForDisplay(raw ?? null, 'text'))
    })
  }
  return { columns, rows, noteView: false }
}

/** 单元格只读呈现:checkbox→勾选态,select/multiselect→标签块,其余→coerceForDisplay 文本。 */
export function cellDisplay(v: CellValue | undefined, type: string): { text?: string; checked?: boolean; chips?: string[] } {
  const k = baseKind(type)
  if (k === 'checkbox') return { checked: v === true }
  if (k === 'multiselect') return { chips: Array.isArray(v) ? v : [] }
  if (k === 'select') return { chips: typeof v === 'string' && v ? [v] : [] }
  return { text: String(coerceForDisplay(v ?? null, k)) }
}
