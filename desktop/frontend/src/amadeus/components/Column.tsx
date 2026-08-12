import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { ColumnNode } from '@amadeus-shared/compiler/types'
import { usePageStore } from '../store/pageStore'
import { BlockHost } from './BlockHost'

/** A vertical, sortable stack of blocks. Width is proportional (flex-grow = fraction).
 *  gutterLead 只喂首块 —— 标题折叠箭头属于「这一行的第一个块」(见 PageView)。 */
export function Column({ col, gutterLead }: { col: ColumnNode; gutterLead?: ReactNode }) {
  const insertBlockAfter = usePageStore((s) => s.insertBlockAfter)
  const { setNodeRef, isOver } = useDroppable({ id: `col:${col.id}` })
  const ids = col.children.map((r) => r.ref)

  return (
    <div
      ref={setNodeRef}
      className="column"
      data-col={col.id}
      data-over={isOver || undefined}
      style={{ flexGrow: col.width, flexBasis: 0 }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {ids.map((id, i) => (
          <BlockHost key={id} blockId={id} gutterLead={i === 0 ? gutterLead : undefined} />
        ))}
      </SortableContext>
      <button className="col-add" onClick={() => insertBlockAfter(null, col.id)}>
        ＋ 块
      </button>
    </div>
  )
}
