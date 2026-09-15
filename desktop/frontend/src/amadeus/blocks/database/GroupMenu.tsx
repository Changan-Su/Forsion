import { useState } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical } from 'lucide-react'
import type { DbColumn, DbView } from '@amadeus-shared/db/schema'
import type { RowGroup } from '@amadeus-shared/db/groupRows'
import { registerMessages, useI18n } from '../../../i18n'
import './grouping.css'

registerMessages({
  'dbgroup.title': { zh: '分组', en: 'Group' },
  'dbgroup.by': { zh: '按属性分组', en: 'Group by' },
  'dbgroup.none': { zh: '不分组', en: 'No grouping' },
  'dbgroup.sort': { zh: '组排序', en: 'Group order' },
  'dbgroup.manual': { zh: '手动排序', en: 'Manual' },
  'dbgroup.asc': { zh: '升序', en: 'Ascending' },
  'dbgroup.desc': { zh: '降序', en: 'Descending' },
  'dbgroup.hideEmpty': { zh: '隐藏空组', en: 'Hide empty groups' },
  'dbgroup.collapse': { zh: '折叠全部', en: 'Collapse all' },
  'dbgroup.expand': { zh: '展开全部', en: 'Expand all' },
  'dbgroup.hide': { zh: '隐藏 {name}', en: 'Hide {name}' },
  'dbgroup.show': { zh: '显示 {name}', en: 'Show {name}' },
  'dbgroup.up': { zh: '上移 {name}', en: 'Move {name} up' },
  'dbgroup.down': { zh: '下移 {name}', en: 'Move {name} down' },
  'dbgroup.empty': { zh: '未设置', en: 'No value' },
  'dbgroup.checked': { zh: '已勾选', en: 'Checked' },
  'dbgroup.unchecked': { zh: '未勾选', en: 'Unchecked' },
})

export function GroupMenu({ columns, view, groups, labelOf, onPatch, onCollapse, blocked, dateGroup }: {
  columns: DbColumn[]; view: DbView; groups: RowGroup[]; labelOf: (group: RowGroup) => string
  onPatch: (patch: Partial<DbView>) => void; onCollapse: (collapse: boolean) => void; blocked?: boolean; dateGroup?: boolean
}) {
  const { t } = useI18n()
  const [drag, setDrag] = useState<string | null>(null)
  const move = (key: string, target: string) => {
    const keys = groups.map((g) => g.key)
    const from = keys.indexOf(key), to = keys.indexOf(target)
    if (from < 0 || to < 0 || from === to) return
    keys.splice(from, 1); keys.splice(to, 0, key)
    onPatch({ groupSort: 'manual', groupOrder: keys })
  }
  return <div className="amx-db-group-menu">
    <strong>{t('dbgroup.title')}</strong>
    <label className="amx-db-group-setting">{t('dbgroup.by')}
      <select aria-label={t('dbgroup.by')} value={view.groupBy ?? ''} disabled={blocked}
        onChange={(e) => onPatch({ groupBy: e.target.value || undefined, groupOrder: undefined, groupHidden: undefined, groupSort: undefined })}>
        <option value="">{t('dbgroup.none')}</option>
        {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
    {blocked ? <div className="amx-db-blank">{t('dbembed.groupSecBlocked')}</div> : view.groupBy && <>
      <label className="amx-db-group-setting">{t('dbgroup.sort')}
        <select aria-label={t('dbgroup.sort')} value={view.groupSort ?? (dateGroup || columns.find((c) => c.id === view.groupBy)?.type === 'number' ? 'asc' : 'manual')}
          onChange={(e) => onPatch({ groupSort: e.target.value as DbView['groupSort'] })}>
          {(['manual', 'asc', 'desc'] as const).map((v) => <option key={v} value={v}>{t(`dbgroup.${v}`)}</option>)}
        </select>
      </label>
      {dateGroup && <label className="amx-db-group-setting">{t('dbembed.groupUnitSec')}
        <select aria-label={t('dbembed.groupUnitSec')} value={view.groupUnit ?? 'day'} onChange={(e) => onPatch({ groupUnit: e.target.value as 'day' | 'month' })}>
          <option value="day">{t('dbembed.byDay')}</option><option value="month">{t('dbembed.byMonth')}</option>
        </select>
      </label>}
      <label className="amx-db-group-setting">{t('dbgroup.hideEmpty')}
        <input type="checkbox" checked={!!view.groupHideEmpty} onChange={(e) => onPatch({ groupHideEmpty: e.target.checked })} />
      </label>
      <div className="amx-db-group-bulk"><button onClick={() => onCollapse(false)}>{t('dbgroup.expand')}</button><button onClick={() => onCollapse(true)}>{t('dbgroup.collapse')}</button></div>
      <div className="amx-db-group-options">{groups.map((g, i) => {
        const name = labelOf(g), hidden = !!view.groupHidden?.includes(g.key)
        return <div key={g.key} className="amx-db-group-option" data-hidden={hidden || undefined} data-group-key={g.key}
          draggable onDragStart={(e) => { setDrag(g.key); e.dataTransfer.setData('text/plain', g.key); e.dataTransfer.effectAllowed = 'move' }}
          onDragEnd={() => setDrag(null)} onDragOver={(e) => { if (drag) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); if (drag) move(drag, g.key); setDrag(null) }}>
          <GripVertical size={12} aria-hidden /><span className="amx-db-group-option-name" title={name}>{name}</span><small>{g.rows.length}</small>
          <button disabled={i === 0} aria-label={t('dbgroup.up', { name })} onClick={() => move(g.key, groups[i - 1].key)}><ArrowUp size={12} /></button>
          <button disabled={i === groups.length - 1} aria-label={t('dbgroup.down', { name })} onClick={() => move(g.key, groups[i + 1].key)}><ArrowDown size={12} /></button>
          <button aria-label={t(hidden ? 'dbgroup.show' : 'dbgroup.hide', { name })} aria-pressed={!hidden}
            onClick={() => onPatch({ groupHidden: hidden ? view.groupHidden!.filter((k) => k !== g.key) : [...(view.groupHidden ?? []), g.key] })}>
            {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
      })}</div>
    </>}
  </div>
}
