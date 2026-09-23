import type { MouseEvent, ReactNode } from 'react'
import { FileText, Plus } from 'lucide-react'
import type { DbColumn, DbRow } from '@amadeus-shared/db/schema'
import { registerMessages, useI18n } from '../../../i18n'
import './listBody.css'

registerMessages({
  'dblist.new': { zh: '新建记录', en: 'New record' },
  'dblist.empty': { zh: '没有符合条件的记录', en: 'No matching records' },
})

/** A compact list of the same records, with the current view's visible properties. */
export function ListBody({ rows, columns, titleOf, onOpen, onAdd, renderProperty, rowAttrs }: {
  rows: DbRow[]
  columns: DbColumn[]
  titleOf: (row: DbRow) => string
  onOpen: (event: MouseEvent, rowId: string) => void
  onAdd?: () => void
  renderProperty: (row: DbRow, col: DbColumn) => ReactNode
  rowAttrs?: (row: DbRow) => Record<string, string>
}) {
  const { t } = useI18n()
  return <div className="amx-db-list" role="list">
    {!rows.length && <div className="amx-db-list-empty">{t('dblist.empty')}</div>}
    {rows.map((row) => <div key={row.id} role="listitem">
      <button {...rowAttrs?.(row)} type="button" className="amx-db-list-row" onClick={(event) => onOpen(event, row.id)}>
        <FileText size={16} className="amx-db-list-icon" />
        <span className="amx-db-list-title">{titleOf(row)}</span>
        <span className="amx-db-list-properties">{columns.slice(1).map((col) =>
          <span className="amx-db-list-property" key={col.id} title={col.name}>{renderProperty(row, col)}</span>)}</span>
      </button>
    </div>)}
    {onAdd && <button type="button" className="amx-db-list-new" onClick={onAdd}><Plus size={15} />{t('dblist.new')}</button>}
  </div>
}
