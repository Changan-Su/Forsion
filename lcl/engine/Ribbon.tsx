/** Ribbon 竖条(≈ Obsidian ribbon):固定在 Dockview 之外的最左侧,订阅 ribbonRegistry。
 *  - 折叠(默认)= 纯图标;展开 = 图标 + 名称(宽条)。切换钮常驻顶部。
 *  - 顶部功能图标可拖动改序(持久化);底部为设置 + 账号卡常驻(side:'bottom',不参与排序)。 */
import { useState } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useRibbonStore, orderTopItems } from './ribbonRegistry'
import { label } from './types'
import type { RibbonItem } from './types'

function RibbonItemView({ item, expanded }: { item: RibbonItem; expanded: boolean }) {
  if (item.component) {
    const C = item.component
    return <C expanded={expanded} />
  }
  const Icon = item.icon
  const name = item.tooltip ? label(item.tooltip) : ''
  return (
    <button className="rb-btn" title={expanded ? undefined : name} onClick={item.onClick}>
      {Icon && <Icon size={18} />}
      {expanded && <span className="rb-label">{name}</span>}
    </button>
  )
}

export function Ribbon() {
  const items = useRibbonStore((s) => s.items)
  const expanded = useRibbonStore((s) => s.expanded)
  const order = useRibbonStore((s) => s.order)
  const toggleExpanded = useRibbonStore((s) => s.toggleExpanded)
  const setOrder = useRibbonStore((s) => s.setOrder)
  const top = orderTopItems(items, order)
  const bottom = items.filter((i) => i.side === 'bottom')

  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const drop = (targetId: string): void => {
    const from = dragId
    setDragId(null); setOverId(null)
    if (!from || from === targetId) return
    const ids = top.map((i) => i.id)
    const fi = ids.indexOf(from); let ti = ids.indexOf(targetId)
    if (fi < 0 || ti < 0) return
    ids.splice(fi, 1)
    if (fi < ti) ti--
    ids.splice(ti, 0, from)
    setOrder(ids)
  }

  const zh = document.documentElement.lang.startsWith('zh')
  return (
    <div className={`rb${expanded ? ' rb-expanded' : ''}`}>
      <div className="rb-group rb-top">
        <button className="rb-btn rb-toggle" title={expanded ? undefined : (zh ? '展开' : 'Expand')} onClick={toggleExpanded}>
          {expanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          {expanded && <span className="rb-label">{zh ? '折叠侧栏' : 'Collapse'}</span>}
        </button>
        {top.map((i) => (
          <div
            key={i.id}
            className={`rb-slot${dragId === i.id ? ' dragging' : ''}${overId === i.id && dragId !== i.id ? ' drag-over' : ''}`}
            draggable
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(i.id) }}
            onDragOver={(e) => { if (dragId && dragId !== i.id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overId !== i.id) setOverId(i.id) } }}
            onDragLeave={() => { if (overId === i.id) setOverId(null) }}
            onDrop={(e) => { e.preventDefault(); drop(i.id) }}
            onDragEnd={() => { setDragId(null); setOverId(null) }}
          >
            <RibbonItemView item={i} expanded={expanded} />
          </div>
        ))}
      </div>
      <div className="rb-group rb-bottom">
        {bottom.map((i) => (
          <RibbonItemView key={i.id} item={i} expanded={expanded} />
        ))}
      </div>
    </div>
  )
}
