import { Fragment, type ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import type { RowNode } from '@amadeus-shared/compiler/types'
import { Column } from './Column'
import { ColumnResizer } from './ColumnResizer'

/** A horizontal row of columns, with resizers between them and edge drop-zones
 *  on each side (drop a block on an edge to split into a new column). */
export function Row({ row, gutterLead }: { row: RowNode; gutterLead?: ReactNode }) {
  // 单列多子的「大杂烩行」不给行级边缘落点:行级配对会与整页所有块劈开(实报),块级边缘(BlockHost)接管。
  const mega = row.columns.length === 1 && row.columns[0].children.length > 1
  return (
    <div className="row">
      {!mega && <EdgeZone rowId={row.id} side="left" />}
      <div className="row-cols">
        {row.columns.map((col, i) => (
          <Fragment key={col.id}>
            {i > 0 && (
              <ColumnResizer
                rowId={row.id}
                leftColId={row.columns[i - 1].id}
                rightColId={col.id}
              />
            )}
            <Column col={col} gutterLead={i === 0 ? gutterLead : undefined} />
          </Fragment>
        ))}
      </div>
      {!mega && <EdgeZone rowId={row.id} side="right" />}
    </div>
  )
}

function EdgeZone({ rowId, side }: { rowId: string; side: 'left' | 'right' }) {
  const { setNodeRef, isOver } = useDroppable({ id: `edge:${rowId}:${side}` })
  return <div ref={setNodeRef} className="edge-zone" data-side={side} data-over={isOver || undefined} />
}
